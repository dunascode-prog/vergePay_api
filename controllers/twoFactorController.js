import z from "zod";
import { pool } from "../db/connectDB.js";
import { withTransaction } from "../db/withTransaction.js";
import { writeAudit } from "../utils/audit.js";
import {
  BadRequestError,
  ConflictError,
  InvalidTwoFactorCodeError,
  NotFoundError,
  ValidationError,
} from "../utils/errorStr.js";
import { open, seal } from "../utils/secretBox.js";
import { endSession, issueSession } from "../utils/session.js";
import { generateTotpSecret, totpUri, verifyTotp } from "../utils/totp.js";
import { validationDetails } from "../utils/validation.js";

// TOTP two-factor authentication (API doc 2.4):
//
//   POST   /v1/auth/2fa/enable   new secret + otpauth:// URI (for a QR code);
//                                nothing changes until a code is verified
//   POST   /v1/auth/2fa/verify   finishes setup, answers the sign-in
//                                challenge, or re-confirms for a
//                                "User + 2FA" action; every success issues a
//                                fresh session stamped with tfa_at
//   DELETE /v1/auth/2fa          turns it off (itself "User + 2FA")

const codeSchema = z.strictObject({
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app."),
});

function parseCode(body) {
  if (!body || Object.keys(body).length === 0) {
    throw new BadRequestError({ message: "Request body is empty." });
  }
  const validation = codeSchema.safeParse(body);
  if (!validation.success) {
    throw new ValidationError({ details: validationDetails(validation.error) });
  }
  return validation.data.code;
}

async function loadUser(db, userId, { lock = false } = {}) {
  const result = await db.query(
    `SELECT user_id, email, two_factor_enabled, two_factor_secret_enc,
            two_factor_pending_secret_enc, two_factor_last_step
     FROM users WHERE user_id = $1 ${lock ? "FOR UPDATE" : ""}`,
    [userId],
  );
  if (result.rowCount === 0) throw new NotFoundError({ message: "User not found." });
  return result.rows[0];
}

// POST /v1/auth/2fa/enable
export async function enableTwoFactor(req, res) {
  const user = await loadUser(pool, req.user.sub);
  if (user.two_factor_enabled) {
    throw new ConflictError({ message: "Two-factor authentication is already on." });
  }

  // Starting again replaces any secret that was never confirmed.
  const secret = generateTotpSecret();
  await pool.query(
    `UPDATE users SET two_factor_pending_secret_enc = $2 WHERE user_id = $1`,
    [user.user_id, seal(secret)],
  );

  return res.status(200).json({
    secret,
    otpauth_uri: totpUri(secret, user.email),
    message: "Scan the URI as a QR code (or type the secret) into your authenticator app, then confirm with POST /v1/auth/2fa/verify.",
  });
}

// POST /v1/auth/2fa/verify
export async function verifyTwoFactor(req, res) {
  const code = parseCode(req.body);

  const outcome = await withTransaction(async (client) => {
    // The row lock makes check-and-record of the used step atomic, so the
    // same code can't win twice in a race.
    const user = await loadUser(client, req.user.sub, { lock: true });

    const finishingSetup = !user.two_factor_enabled;
    const sealed = finishingSetup ? user.two_factor_pending_secret_enc : user.two_factor_secret_enc;
    if (!sealed) {
      throw new ConflictError({
        message: "Two-factor authentication isn't set up. Start with POST /v1/auth/2fa/enable.",
      });
    }

    const step = verifyTotp(
      open(sealed),
      code,
      finishingSetup ? null : user.two_factor_last_step,
    );
    if (step === null) throw new InvalidTwoFactorCodeError();

    if (finishingSetup) {
      await client.query(
        `UPDATE users
         SET two_factor_enabled = TRUE,
             two_factor_secret_enc = two_factor_pending_secret_enc,
             two_factor_pending_secret_enc = NULL,
             two_factor_last_step = $2
         WHERE user_id = $1`,
        [user.user_id, step],
      );
      await writeAudit(client, {
        actorId: user.user_id,
        entityType: "user",
        entityId: user.user_id,
        action: "update",
        before: { two_factor_enabled: false },
        after: { two_factor_enabled: true },
      });
    } else {
      await client.query(`UPDATE users SET two_factor_last_step = $2 WHERE user_id = $1`, [
        user.user_id,
        step,
      ]);
    }
    return { user, finishingSetup };
  });

  // A new session replaces the old one (whose refresh token is revoked):
  // full scope, stamped with the time of this confirmation.
  const verifiedAt = Math.floor(Date.now() / 1000);
  await endSession(req, res);
  await issueSession(res, outcome.user, { twoFactorAt: verifiedAt });

  return res.status(200).json({
    two_factor_enabled: true,
    setup_completed: outcome.finishingSetup,
    two_factor_verified_at: new Date(verifiedAt * 1000).toISOString(),
  });
}

// DELETE /v1/auth/2fa  (behind requireRecentTwoFactor)
export async function disableTwoFactor(req, res) {
  const user = await withTransaction(async (client) => {
    const user = await loadUser(client, req.user.sub, { lock: true });
    if (!user.two_factor_enabled) {
      throw new ConflictError({ message: "Two-factor authentication is already off." });
    }
    await client.query(
      `UPDATE users
       SET two_factor_enabled = FALSE,
           two_factor_secret_enc = NULL,
           two_factor_pending_secret_enc = NULL,
           two_factor_last_step = NULL
       WHERE user_id = $1`,
      [user.user_id],
    );
    await writeAudit(client, {
      actorId: user.user_id,
      entityType: "user",
      entityId: user.user_id,
      action: "update",
      before: { two_factor_enabled: true },
      after: { two_factor_enabled: false },
    });
    return user;
  });

  // Drop the tfa_at stamp so nothing can ride on the old confirmation.
  await endSession(req, res);
  await issueSession(res, user);
  return res.status(200).json({ two_factor_enabled: false });
}
