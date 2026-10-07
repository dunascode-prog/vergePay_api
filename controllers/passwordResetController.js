import bcrypt from "bcrypt";
import crypto from "crypto";
import z from "zod";
import { pool } from "../db/connectDB.js";
import { withTransaction } from "../db/withTransaction.js";
import logger from "../logger.js";
import { passwordResetEmail } from "../services/accountEmails.js";
import { queueEmail } from "../services/email.js";
import { writeAudit } from "../utils/audit.js";
import { BadRequestError, ValidationError } from "../utils/errorStr.js";
import { BCRYPT_ROUNDS, passwordSchema } from "../utils/passwordRules.js";
import { validationDetails } from "../utils/validation.js";

// Forgot password (db/migrations.db/password_resets.sql):
//
//   POST /v1/auth/password/forgot  { email }
//     Always the same answer, whether or not the email has an account, so it
//     can't be used to find out who's a customer. If it has one, a 6-digit
//     code is emailed: valid 15 minutes, at most one every 60 seconds.
//   POST /v1/auth/password/reset   { email, code, password, confirmPassword }
//     5 tries per code. On success the password changes, the code is used
//     up, and every session is ended (all devices are signed out).

const CODE_MINUTES = 15;
const CODE_TRIES = 5;
const RESEND_AFTER_SECONDS = 60;
const SENT = { message: "If an account uses that email, we've sent it a code. It expires in 15 minutes." };

const email = z.string().trim().toLowerCase().email("Enter a valid email address.");
const forgotSchema = z.strictObject({ email });
const resetSchema = z
  .strictObject({
    email,
    code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from the email."),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((b) => b.password === b.confirmPassword, { message: "Passwords do not match.", path: ["confirmPassword"] });

function parse(schema, body) {
  if (!body || Object.keys(body).length === 0) throw new BadRequestError({ message: "Request body is empty." });
  const validation = schema.safeParse(body);
  if (!validation.success) throw new ValidationError({ details: validationDetails(validation.error) });
  return validation.data;
}

// Bound to the user, so the same code for two people hashes differently.
const hashCode = (userId, code) => crypto.createHash("sha256").update(`${userId}:${code}`).digest("hex");

function sameHash(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// POST /v1/auth/password/forgot
export async function forgotPassword(req, res) {
  const body = parse(forgotSchema, req.body);
  const found = await pool.query(`SELECT user_id, email FROM users WHERE lower(email) = $1`, [body.email]);
  const user = found.rows[0];

  if (user) {
    try {
      await withTransaction(async (client) => {
        // one at a time per person, and not more often than once a minute
        await client.query(`SELECT 1 FROM users WHERE user_id = $1 FOR UPDATE`, [user.user_id]);
        const recent = await client.query(
          `SELECT 1 FROM password_reset_codes
           WHERE user_id = $1 AND created_at > NOW() - make_interval(secs => $2)`,
          [user.user_id, RESEND_AFTER_SECONDS],
        );
        if (recent.rowCount > 0) return;

        const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
        // a new code replaces any earlier one
        await client.query(`DELETE FROM password_reset_codes WHERE user_id = $1 AND used_at IS NULL`, [user.user_id]);
        await client.query(
          `INSERT INTO password_reset_codes (user_id, code_hash, expires_at)
           VALUES ($1, $2, NOW() + make_interval(mins => $3))`,
          [user.user_id, hashCode(user.user_id, code), CODE_MINUTES],
        );
        const message = passwordResetEmail({ code, minutes: CODE_MINUTES });
        await queueEmail(client, { userId: user.user_id, kind: "password_reset", to: user.email, ...message });
      });
    } catch (err) {
      // the answer never says whether the account exists, even when sending fails
      logger.error({ message: "password reset code not sent", error: err.message });
    }
  }
  return res.status(202).json(SENT);
}

// POST /v1/auth/password/reset
export async function resetPassword(req, res) {
  const body = parse(resetSchema, req.body);
  const badCode = (message) => new ValidationError({ message, details: { code: [message] } });

  const outcome = await withTransaction(async (client) => {
    const user = await client.query(`SELECT user_id FROM users WHERE lower(email) = $1`, [body.email]);
    const userId = user.rows[0]?.user_id;
    // the live code, locked so two tries at once are counted one after the other
    const found = userId
      ? await client.query(
          `SELECT user_id, reset_id, code_hash, attempts, expires_at
           FROM password_reset_codes WHERE user_id = $1 AND used_at IS NULL
           FOR UPDATE`,
          [userId],
        )
      : { rows: [] };
    const row = found.rows[0];
    // no account, no code, an expired code or no tries left all read the same
    if (!row?.reset_id || new Date(row.expires_at) < new Date() || row.attempts >= CODE_TRIES) {
      return { error: "That code has expired or isn't valid. Ask for a new one." };
    }
    if (!sameHash(row.code_hash, hashCode(row.user_id, body.code))) {
      const attempts = row.attempts + 1;
      await client.query(`UPDATE password_reset_codes SET attempts = $2 WHERE reset_id = $1`, [row.reset_id, attempts]);
      const left = CODE_TRIES - attempts;
      return {
        error: left > 0
          ? `That code isn't right. You have ${left} ${left === 1 ? "try" : "tries"} left.`
          : "That code isn't right, and it can't be used again. Ask for a new one.",
      };
    }

    const hash = await bcrypt.hash(body.password, BCRYPT_ROUNDS);
    await client.query(`UPDATE users SET password_hash = $2, password_changed_at = NOW() WHERE user_id = $1`, [row.user_id, hash]);
    await client.query(`UPDATE password_reset_codes SET used_at = NOW() WHERE reset_id = $1`, [row.reset_id]);
    // sign out every device
    const ended = await client.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [row.user_id]);
    await writeAudit(client, {
      actorId: row.user_id,
      entityType: "user",
      entityId: row.user_id,
      action: "update",
      after: { password: "reset", sessions_ended: ended.rowCount },
    });
    return { ok: true };
  });

  // the failed try is saved even though the request fails
  if (outcome.error) throw badCode(outcome.error);
  return res.status(200).json({ message: "Your password has been changed and you've been signed out everywhere. Sign in with your new password." });
}
