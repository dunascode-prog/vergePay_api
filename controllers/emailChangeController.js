import bcrypt from "bcrypt";
import crypto from "crypto";
import z from "zod";
import { withTransaction } from "../db/withTransaction.js";
import { emailChangeEmail, emailChangedNotice } from "../services/accountEmails.js";
import { queueEmail } from "../services/email.js";
import { writeAudit } from "../utils/audit.js";
import { TWO_FACTOR_FRESH_SECONDS } from "../utils/jwt.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  TwoFactorRequiredError,
  ValidationError,
} from "../utils/errorStr.js";
import { validationDetails } from "../utils/validation.js";
import { PROFILE_COLUMNS } from "./userController.js";
import { withPhotoUrl } from "../services/profilePhotos.js";

// Changing the email address (db/migrations.db/email_changes.sql):
//
//   POST /v1/users/me/email          { new_email, password }
//     The current password, plus a 2FA code confirmed in the last 5 minutes
//     if 2FA is on. Sends a 6-digit code to the NEW address (15 minutes, at
//     most one a minute). The email doesn't change yet.
//   POST /v1/users/me/email/confirm  { code }
//     5 tries. On success the email changes, a notice goes to the OLD
//     address, and the customer stays signed in.
//   DELETE /v1/users/me/email        cancels a change in progress.

const CODE_MINUTES = 15;
const CODE_TRIES = 5;
const RESEND_AFTER_SECONDS = 60;

const startSchema = z.strictObject({
  new_email: z.string().trim().toLowerCase().email("Enter a valid email address.").max(255),
  password: z.string().min(1, "Enter your password."),
});
const confirmSchema = z.strictObject({
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from the email."),
});

function parse(schema, body) {
  if (!body || Object.keys(body).length === 0) throw new BadRequestError({ message: "Request body is empty." });
  const validation = schema.safeParse(body);
  if (!validation.success) throw new ValidationError({ details: validationDetails(validation.error) });
  return validation.data;
}

// Bound to the user and the address, so a code can't confirm another one.
const hashCode = (userId, email, code) =>
  crypto.createHash("sha256").update(`${userId}:${email}:${code}`).digest("hex");

const sameHash = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

const fieldError = (field, message) => new ValidationError({ message, details: { [field]: [message] } });

const emailTaken = () =>
  new ConflictError({ message: "That email address is already used by another VergePay account.", field: "new_email" });

// POST /v1/users/me/email
export async function startEmailChange(req, res) {
  const body = parse(startSchema, req.body);

  const outcome = await withTransaction(async (client) => {
    const found = await client.query(
      `SELECT user_id, email, password_hash, two_factor_enabled FROM users WHERE user_id = $1 FOR UPDATE`,
      [req.user.sub],
    );
    const user = found.rows[0];
    if (!user) throw new NotFoundError({ message: "User not found." });

    // 2FA first, so a wrong password isn't learned before the code is given
    const tfaAt = req.user.tfa_at;
    if (user.two_factor_enabled && (!tfaAt || Date.now() / 1000 - tfaAt > TWO_FACTOR_FRESH_SECONDS)) {
      throw new TwoFactorRequiredError({
        message: "Changing your email needs a two-factor code. Verify one with POST /v1/auth/2fa/verify, then retry.",
      });
    }
    if (!(await bcrypt.compare(body.password, user.password_hash))) {
      return { error: fieldError("password", "That password isn't right.") };
    }
    if (body.new_email === user.email.toLowerCase()) {
      return { error: fieldError("new_email", "That's already your email address.") };
    }
    const taken = await client.query(`SELECT 1 FROM users WHERE lower(email) = $1`, [body.new_email]);
    if (taken.rowCount > 0) return { error: emailTaken() };

    const live = await client.query(
      `SELECT new_email, created_at > NOW() - make_interval(secs => $2) AS recent
       FROM email_change_codes WHERE user_id = $1 AND used_at IS NULL`,
      [user.user_id, RESEND_AFTER_SECONDS],
    );
    if (live.rows[0]?.recent) {
      return {
        error: new ConflictError({ message: "We've just sent a code. Wait a minute before asking for another." }),
      };
    }

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    await client.query(`DELETE FROM email_change_codes WHERE user_id = $1 AND used_at IS NULL`, [user.user_id]);
    const saved = await client.query(
      `INSERT INTO email_change_codes (user_id, new_email, code_hash, expires_at)
       VALUES ($1, $2, $3, NOW() + make_interval(mins => $4))
       RETURNING new_email, expires_at`,
      [user.user_id, body.new_email, hashCode(user.user_id, body.new_email, code), CODE_MINUTES],
    );
    const message = emailChangeEmail({ code, minutes: CODE_MINUTES });
    await queueEmail(client, { userId: user.user_id, kind: "email_change", to: body.new_email, ...message });
    return { pending: saved.rows[0] };
  });

  // a wrong password is answered after the transaction (nothing to keep)
  if (outcome.error) throw outcome.error;
  return res.status(202).json({
    pending_email: outcome.pending.new_email,
    expires_at: outcome.pending.expires_at,
    message: `We've sent a 6-digit code to ${outcome.pending.new_email}. It expires in ${CODE_MINUTES} minutes.`,
  });
}

// POST /v1/users/me/email/confirm
export async function confirmEmailChange(req, res) {
  const body = parse(confirmSchema, req.body);

  const outcome = await withTransaction(async (client) => {
    const found = await client.query(
      `SELECT change_id, user_id, new_email, code_hash, attempts, expires_at
       FROM email_change_codes WHERE user_id = $1 AND used_at IS NULL
       FOR UPDATE`,
      [req.user.sub],
    );
    const row = found.rows[0];
    if (!row || new Date(row.expires_at) < new Date() || row.attempts >= CODE_TRIES) {
      return { error: fieldError("code", "That code has expired or isn't valid. Ask for a new one.") };
    }
    if (!sameHash(row.code_hash, hashCode(row.user_id, row.new_email, body.code))) {
      const attempts = row.attempts + 1;
      await client.query(`UPDATE email_change_codes SET attempts = $2 WHERE change_id = $1`, [row.change_id, attempts]);
      const left = CODE_TRIES - attempts;
      return {
        error: fieldError(
          "code",
          left > 0
            ? `That code isn't right. You have ${left} ${left === 1 ? "try" : "tries"} left.`
            : "That code isn't right, and it can't be used again. Ask for a new one.",
        ),
      };
    }

    const before = await client.query(`SELECT email FROM users WHERE user_id = $1 FOR UPDATE`, [row.user_id]);
    const oldEmail = before.rows[0].email;
    // someone may have signed up with the address since the code was sent
    const taken = await client.query(`SELECT 1 FROM users WHERE lower(email) = $1 AND user_id <> $2`, [row.new_email, row.user_id]);
    if (taken.rowCount > 0) return { error: emailTaken() };

    // used first, so the profile read back has no change in progress
    await client.query(`UPDATE email_change_codes SET used_at = NOW() WHERE change_id = $1`, [row.change_id]);
    const updated = await client.query(
      `UPDATE users SET email = $2 WHERE user_id = $1 RETURNING ${PROFILE_COLUMNS}`,
      [row.user_id, row.new_email],
    );
    await writeAudit(client, {
      actorId: row.user_id,
      entityType: "user",
      entityId: row.user_id,
      action: "update",
      before: { email: oldEmail },
      after: { email: row.new_email },
    });
    await queueEmail(client, {
      userId: row.user_id,
      kind: "email_changed",
      to: oldEmail,
      ...emailChangedNotice({ newEmail: row.new_email }),
    });
    return { profile: updated.rows[0] };
  }).catch((err) => {
    // two accounts claiming the address at the same instant: the unique index decides
    if (err.code === "23505") return { error: emailTaken() };
    throw err;
  });

  // the failed try is saved even though the request fails
  if (outcome.error) throw outcome.error;
  return res.status(200).json(await withPhotoUrl(outcome.profile));
}

// DELETE /v1/users/me/email
export async function cancelEmailChange(req, res) {
  const result = await withTransaction((client) =>
    client.query(`DELETE FROM email_change_codes WHERE user_id = $1 AND used_at IS NULL`, [req.user.sub]),
  );
  return res.status(200).json({ cancelled: result.rowCount > 0 });
}
