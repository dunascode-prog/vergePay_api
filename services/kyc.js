import { withTransaction } from "../db/withTransaction.js";
import env from "../env.js";
import logger from "../logger.js";
import { writeAudit } from "../utils/audit.js";

// Identity verification (API doc 3.2). A submission is recorded as pending;
// the verdict comes later, from a provider, and applyKycDecision() writes it.
//
// The only provider built so far is "sandbox" (development and tests only,
// see env.kyc). It stands in for a real BVN check (Dojah, Smile ID,
// Prembly…) with fixed test numbers:
//   00000000000  → rejected: no BVN record matches
//   11111111111  → rejected: the name doesn't match the BVN record
//   anything else → approved
// A real provider would call the same applyKycDecision() from its webhook
// (POST /v1/webhooks/kyc-provider, API doc 10.3).

const SANDBOX_REJECTIONS = {
  "00000000000": "No BVN record matches these details.",
  "11111111111": "The name you entered doesn't match your BVN record.",
};

export function sandboxVerdict(bvn) {
  const reason = SANDBOX_REJECTIONS[bvn];
  return reason ? { approved: false, reason } : { approved: true };
}

/**
 * Records a verdict on a pending submission. Approval writes the legal name
 * and date of birth to the profile (KYC then locks them) and marks the user
 * verified; rejection marks them rejected so they can submit again.
 * A submission that's no longer pending is left alone.
 */
export async function applyKycDecision(kycId, { approved, reason = null, decidedBy }) {
  return withTransaction(async (client) => {
    const found = await client.query(
      `SELECT * FROM kyc_verification WHERE kyc_id = $1 FOR UPDATE`,
      [kycId],
    );
    const submission = found.rows[0];
    if (!submission || submission.verification_status !== "pending") return null;

    const decided = await client.query(
      `UPDATE kyc_verification
       SET verification_status = $2, rejection_reason = $3, verified_by = $4, reviewed_at = NOW()
       WHERE kyc_id = $1
       RETURNING *`,
      [kycId, approved ? "approved" : "rejected", approved ? null : reason, decidedBy],
    );

    const before = await client.query(
      `SELECT kyc_status, first_name, last_name, date_of_birth FROM users WHERE user_id = $1 FOR UPDATE`,
      [submission.user_id],
    );
    if (approved) {
      await client.query(
        `UPDATE users
         SET kyc_status = 'verified', first_name = $2, last_name = $3, date_of_birth = $4, updated_at = NOW()
         WHERE user_id = $1`,
        [submission.user_id, submission.legal_first_name, submission.legal_last_name, submission.date_of_birth],
      );
    } else {
      await client.query(`UPDATE users SET kyc_status = 'rejected', updated_at = NOW() WHERE user_id = $1`, [
        submission.user_id,
      ]);
    }
    await writeAudit(client, {
      actorId: null,
      entityType: "kyc_verification",
      entityId: kycId,
      action: "update",
      before: { verification_status: "pending", user: before.rows[0] },
      after: { verification_status: decided.rows[0].verification_status, decided_by: decidedBy, reason },
    });
    return decided.rows[0];
  });
}

/** Hands a new submission to the configured provider. Never throws: a failure leaves it pending. */
export function startVerification(kycId, bvn) {
  if (env.kyc.provider !== "sandbox") return; // a real provider / review decides later
  const { approved, reason } = sandboxVerdict(bvn);
  setTimeout(() => {
    applyKycDecision(kycId, { approved, reason, decidedBy: "sandbox" }).catch((err) =>
      logger.error({ message: "sandbox KYC decision failed", kycId, error: err.message }),
    );
  }, env.kyc.sandboxDelayMs).unref?.();
}

export async function hasPendingSubmission(db, userId) {
  const result = await db.query(
    `SELECT 1 FROM kyc_verification WHERE user_id = $1 AND verification_status = 'pending' LIMIT 1`,
    [userId],
  );
  return result.rowCount > 0;
}
