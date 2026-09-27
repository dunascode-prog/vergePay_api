// Development-only helpers. These routes are only mounted when NODE_ENV is
// not "production" (see routes/index.js): until card payments and real KYC
// exist there is no other way to get money into a test account or to pass
// the KYC check that transfers require.
import z from "zod";
import { pool } from "../db/connectDB.js";
import { postOnce, postTransaction, publicTransaction } from "../services/ledger.js";
import { BadRequestError, NotFoundError, ValidationError } from "../utils/errorStr.js";
import { isUuid, validationDetails } from "../utils/validation.js";

// ₦10,000,000 (in kobo) per top-up keeps test balances in a sane range.
const MAX_TOP_UP_MINOR = 1_000_000_000;

const fundSchema = z.strictObject({
  amount_minor: z.number().int().positive().max(MAX_TOP_UP_MINOR),
});

// POST /v1/dev/kyc/verify: marks the caller as KYC-verified.
export async function verifyOwnKyc(req, res) {
  const result = await pool.query(
    `UPDATE users SET kyc_status = 'verified' WHERE user_id = $1 RETURNING user_id, kyc_status`,
    [req.user.sub],
  );
  if (result.rowCount === 0) throw new NotFoundError({ message: "User not found." });
  return res.status(200).json(result.rows[0]);
}

// POST /v1/dev/accounts/:accountId/fund: tops up one of the caller's
// accounts from the platform's external funding account. It posts through
// the normal ledger routine, so it produces a real transaction and a
// balanced debit/credit pair.
export async function fundOwnAccount(req, res) {
  if (!req.body || Object.keys(req.body).length === 0) {
    throw new BadRequestError({ message: "Request body is empty." });
  }
  const validation = fundSchema.safeParse(req.body);
  if (!validation.success) {
    throw new ValidationError({ details: validationDetails(validation.error) });
  }
  const { accountId } = req.params;
  if (!isUuid(accountId)) throw new NotFoundError({ message: "Account not found." });

  const idempotencyKey = `${req.user.sub}:${req.idempotencyKey}`;
  const isSameTopUp = (existing) =>
    existing.receiver_account_id === accountId &&
    existing.amount_minor === validation.data.amount_minor;

  const { transaction, replayed } = await postOnce(idempotencyKey, async (client) => {
    const account = await client.query(
      `SELECT account_id, currency_code FROM account
       WHERE account_id = $1 AND user_id = $2 AND NOT is_system`,
      [accountId, req.user.sub],
    );
    if (account.rowCount === 0) throw new NotFoundError({ message: "Account not found." });
    const { currency_code } = account.rows[0];

    const funding = await client.query(
      `SELECT account_id FROM account WHERE account_number = $1 AND is_system`,
      [`SYS-FUND-${currency_code}`],
    );

    return postTransaction(client, {
      transactionType: "transfer",
      senderAccountId: funding.rows[0].account_id,
      receiverAccountId: accountId,
      amountMinor: validation.data.amount_minor,
      currencyCode: currency_code,
      description: "Test top-up",
      idempotencyKey,
    });
  }, isSameTopUp);

  if (replayed) res.set("Idempotent-Replayed", "true");
  return res.status(201).json(publicTransaction(transaction));
}
