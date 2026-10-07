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
import { endSession, issueSession } from "../utils/session.js";
import { brokerageQueue } from "../services/queue.js";
import { billDuePlans } from "../services/recurring.js";
import { isUuid, validationDetails } from "../utils/validation.js";
import { approveApplication, disburseApprovedLoan, rejectApplication } from "./loanController.js";

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
    // a submission still in flight would block a fresh one
    await pool.query(
      `UPDATE kyc_verification SET verification_status = 'rejected', rejection_reason = 'Reset (development)', reviewed_at = NOW()
       WHERE user_id = $1 AND verification_status = 'pending'`,
      [userId],
    );
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
  // With 2FA now off, a session that was still waiting for its code (a run
  // that stopped with 2FA on) is swapped for a normal one, so the caller can
  // carry on without signing in again.
  if (flags.two_factor) {
    await endSession(req, res);
    await issueSession(res, user.rows[0]);
  }
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
    // the issuer, or the billed VergePay user (an invoice to a client has none)
    `UPDATE invoices i SET due_date = CURRENT_DATE - $3::int
     WHERE i.invoice_id = $1
       AND ($2 = i.issuer_user_id
            OR $2 IN (SELECT ba.user_id FROM account ba WHERE ba.account_id = i.account_id))
     RETURNING to_char(i.due_date, 'YYYY-MM-DD') AS due_date`,
    [invoiceId, req.user.sub, validation.data.days],
  );
  if (result.rowCount === 0) throw new NotFoundError({ message: "Invoice not found." });
  return res.status(200).json({ invoice_id: invoiceId, due_date: result.rows[0].due_date });
}

// POST /v1/dev/recurring-plans/:planId/backdate  { days }
// Moves one of the caller's plans back in time: its start date and next
// billing date go back by `days`, as if it had been made that long ago. With
// /dev/recurring/run, this bills it today (or catches up missed cycles).
export async function backdateRecurringPlan(req, res) {
  const validation = backdateSchema.safeParse(req.body ?? {});
  if (!validation.success) {
    throw new ValidationError({ details: validationDetails(validation.error) });
  }
  const { planId } = req.params;
  if (!isUuid(planId)) throw new NotFoundError({ message: "Plan not found." });
  const result = await pool.query(
    `UPDATE recurring_plans
     SET start_date = start_date - $3::int,
         next_billing_date = recurring_billing_date(start_date - $3::int, frequency, next_cycle)
     WHERE plan_id = $1 AND user_id = $2
     RETURNING to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(next_billing_date, 'YYYY-MM-DD') AS next_billing_date`,
    [planId, req.user.sub, validation.data.days],
  );
  if (result.rowCount === 0) throw new NotFoundError({ message: "Plan not found." });
  return res.status(200).json({ plan_id: planId, ...result.rows[0] });
}

// POST /v1/dev/recurring/run
// Runs the recurring-billing job now, for the caller's due plans only (the
// worker's schedule runs it for everyone).
export async function runRecurringBilling(req, res) {
  const due = await pool.query(
    `SELECT p.plan_id FROM recurring_plans p JOIN users u ON u.user_id = p.user_id
     WHERE p.user_id = $1 AND p.plan_status = 'active'
       AND p.next_billing_date <= (NOW() AT TIME ZONE u.timezone)::date`,
    [req.user.sub],
  );
  const result = await billDuePlans({ planIds: due.rows.map((r) => r.plan_id) });
  return res.status(200).json(result);
}

const expireStateSchema = z.strictObject({ state: z.string().min(1) });

// POST /v1/dev/oauth-states/expire  { state }
// Ages one of the caller's pending brokerage connections past its 10-minute
// window, to see the callback refuse it.
export async function expireOauthState(req, res) {
  const validation = expireStateSchema.safeParse(req.body ?? {});
  if (!validation.success) {
    throw new ValidationError({ details: validationDetails(validation.error) });
  }
  const result = await pool.query(
    `UPDATE oauth_states SET expires_at = NOW() - interval '1 minute'
     WHERE state_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex') AND user_id = $2`,
    [validation.data.state, req.user.sub],
  );
  if (result.rowCount === 0) throw new NotFoundError({ message: "No pending connection with that state." });
  return res.status(200).json({ expired: true });
}

// POST /v1/dev/brokerage/run-scheduler
// Makes the caller's active brokerage links look overdue, then queues the
// same "sync-all-links" job the scheduler runs every 15 minutes, so its
// effect can be checked without waiting.
export async function runBrokerageScheduler(req, res) {
  const due = await pool.query(
    `UPDATE external_brokerage_links SET last_synced_at = NOW() - interval '1 day'
     WHERE user_id = $1 AND link_status = 'active'
     RETURNING link_id`,
    [req.user.sub],
  );
  await brokerageQueue().add("sync-all-links", {}, { attempts: 1, removeOnComplete: true, removeOnFail: true });
  return res.status(202).json({ made_due: due.rows.map((r) => r.link_id), job: "sync-all-links" });
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
      -- the clearing account is exactly what came in through Flutterwave
      -- (card top-ups, bank deposits, invoices paid on the pay page) less what
      -- went back out (withdrawals paid, and Flutterwave's transfer fees)
      (SELECT COALESCE(sum(a.balance_minor), 0) + COALESCE((
         SELECT sum(t.amount_minor) FROM transactions t
         JOIN account s ON s.account_id = t.sender_account_id
         WHERE t.status IN ('settled', 'reversed') AND s.account_number LIKE 'SYS-FLW-%'), 0) - COALESCE((
         SELECT sum(t.amount_minor) FROM transactions t
         JOIN account r ON r.account_id = t.receiver_account_id
         WHERE t.status IN ('settled', 'reversed') AND r.account_number LIKE 'SYS-FLW-%'), 0)
       FROM account a WHERE a.account_number LIKE 'SYS-FLW-%')::bigint AS processor_clearing_drift,
      (SELECT count(*) FROM invoices i
       WHERE EXISTS (SELECT 1 FROM invoice_items it WHERE it.invoice_id = i.invoice_id)
         AND i.amount_due_minor <> (SELECT sum(it.amount_minor) FROM invoice_items it WHERE it.invoice_id = i.invoice_id)
      )::int AS invoice_items_mismatch,
      -- a goal's money sits in its own savings account, owned by the same
      -- customer in the same currency; a closed goal has an empty, closed account
      (SELECT count(*) FROM goals g
       JOIN account a ON a.account_id = g.account_id
       WHERE a.account_type <> 'savings' OR a.user_id <> g.user_id OR a.currency_code <> g.currency_code
          OR (g.goal_status = 'closed') <> (a.account_status = 'closed')
          OR (g.goal_status = 'closed' AND a.balance_minor <> 0)
      )::int AS goal_account_mismatch,
      -- goal money only moves between the goal and its owner's wallets
      (SELECT count(*) FROM transactions t
       JOIN goals g ON g.account_id IN (t.sender_account_id, t.receiver_account_id)
       JOIN account w ON w.account_id = CASE WHEN g.account_id = t.sender_account_id
                                             THEN t.receiver_account_id ELSE t.sender_account_id END
       WHERE t.transaction_type NOT IN ('goal_contribution', 'goal_withdrawal')
          OR w.user_id IS DISTINCT FROM g.user_id OR w.account_type <> 'current'
          OR (t.transaction_type = 'goal_contribution') <> (t.receiver_account_id = g.account_id)
      )::int AS goal_transaction_mismatch,
      -- every payroll payment is a settled payroll_payment from its run's
      -- wallet to its payee's wallet, for the amount recorded
      (SELECT count(*) FROM payroll_payments pp
       JOIN payroll_runs r ON r.run_id = pp.run_id
       JOIN payees p ON p.payee_id = pp.payee_id
       JOIN transactions t ON t.transaction_id = pp.transaction_id
       WHERE t.transaction_type <> 'payroll_payment' OR t.status <> 'settled'
          OR t.amount_minor <> pp.amount_minor OR t.currency_code <> r.currency_code
          OR t.sender_account_id <> r.source_account_id OR t.receiver_account_id <> p.account_id
          OR p.user_id <> r.user_id
      )::int AS payroll_payment_mismatch,
      -- a run's total and count are exactly its payments
      (SELECT count(*) FROM payroll_runs r
       WHERE r.total_minor <> COALESCE((SELECT sum(amount_minor) FROM payroll_payments pp WHERE pp.run_id = r.run_id), 0)
          OR r.payment_count <> (SELECT count(*) FROM payroll_payments pp WHERE pp.run_id = r.run_id)
      )::int AS payroll_run_total_drift,
      -- payroll money never moves without its payment record
      (SELECT count(*) FROM transactions t
       WHERE t.transaction_type = 'payroll_payment'
         AND NOT EXISTS (SELECT 1 FROM payroll_payments pp WHERE pp.transaction_id = t.transaction_id)
      )::int AS payroll_transaction_unrecorded,
      -- a withdrawal's money left its wallet for the payout account, its fee
      -- for the fee account, and its status matches what happened to both
      (SELECT count(*) FROM withdrawals w
       JOIN transactions t ON t.transaction_id = w.transaction_id
       JOIN account payout ON payout.account_id = t.receiver_account_id
       LEFT JOIN transactions f ON f.transaction_id = w.fee_transaction_id
       WHERE t.transaction_type <> 'withdrawal' OR t.amount_minor <> w.amount_minor
          OR t.sender_account_id <> w.account_id OR payout.account_number <> 'SYS-PAYOUT-' || w.currency_code
          OR (w.fee_transaction_id IS NOT NULL AND (f.transaction_type <> 'fee' OR f.amount_minor <> w.customer_fee_minor OR f.sender_account_id <> w.account_id))
          OR t.status::text <> CASE w.status WHEN 'failed' THEN 'reversed' ELSE 'settled' END
          OR (w.status = 'failed') <> EXISTS (
               SELECT 1 FROM transactions r WHERE r.reverses_transaction_id = w.transaction_id
                 AND r.transaction_type = 'refund' AND r.amount_minor = w.amount_minor AND r.receiver_account_id = w.account_id)
          OR (w.status = 'successful') <> EXISTS (
               SELECT 1 FROM transactions p WHERE p.idempotency_key = 'withdrawal-paid:' || w.withdrawal_id AND p.amount_minor = w.amount_minor)
      )::int AS withdrawal_mismatch,
      -- the payout account holds exactly the withdrawals still on their way
      (SELECT COALESCE(sum(a.balance_minor), 0) - COALESCE((
         SELECT sum(w.amount_minor) FROM withdrawals w WHERE w.status = 'pending'), 0)
       FROM account a WHERE a.account_number LIKE 'SYS-PAYOUT-%')::bigint AS payout_in_transit_drift
  `);
  const checks = result.rows[0];
  return res.status(200).json({
    ok: Object.values(checks).every((value) => Number(value) === 0),
    checks,
  });
}

// POST /v1/dev/loans/applications/:applicationId/decide
//   { decision: "approve", interest_rate_bps?, approved_amount_minor?, term_months? }
//   { decision: "reject", reason }
// Decides one of the caller's own applications, standing in for the
// underwriter: an approval is paid out at once, as the back office would
// (POST /approve then /disburse). Either way it runs the same code.
const decideSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    decision: z.literal("approve"),
    interest_rate_bps: z.number().int().min(0).max(10_000).default(2400),
    approved_amount_minor: z.number().int().positive().optional(),
    term_months: z.number().int().min(1).max(360).optional(),
  }),
  z.strictObject({ decision: z.literal("reject"), reason: z.string().trim().min(1).max(255) }),
]);

export async function decideOwnLoanApplication(req, res) {
  const validation = decideSchema.safeParse(req.body ?? {});
  if (!validation.success) {
    throw new ValidationError({ details: validationDetails(validation.error) });
  }
  const { applicationId } = req.params;
  const owned = isUuid(applicationId)
    ? await pool.query(`SELECT 1 FROM loan_applications WHERE application_id = $1 AND user_id = $2`, [applicationId, req.user.sub])
    : { rowCount: 0 };
  if (owned.rowCount === 0) throw new NotFoundError({ message: "Loan application not found." });

  const { decision, ...terms } = validation.data;
  if (decision === "reject") return res.status(200).json(await rejectApplication(applicationId, terms));

  const loan = await approveApplication(applicationId, terms);
  await disburseApprovedLoan(loan.loan_id, `dev:${loan.loan_id}`);
  return res.status(201).json({ ...loan, loan_status: "active" });
}

// POST /v1/dev/loans/:loanId/backdate  { days }
// Moves the unpaid installments of one of the caller's loans back by `days`,
// so the next one can be shown as overdue.
export async function backdateLoan(req, res) {
  const validation = backdateSchema.safeParse(req.body ?? {});
  if (!validation.success) {
    throw new ValidationError({ details: validationDetails(validation.error) });
  }
  const { loanId } = req.params;
  if (!isUuid(loanId)) throw new NotFoundError({ message: "Loan not found." });
  const result = await pool.query(
    `UPDATE loan_repayment_schedule s SET due_date = s.due_date - $3::int
     FROM loans l JOIN account acc ON acc.account_id = l.account_id
     WHERE s.loan_id = l.loan_id AND l.loan_id = $1 AND acc.user_id = $2 AND NOT s.paid_flag
     RETURNING s.installment_number`,
    [loanId, req.user.sub, validation.data.days],
  );
  if (result.rowCount === 0) throw new NotFoundError({ message: "Loan not found, or nothing left to pay." });
  return res.status(200).json({ loan_id: loanId, installments_moved: result.rowCount });
}
