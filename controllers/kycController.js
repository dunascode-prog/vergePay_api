import z from "zod";
import { pool } from "../db/connectDB.js";
import { withTransaction } from "../db/withTransaction.js";
import { hasPendingSubmission, startVerification } from "../services/kyc.js";
import { storeSecret } from "../services/vault.js";
import { writeAudit } from "../utils/audit.js";
import { BadRequestError, ConflictError, NotFoundError, ValidationError } from "../utils/errorStr.js";
import { isUuid, validationDetails } from "../utils/validation.js";
import { isAtLeastAge, MIN_AGE_YEARS } from "./userController.js";

// KYC submissions (API doc 3.2). A customer verifies once, with their BVN,
// legal name and date of birth. The submission is accepted (202) and checked
// asynchronously; the client polls GET /v1/kyc/submissions/:id for the
// verdict. On approval the name and date of birth move onto the profile,
// where KYC then locks them.

const legalName = z
  .string()
  .trim()
  .min(1, "Required.")
  .max(100)
  .regex(/^[\p{L}][\p{L} '.-]*$/u, "Use letters only, as on your BVN record.");

const submitSchema = z.strictObject({
  document_type: z.literal("bvn", { error: "Only BVN verification is supported for now." }),
  bvn: z.string().trim().regex(/^\d{11}$/, "A BVN is 11 digits."),
  first_name: legalName,
  last_name: legalName,
  date_of_birth: z.iso
    .date("Use the format YYYY-MM-DD.")
    .refine((value) => isAtLeastAge(value, MIN_AGE_YEARS), {
      message: `You must be at least ${MIN_AGE_YEARS} years old.`,
    }),
});

// The columns a customer sees; never the vault reference to their BVN.
const SUBMISSION_COLUMNS = `
    kyc_id,
    document_type,
    verification_status,
    rejection_reason,
    submitted_at,
    reviewed_at`;

// POST /v1/kyc/submissions   (User; Idempotency-Key optional)
export async function submitKyc(req, res) {
  if (!req.body || Object.keys(req.body).length === 0) {
    throw new BadRequestError({ message: "Request body is empty." });
  }
  const validation = submitSchema.safeParse(req.body);
  if (!validation.success) {
    throw new ValidationError({ details: validationDetails(validation.error) });
  }
  const body = validation.data;
  const userId = req.user.sub;

  const submission = await withTransaction(async (client) => {
    // One submission at a time: the row lock stops two quick taps both getting through.
    const user = await client.query(`SELECT kyc_status FROM users WHERE user_id = $1 FOR UPDATE`, [userId]);
    if (user.rows[0].kyc_status === "verified") {
      throw new ConflictError({ message: "Your identity is already verified." });
    }
    if (await hasPendingSubmission(client, userId)) {
      throw new ConflictError({ message: "A verification is already in progress. It usually takes a few seconds." });
    }

    // The BVN is kept encrypted in the vault; the submission holds only the reference.
    const bvnRef = await storeSecret(client, "kyc_bvn", body.bvn);
    const inserted = await client.query(
      `INSERT INTO kyc_verification (
          user_id, document_type, document_reference, legal_first_name, legal_last_name, date_of_birth
       )
       VALUES ($1, 'bvn', $2, $3, $4, $5)
       RETURNING ${SUBMISSION_COLUMNS}`,
      [userId, bvnRef, body.first_name, body.last_name, body.date_of_birth],
    );
    await client.query(`UPDATE users SET kyc_status = 'pending', updated_at = NOW() WHERE user_id = $1`, [userId]);
    await writeAudit(client, {
      actorId: userId,
      entityType: "kyc_verification",
      entityId: inserted.rows[0].kyc_id,
      action: "create",
      after: { document_type: "bvn", verification_status: "pending" },
    });
    return inserted.rows[0];
  });

  // After the commit, so the check never runs against a submission that rolled back.
  startVerification(submission.kyc_id, body.bvn);

  return res.status(202).json({
    kyc_id: submission.kyc_id,
    verification_status: submission.verification_status,
    submitted_at: submission.submitted_at,
  });
}

// GET /v1/kyc/submissions   (User) — newest first, so a rejection's reason is easy to find
export async function listKycSubmissions(req, res) {
  const result = await pool.query(
    `SELECT ${SUBMISSION_COLUMNS} FROM kyc_verification WHERE user_id = $1 ORDER BY submitted_at DESC`,
    [req.user.sub],
  );
  return res.status(200).json({ data: result.rows });
}

// GET /v1/kyc/submissions/:kycId   (User)
export async function getKycSubmission(req, res) {
  const notFound = () => new NotFoundError({ message: "Submission not found." });
  if (!isUuid(req.params.kycId)) throw notFound();
  const result = await pool.query(
    `SELECT ${SUBMISSION_COLUMNS} FROM kyc_verification WHERE kyc_id = $1 AND user_id = $2`,
    [req.params.kycId, req.user.sub],
  );
  if (result.rowCount === 0) throw notFound();
  return res.status(200).json(result.rows[0]);
}
