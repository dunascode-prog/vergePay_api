// Development-only helpers. These routes are only mounted when NODE_ENV is
// not "production" (see routes/index.js): until card payments and real KYC
// exist there is no other way to get money into a test account or to pass
// the KYC check that transfers require.
import z from "zod";
import { pool } from "../db/connectDB.js";
import { postOnce, postTransaction, publicTransaction } from "../services/ledger.js";
import { BadRequestError, NotFoundError, ValidationError } from "../utils/errorStr.js";
import { ipKeyGenerator } from "express-rate-limit";
import { moneyLimiter, signinLimiter, twoFactorLimiter } from "../utils/rateLimiters.js";
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

// ---------------------------------------------------------------------------
// Test-suite helpers (postman/). They let the Postman collection do what the
// end-to-end tests did straight in the database: reset the test users,
// simulate a lost idempotency record, back-date an invoice, and check the
// ledger's invariants.

const resetSchema = z.strictObject({
  kyc: z.boolean().optional(),
  two_factor: z.boolean().optional(),
  pending_loan_applications: z.boolean().optional(),
  name: z.boolean().optional(),
});

// POST /v1/dev/test-user/reset
// Puts the caller back to a known state; each flag is opt-in. Always clears
// the caller's rate-limit counters, so the suite can be re-run straight away.
export async function resetTestUser(req, res) {
  const validation = resetSchema.safeParse(req.body ?? {});
  if (!validation.success) {
    throw new ValidationError({ details: validationDetails(validation.error) });
  }
  const flags = validation.data;
  const userId = req.user.sub;

  if (flags.kyc) {
    await pool.query(`UPDATE users SET kyc_status = 'unverified' WHERE user_id = $1`, [userId]);
  }
  if (flags.two_factor) {
    await pool.query(
      `UPDATE users SET two_factor_enabled = FALSE, two_factor_secret_enc = NULL,
              two_factor_pending_secret_enc = NULL, two_factor_last_step = NULL
       WHERE user_id = $1`,
      [userId],
    );
  }
  if (flags.pending_loan_applications) {
    await pool.query(
      `UPDATE loan_applications
       SET status = 'rejected', decision_reason = 'Test reset', decided_at = NOW()
       WHERE user_id = $1 AND status = 'pending_review'`,
      [userId],
    );
  }
  if (flags.name) {
    await pool.query(`UPDATE users SET first_name = NULL, last_name = NULL WHERE user_id = $1`, [userId]);
  }
  await Promise.all([
    twoFactorLimiter.resetKey(userId),
    moneyLimiter.resetKey(userId),
    signinLimiter.resetKey(ipKeyGenerator(req.ip)),
  ]);

  const user = await pool.query(
    `SELECT user_id, email, kyc_status, two_factor_enabled, first_name, last_name
     FROM users WHERE user_id = $1`,
    [userId],
  );
  return res.status(200).json(user.rows[0]);
}

// DELETE /v1/dev/idempotency-keys/:key[?scope=internal]
// Forgets the stored response for one of the caller's keys, as if the
// server had crashed after committing but before saving it. A retry must
// then still be answered from what was committed (services/ledger.js postOnce).
export async function forgetIdempotencyKey(req, res) {
  const scope = req.query.scope === "internal" ? "internal" : req.user.sub;
  const result = await pool.query(`DELETE FROM idempotency_keys WHERE key = $1`, [
    `${scope}:${req.params.key}`,
  ]);
  return res.status(200).json({ deleted: result.rowCount });
}

const backdateSchema = z.strictObject({
  days: z.number().int().min(1).max(365),
});

// POST /v1/dev/invoices/:invoiceId/backdate  { days }
// Moves an invoice's due date into the past, to see it reported as overdue.
export async function backdateInvoice(req, res) {
  const validation = backdateSchema.safeParse(req.body ?? {});
  if (!validation.success) {
    throw new ValidationError({ details: validationDetails(validation.error) });
  }
  const { invoiceId } = req.params;
  if (!isUuid(invoiceId)) throw new NotFoundError({ message: "Invoice not found." });
  const result = await pool.query(
    `UPDATE invoices i SET due_date = CURRENT_DATE - $3::int
     FROM account ia, account ba
     WHERE i.invoice_id = $1
       AND ia.account_id = i.issuer_account_id AND ba.account_id = i.account_id
       AND $2 IN (ia.user_id, ba.user_id)
     RETURNING to_char(i.due_date, 'YYYY-MM-DD') AS due_date`,
    [invoiceId, req.user.sub, validation.data.days],
  );
  if (result.rowCount === 0) throw new NotFoundError({ message: "Invoice not found." });
  return res.status(200).json({ invoice_id: invoiceId, due_date: result.rows[0].due_date });
}

// GET /v1/dev/invariants
// The ledger's rules, checked across the whole database. Every count must be
// 0; anything else means money is out of place.
export async function checkInvariants(req, res) {
  const result = await pool.query(`
    SELECT
      (SELECT count(*) FROM (
         SELECT transaction_id FROM ledger_entries GROUP BY transaction_id
         HAVING sum(CASE direction WHEN 'DEBIT' THEN amount_minor ELSE -amount_minor END) <> 0
       ) x)::int AS unbalanced_transactions,
      (SELECT count(*) FROM account a
       WHERE a.balance_minor <> COALESCE((
         SELECT sum(CASE direction WHEN 'CREDIT' THEN amount_minor ELSE -amount_minor END)
         FROM ledger_entries le WHERE le.account_id = a.account_id), 0))::int AS cached_balance_drift,
      (SELECT count(*) FROM loans l
       WHERE l.loan_status IN ('active', 'repaid')
         AND l.balance_remaining_minor <> COALESCE((
           SELECT sum(installment_amount_minor) FROM loan_repayment_schedule s
           WHERE s.loan_id = l.loan_id AND NOT paid_flag), 0))::int AS loan_balance_drift,
      (SELECT count(*) FROM loan_repayment_schedule s
       JOIN transactions t ON t.transaction_id = s.paid_transaction_id
       WHERE t.amount_minor <> s.installment_amount_minor OR t.loan_id <> s.loan_id)::int AS schedule_mismatch,
      (SELECT count(*) FROM invoices i
       JOIN transactions t ON t.transaction_id = i.settling_transaction_id
       WHERE t.transaction_type <> 'invoice_payment'
          OR t.amount_minor <> i.amount_due_minor
          OR t.receiver_account_id <> i.issuer_account_id
          OR t.status::text <> CASE i.invoice_status::text WHEN 'refunded' THEN 'reversed' ELSE 'settled' END
      )::int AS invoice_mismatch,
      (SELECT count(*) FROM invoices i
       JOIN transactions t ON t.transaction_id = i.settling_transaction_id
       WHERE i.invoice_status::text = 'refunded' AND NOT EXISTS (
         SELECT 1 FROM transactions r
         WHERE r.reverses_transaction_id = t.transaction_id AND r.transaction_type = 'refund'
           AND r.amount_minor = t.amount_minor
           AND r.sender_account_id = t.receiver_account_id
           AND r.receiver_account_id = t.sender_account_id))::int AS refund_mismatch,
      (SELECT count(*) FROM transactions t
       WHERE t.status <> 'settled' AND t.transaction_type IN ('card_payment', 'bank_deposit')
         AND EXISTS (SELECT 1 FROM ledger_entries le WHERE le.transaction_id = t.transaction_id)
      )::int AS unsettled_processor_money_with_entries,
      (SELECT count(*) FROM transactions t
       WHERE t.status = 'settled' AND t.transaction_type IN ('card_payment', 'bank_deposit')
         AND (SELECT count(*) FROM ledger_entries le WHERE le.transaction_id = t.transaction_id) <> 2
      )::int AS settled_processor_money_without_entries,
      (SELECT COALESCE(sum(a.balance_minor), 0) + COALESCE((
         SELECT sum(amount_minor) FROM transactions
         WHERE status = 'settled' AND transaction_type IN ('card_payment', 'bank_deposit')), 0)
       FROM account a WHERE a.account_number LIKE 'SYS-FLW-%')::bigint AS processor_clearing_drift
  `);
  const checks = result.rows[0];
  return res.status(200).json({
    ok: Object.values(checks).every((value) => Number(value) === 0),
    checks,
  });
}
