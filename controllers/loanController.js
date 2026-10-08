import z from "zod";
import { pool } from "../db/connectDB.js";
import { withTransaction } from "../db/withTransaction.js";
import env from "../env.js";
import { buildSchedule, monthlyInstallment } from "../services/amortization.js";
import { postOnce, postTransaction } from "../services/ledger.js";
import { currentLoanTerms, LOAN_TERMS_VERSION } from "../services/loanTerms.js";
import {
  checkRepaymentAmount,
  lockLoan,
  lockSchedule,
  paymentResponse,
  payoffQuote,
  postRepayment,
} from "../services/loanRepayments.js";
import { writeAudit } from "../utils/audit.js";
import {
  BadRequestError,
  ConflictError,
  KycRequiredError,
  NotFoundError,
  ValidationError,
} from "../utils/errorStr.js";
import { isUuid, validationDetails } from "../utils/validation.js";

// Loans follow a lifecycle rather than CRUD (API doc 7):
//
//   application: pending_review -> approved | rejected       (a request for credit)
//   loan:        approved -> active -> repaid                (created on approval)
//                active <-> defaulted                       (90 days overdue; back once caught up)
//
// Repayments, payoffs, late fees and auto-debit: services/loanRepayments.js
// and services/loanJobs.js.
//
// Money only moves at disbursement and repayment, and both post through the
// same ledger routine as a transfer. The other side of both is the
// platform's loan-holding account for the currency (SYS-LOAN-<code>).
//
// balance_remaining_minor is what the borrower still owes: the sum of the
// unpaid installments, interest included. It is 0 until disbursement.
//
// Lock order is always loan row first, then accounts (inside
// postTransaction), so two operations on one loan can't deadlock.

// ₦1,000 to ₦100,000,000 in kobo (the same bounds in other currencies' minor units).
const MIN_LOAN_MINOR = 100_000;
const MAX_LOAN_MINOR = 10_000_000_000;

const LOAN_TYPES = ["personal", "mortgage", "cash_advance", "asset_finance"];

// Loans can be paid into everyday accounts only.
const DISBURSABLE_ACCOUNT_TYPES = ["current", "savings"];

const loanAmount = z.number().int().min(MIN_LOAN_MINOR).max(MAX_LOAN_MINOR);
const termMonths = z.number().int().min(1).max(360);

const applicationSchema = z.strictObject({
  account_id: z.uuid(),
  loan_type: z.enum(LOAN_TYPES),
  requested_amount_minor: loanAmount,
  currency_code: z.string().trim().toUpperCase().length(3),
  term_months: termMonths,
  purpose: z.string().trim().min(1).max(255).optional(),
  // new loans are repaid automatically from the wallet; the borrower agrees
  auto_debit_consent: z.literal(true, { error: "Agree to automatic repayments to apply." }),
  // the loan terms the borrower read and agreed to (GET /v1/loans/terms)
  terms_version: z.string().trim().min(1).max(40),
});

const payoffSchema = z.strictObject({ source_account_id: z.uuid() });
const autoDebitSchema = z.strictObject({ enabled: z.boolean() });

// The underwriter sets the rate and may lend less, or over a different
// term, than was asked for.
const approvalSchema = z.strictObject({
  interest_rate_bps: z.number().int().min(0).max(10_000),
  approved_amount_minor: loanAmount.optional(),
  term_months: termMonths.optional(),
});

const rejectionSchema = z.strictObject({
  reason: z.string().trim().min(1).max(255),
});

const repaymentSchema = z.strictObject({
  source_account_id: z.uuid(),
  amount_minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

function parseBody(schema, body) {
  if (!body || Object.keys(body).length === 0) {
    throw new BadRequestError({ message: "Request body is empty." });
  }
  const validation = schema.safeParse(body);
  if (!validation.success) {
    throw new ValidationError({ details: validationDetails(validation.error) });
  }
  return validation.data;
}

const applicationNotFound = () => new NotFoundError({ message: "Loan application not found." });
const loanNotFound = () => new NotFoundError({ message: "Loan not found." });

const APPLICATION_COLUMNS = `
    a.application_id,
    a.account_id,
    a.loan_type,
    a.requested_amount_minor,
    a.currency_code,
    a.term_months,
    a.purpose,
    a.auto_debit_consent,
    a.terms_version,
    a.terms_accepted_at,
    a.status,
    a.decision_reason,
    a.created_at AS submitted_at,
    a.decided_at,
    l.loan_id`;

const LOAN_COLUMNS = `
    l.loan_id,
    l.application_id,
    l.account_id,
    l.loan_type,
    l.principal_minor,
    l.interest_rate_bps,
    l.term_months,
    l.currency_code,
    l.balance_remaining_minor,
    l.loan_status,
    l.auto_debit,
    l.defaulted_at,
    l.disbursed_at,
    l.created_at`;

// The platform's loan-holding account for a currency.
async function loanHoldingAccountId(db, currencyCode) {
  const result = await db.query(
    `SELECT account_id FROM account WHERE account_number = $1 AND is_system`,
    [`SYS-LOAN-${currencyCode}`],
  );
  if (result.rowCount === 0) {
    throw new ValidationError({
      details: { currency_code: [`Loans in ${currencyCode} aren't supported.`] },
    });
  }
  return result.rows[0].account_id;
}

// ---------------------------------------------------------------------------
// Borrower endpoints

// POST /v1/loans/applications
export async function applyForLoan(req, res) {
  const body = parseBody(applicationSchema, req.body);
  const userId = req.user.sub;

  const application = await withTransaction(async (client) => {
    const user = await client.query(`SELECT kyc_status FROM users WHERE user_id = $1`, [userId]);
    if (user.rows[0]?.kyc_status !== "verified") {
      throw new KycRequiredError({
        message: "Identity verification is required before you can apply for a loan.",
      });
    }

    const account = await client.query(
      `SELECT account_type, account_status, currency_code FROM account
       WHERE account_id = $1 AND user_id = $2 AND NOT is_system`,
      [body.account_id, userId],
    );
    const target = account.rows[0];
    if (!target) {
      throw new ValidationError({ details: { account_id: ["Account not found."] } });
    }
    if (!DISBURSABLE_ACCOUNT_TYPES.includes(target.account_type)) {
      throw new ValidationError({
        details: { account_id: ["Loans can only be paid into a current or savings account."] },
      });
    }
    if (target.account_status !== "active") {
      throw new ConflictError({ message: `The account is ${target.account_status}.` });
    }
    if (target.currency_code !== body.currency_code) {
      throw new ValidationError({
        details: { currency_code: [`The account holds ${target.currency_code}.`] },
      });
    }
    await loanHoldingAccountId(client, body.currency_code);

    // agreed to terms that have since changed: they must read the new ones
    if (body.terms_version !== LOAN_TERMS_VERSION) {
      throw new ConflictError({
        message: "The loan terms have changed since you agreed to them. Please review and agree to the current terms.",
        field: "terms_version",
      });
    }

    const defaulted = await client.query(
      `SELECT 1 FROM loans l JOIN account acc ON acc.account_id = l.account_id
       WHERE acc.user_id = $1 AND l.loan_status = 'defaulted' LIMIT 1`,
      [userId],
    );
    if (defaulted.rowCount > 0) {
      throw new ConflictError({ message: "You have a loan in default. Catch up on it before applying for another." });
    }

    let inserted;
    try {
      inserted = await client.query(
        `INSERT INTO loan_applications (
            user_id, account_id, loan_type, requested_amount_minor,
            currency_code, term_months, purpose, auto_debit_consent,
            terms_version, terms_accepted_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, NOW())
         RETURNING application_id, status, created_at AS submitted_at`,
        [
          userId,
          body.account_id,
          body.loan_type,
          body.requested_amount_minor,
          body.currency_code,
          body.term_months,
          body.purpose ?? null,
          body.terms_version,
        ],
      );
    } catch (err) {
      if (err.code === "23505" && err.constraint === "uq_loan_app_one_pending") {
        throw new ConflictError({
          message: "You already have a loan application waiting for a decision.",
        });
      }
      throw err;
    }

    const created = inserted.rows[0];
    await writeAudit(client, {
      actorId: userId,
      entityType: "loan_application",
      entityId: created.application_id,
      action: "create",
      after: { ...body, status: created.status },
    });
    return created;
  });

  // 202: the application is accepted for review, not decided (API doc 7.1).
  return res.status(202).json(application);
}

// GET /v1/loans/terms
// The current loan terms' version and the numbers they quote, so the app
// shows exactly what the borrower agrees to.
export async function getLoanTerms(req, res) {
  return res.status(200).json(currentLoanTerms());
}

// GET /v1/loans/applications/:applicationId
export async function getLoanApplication(req, res) {
  const { applicationId } = req.params;
  if (!isUuid(applicationId)) throw applicationNotFound();

  const result = await pool.query(
    `SELECT ${APPLICATION_COLUMNS}
     FROM loan_applications a
     LEFT JOIN loans l ON l.application_id = a.application_id
     WHERE a.application_id = $1 AND a.user_id = $2`,
    [applicationId, req.user.sub],
  );
  if (result.rowCount === 0) throw applicationNotFound();
  return res.status(200).json(result.rows[0]);
}

// GET /v1/loans/applications: the caller's applications, newest first, so an
// app can show one that's still waiting for a decision.
export async function listLoanApplications(req, res) {
  const result = await pool.query(
    `SELECT ${APPLICATION_COLUMNS}
     FROM loan_applications a
     LEFT JOIN loans l ON l.application_id = a.application_id
     WHERE a.user_id = $1
     ORDER BY a.created_at DESC`,
    [req.user.sub],
  );
  return res.status(200).json({ data: result.rows });
}

// What's still owed on one installment row `s`.
const OWED = `(s.late_fee_minor - s.late_fee_paid_minor + s.interest_minor - s.interest_paid_minor
               - s.interest_waived_minor + s.principal_minor - s.principal_paid_minor)`;

// A borrower's loans, and one of them, with the next installment, what's
// due now (in the borrower's timezone) and how late it is.
export const LOAN_WITH_PROGRESS = `
    SELECT ${LOAN_COLUMNS},
           (SELECT count(*)::int FROM loan_repayment_schedule s
            WHERE s.loan_id = l.loan_id AND s.paid_flag) AS installments_paid,
           (SELECT count(*)::int FROM loan_repayment_schedule s
            WHERE s.loan_id = l.loan_id) AS installments_total,
           (SELECT json_build_object(
                     'installment_number', s.installment_number,
                     'due_date', to_char(s.due_date, 'YYYY-MM-DD'),
                     'installment_amount_minor', s.installment_amount_minor,
                     'remaining_minor', ${OWED})
            FROM loan_repayment_schedule s
            WHERE s.loan_id = l.loan_id AND NOT s.paid_flag
            ORDER BY s.installment_number
            LIMIT 1) AS next_installment,
           (SELECT COALESCE(sum(${OWED}), 0)::bigint FROM loan_repayment_schedule s
            WHERE s.loan_id = l.loan_id AND NOT s.paid_flag AND s.due_date <= d.today) AS amount_due_now_minor,
           (SELECT COALESCE(sum(s.late_fee_minor - s.late_fee_paid_minor), 0)::bigint FROM loan_repayment_schedule s
            WHERE s.loan_id = l.loan_id) AS late_fees_owed_minor,
           (SELECT d.today - min(s.due_date) FROM loan_repayment_schedule s
            WHERE s.loan_id = l.loan_id AND NOT s.paid_flag AND s.due_date < d.today) AS days_overdue
    FROM loans l
    JOIN account acc ON acc.account_id = l.account_id
    JOIN users u ON u.user_id = acc.user_id
    CROSS JOIN LATERAL (SELECT (NOW() AT TIME ZONE u.timezone)::date AS today) d`;

// GET /v1/loans
export async function listLoans(req, res) {
  const result = await pool.query(
    `${LOAN_WITH_PROGRESS}
     WHERE acc.user_id = $1
     ORDER BY l.created_at DESC`,
    [req.user.sub],
  );
  return res.status(200).json({ data: result.rows });
}

// GET /v1/loans/:loanId
export async function getLoan(req, res) {
  const { loanId } = req.params;
  if (!isUuid(loanId)) throw loanNotFound();

  const result = await pool.query(
    `${LOAN_WITH_PROGRESS}
     WHERE l.loan_id = $1 AND acc.user_id = $2`,
    [loanId, req.user.sub],
  );
  if (result.rowCount === 0) throw loanNotFound();
  return res.status(200).json(result.rows[0]);
}

// GET /v1/loans/:loanId/schedule  (empty until the loan is disbursed)
export async function getLoanSchedule(req, res) {
  const { loanId } = req.params;
  if (!isUuid(loanId)) throw loanNotFound();

  const owned = await pool.query(
    `SELECT 1 FROM loans l JOIN account acc ON acc.account_id = l.account_id
     WHERE l.loan_id = $1 AND acc.user_id = $2`,
    [loanId, req.user.sub],
  );
  if (owned.rowCount === 0) throw loanNotFound();

  const schedule = await pool.query(
    `SELECT installment_number,
            to_char(due_date, 'YYYY-MM-DD') AS due_date,
            installment_amount_minor,
            principal_minor,
            interest_minor,
            principal_paid_minor,
            interest_paid_minor,
            interest_waived_minor,
            late_fee_minor,
            late_fee_paid_minor,
            (late_fee_minor - late_fee_paid_minor + interest_minor - interest_paid_minor - interest_waived_minor
             + principal_minor - principal_paid_minor) AS remaining_minor,
            paid_flag,
            paid_at,
            paid_transaction_id
     FROM loan_repayment_schedule
     WHERE loan_id = $1
     ORDER BY installment_number`,
    [loanId],
  );
  return res.status(200).json({ loan_id: loanId, data: schedule.rows });
}

// The loan, owned by the caller, locked with its schedule. 404 otherwise.
async function lockOwnLoan(client, loanId, userId) {
  if (!isUuid(loanId)) throw loanNotFound();
  const loan = await lockLoan(client, loanId);
  if (!loan || loan.user_id !== userId) throw loanNotFound();
  return { loan, rows: await lockSchedule(client, loanId) };
}

function requireRepayable(loan) {
  if (!["active", "defaulted"].includes(loan.loan_status)) {
    throw new ConflictError({ message: `Can't repay a loan that is ${loan.loan_status}.` });
  }
}

async function checkSource(client, userId, accountId) {
  const source = await client.query(
    `SELECT 1 FROM account WHERE account_id = $1 AND user_id = $2 AND NOT is_system`,
    [accountId, userId],
  );
  if (source.rowCount === 0) {
    throw new ValidationError({ details: { source_account_id: ["Account not found."] } });
  }
}

// GET /v1/loans/:loanId/payoff
// What paying the loan off today would cost, and the interest it saves.
export async function getPayoffQuote(req, res) {
  const quote = await withTransaction(async (client) => {
    const { loan, rows } = await lockOwnLoan(client, req.params.loanId, req.user.sub);
    requireRepayable(loan);
    return payoffQuote(loan, rows, loan.today);
  });
  return res.status(200).json({ loan_id: req.params.loanId, ...quote });
}

// POST /v1/loans/:loanId/repayments  { source_account_id, amount_minor }
// Any amount from the minimum up to the payoff total (services/loanRepayments.js
// has the order it's applied in). Paying exactly the payoff total pays the
// loan off. Idempotent; the loan row is locked, so payments queue.
export async function repayLoan(req, res) {
  const { loanId } = req.params;
  const body = parseBody(repaymentSchema, req.body);
  const userId = req.user.sub;
  const idempotencyKey = `${userId}:${req.idempotencyKey}`;

  const isSameRepayment = (existing) =>
    existing.transaction_type === "loan_repayment" &&
    existing.loan_id === loanId &&
    existing.sender_account_id === body.source_account_id &&
    existing.amount_minor === body.amount_minor;

  const { transaction, replayed } = await postOnce(idempotencyKey, async (client) => {
    const { loan, rows } = await lockOwnLoan(client, loanId, userId);
    requireRepayable(loan);
    await checkSource(client, userId, body.source_account_id);
    const quote = payoffQuote(loan, rows, loan.today);
    checkRepaymentAmount(body.amount_minor, quote, env.loans.minRepaymentMinor);
    // postTransaction checks the source is active, in the loan's currency and can afford it
    return postRepayment(client, {
      loan,
      rows,
      sourceAccountId: body.source_account_id,
      amountMinor: body.amount_minor,
      kind: body.amount_minor === quote.total_minor ? "payoff" : "repayment",
      idempotencyKey,
      holdingAccountId: await loanHoldingAccountId(client, loan.currency_code),
    });
  }, isSameRepayment);

  if (replayed) res.set("Idempotent-Replayed", "true");
  return res.status(201).json(await paymentResponse(pool, transaction.transaction_id));
}

// POST /v1/loans/:loanId/payoff  { source_account_id }
// Pays the loan off: the payoff total, worked out now (GET /payoff shows it).
export async function payOffLoan(req, res) {
  const { loanId } = req.params;
  const body = parseBody(payoffSchema, req.body);
  const userId = req.user.sub;
  const idempotencyKey = `${userId}:${req.idempotencyKey}`;

  const isSamePayoff = (existing) =>
    existing.transaction_type === "loan_repayment" &&
    existing.loan_id === loanId &&
    existing.sender_account_id === body.source_account_id;

  const { transaction, replayed } = await postOnce(idempotencyKey, async (client) => {
    const { loan, rows } = await lockOwnLoan(client, loanId, userId);
    requireRepayable(loan);
    await checkSource(client, userId, body.source_account_id);
    const quote = payoffQuote(loan, rows, loan.today);
    return postRepayment(client, {
      loan,
      rows,
      sourceAccountId: body.source_account_id,
      amountMinor: quote.total_minor,
      kind: "payoff",
      idempotencyKey,
      holdingAccountId: await loanHoldingAccountId(client, loan.currency_code),
    });
  }, isSamePayoff);

  if (replayed) res.set("Idempotent-Replayed", "true");
  return res.status(201).json(await paymentResponse(pool, transaction.transaction_id));
}

// PATCH /v1/loans/:loanId/auto-debit  { enabled }
// The borrower switches automatic repayments on or off. When on, the worker
// collects what's due from the loan's wallet on the due date and daily after.
export async function setAutoDebit(req, res) {
  const body = parseBody(autoDebitSchema, req.body);
  const userId = req.user.sub;
  await withTransaction(async (client) => {
    const { loan } = await lockOwnLoan(client, req.params.loanId, userId);
    if (["repaid", "rejected"].includes(loan.loan_status)) {
      throw new ConflictError({ message: `This loan is ${loan.loan_status}.` });
    }
    if (loan.auto_debit === body.enabled) return;
    await client.query(
      `UPDATE loans SET auto_debit = $2, auto_debit_last_attempt_on = NULL WHERE loan_id = $1`,
      [loan.loan_id, body.enabled],
    );
    await writeAudit(client, {
      actorId: userId,
      entityType: "loan",
      entityId: loan.loan_id,
      action: "update",
      before: { auto_debit: loan.auto_debit },
      after: { auto_debit: body.enabled },
    });
  });
  const result = await pool.query(`${LOAN_WITH_PROGRESS} WHERE l.loan_id = $1`, [req.params.loanId]);
  return res.status(200).json(result.rows[0]);
}

// ---------------------------------------------------------------------------
// Back-office endpoints ("Admin or System"; see utils/internalAuth.js)

// Locks an application for a decision, or 404/409.
async function lockPendingApplication(client, applicationId) {
  if (!isUuid(applicationId)) throw applicationNotFound();
  const result = await client.query(
    `SELECT * FROM loan_applications WHERE application_id = $1 FOR UPDATE`,
    [applicationId],
  );
  const application = result.rows[0];
  if (!application) throw applicationNotFound();
  if (application.status !== "pending_review") {
    throw new ConflictError({ message: `This application is already ${application.status}.` });
  }
  return application;
}

// POST /v1/loans/applications/:applicationId/approve
// Creates the loan with its final terms. No money moves until disburse.
export async function approveLoanApplication(req, res) {
  const body = parseBody(approvalSchema, req.body);
  return res.status(201).json(await approveApplication(req.params.applicationId, body));
}

// Shared with the dev-only helper (controllers/devController.js).
export function approveApplication(applicationId, body) {
  return withTransaction(async (client) => {
    const application = await lockPendingApplication(client, applicationId);

    const principal = body.approved_amount_minor ?? application.requested_amount_minor;
    if (principal > application.requested_amount_minor) {
      throw new ValidationError({
        details: { approved_amount_minor: ["Can't approve more than was requested."] },
      });
    }
    const term = body.term_months ?? application.term_months;

    const inserted = await client.query(
      `INSERT INTO loans (
          application_id, account_id, loan_type, principal_minor,
          interest_rate_bps, term_months, currency_code,
          balance_remaining_minor, loan_status, auto_debit
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'approved', $8)
       RETURNING loan_id, loan_status`,
      [
        application.application_id,
        application.account_id,
        application.loan_type,
        principal,
        body.interest_rate_bps,
        term,
        application.currency_code,
        application.auto_debit_consent,
      ],
    );
    await client.query(
      `UPDATE loan_applications SET status = 'approved', decided_at = NOW()
       WHERE application_id = $1`,
      [application.application_id],
    );

    const created = inserted.rows[0];
    await writeAudit(client, {
      actorId: null,
      entityType: "loan_application",
      entityId: application.application_id,
      action: "status_change",
      before: { status: "pending_review" },
      after: { status: "approved", loan_id: created.loan_id },
    });
    return {
      loan_id: created.loan_id,
      application_id: application.application_id,
      loan_status: created.loan_status,
      principal_minor: principal,
      interest_rate_bps: body.interest_rate_bps,
      term_months: term,
      currency_code: application.currency_code,
      monthly_installment_minor: monthlyInstallment({
        principalMinor: principal,
        interestRateBps: body.interest_rate_bps,
        termMonths: term,
      }),
    };
  });
}

// POST /v1/loans/applications/:applicationId/reject
export async function rejectLoanApplication(req, res) {
  const body = parseBody(rejectionSchema, req.body);
  return res.status(200).json(await rejectApplication(req.params.applicationId, body));
}

export function rejectApplication(applicationId, body) {
  return withTransaction(async (client) => {
    const pending = await lockPendingApplication(client, applicationId);
    const result = await client.query(
      `UPDATE loan_applications
       SET status = 'rejected', decision_reason = $2, decided_at = NOW()
       WHERE application_id = $1
       RETURNING application_id, status, decision_reason, decided_at`,
      [pending.application_id, body.reason],
    );
    await writeAudit(client, {
      actorId: null,
      entityType: "loan_application",
      entityId: pending.application_id,
      action: "status_change",
      before: { status: "pending_review" },
      after: { status: "rejected", decision_reason: body.reason },
    });
    return result.rows[0];
  });
}

// POST /v1/loans/:loanId/disburse
// Pays an approved loan into the borrower's account through the same ledger
// routine as a transfer, and generates the repayment schedule, starting one
// month from today in the borrower's timezone (API doc 7.2).
export async function disburseLoan(req, res) {
  const { transaction, replayed } = await disburseApprovedLoan(req.params.loanId, `internal:${req.idempotencyKey}`);
  if (replayed) res.set("Idempotent-Replayed", "true");
  return res.status(201).json({
    transaction_id: transaction.transaction_id,
    loan_id: transaction.loan_id,
    amount_minor: transaction.amount_minor,
    status: transaction.status,
  });
}

export async function disburseApprovedLoan(loanId, idempotencyKey) {
  if (!isUuid(loanId)) throw loanNotFound();

  const isSameDisbursement = (existing) =>
    existing.transaction_type === "loan_disbursement" && existing.loan_id === loanId;

  return postOnce(idempotencyKey, async (client) => {
    const found = await client.query(
      `SELECT l.*, acc.account_status,
              (NOW() AT TIME ZONE u.timezone)::date::text AS borrower_today
       FROM loans l
       JOIN account acc ON acc.account_id = l.account_id
       JOIN users u ON u.user_id = acc.user_id
       WHERE l.loan_id = $1
       FOR UPDATE OF l`,
      [loanId],
    );
    const loan = found.rows[0];
    if (!loan) throw loanNotFound();
    if (loan.loan_status !== "approved") {
      throw new ConflictError({
        message: `Can't disburse a loan that is ${loan.loan_status}; it has already been paid out.`,
      });
    }
    if (loan.account_status !== "active") {
      throw new ConflictError({
        message: `The borrower's account is ${loan.account_status}, so the loan can't be paid into it.`,
      });
    }

    const posted = await postTransaction(client, {
      transactionType: "loan_disbursement",
      senderAccountId: await loanHoldingAccountId(client, loan.currency_code),
      receiverAccountId: loan.account_id,
      amountMinor: loan.principal_minor,
      currencyCode: loan.currency_code,
      description: "Loan disbursement",
      idempotencyKey,
      loanId,
    });

    const schedule = buildSchedule({
      principalMinor: loan.principal_minor,
      interestRateBps: loan.interest_rate_bps,
      termMonths: loan.term_months,
      startDate: loan.borrower_today,
    });
    await client.query(
      `INSERT INTO loan_repayment_schedule (
          loan_id, installment_number, due_date,
          installment_amount_minor, principal_minor, interest_minor
       )
       SELECT $1::uuid, * FROM unnest($2::smallint[], $3::date[], $4::bigint[], $5::bigint[], $6::bigint[])`,
      [
        loanId,
        schedule.map((row) => row.installment_number),
        schedule.map((row) => row.due_date),
        schedule.map((row) => row.installment_amount_minor),
        schedule.map((row) => row.principal_minor),
        schedule.map((row) => row.interest_minor),
      ],
    );

    const totalRepayable = schedule.reduce((sum, row) => sum + row.installment_amount_minor, 0);
    await client.query(
      `UPDATE loans
       SET loan_status = 'active', disbursed_at = NOW(), balance_remaining_minor = $2
       WHERE loan_id = $1`,
      [loanId, totalRepayable],
    );
    await writeAudit(client, {
      actorId: null,
      entityType: "loan",
      entityId: loanId,
      action: "status_change",
      before: { loan_status: "approved" },
      after: { loan_status: "active", balance_remaining_minor: totalRepayable },
    });
    return posted;
  }, isSameDisbursement);
}

// GET /v1/admin/loans/applications?status=pending_review
// The underwriter's view of applications: the same resource as the
// borrower's GET, plus the data needed to decide (API doc 11.3).
const queueQuerySchema = z.strictObject({
  status: z.enum(["pending_review", "approved", "rejected"]).default("pending_review"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function listApplicationsForReview(req, res) {
  const validation = queueQuerySchema.safeParse(req.query);
  if (!validation.success) {
    throw new ValidationError({ details: validationDetails(validation.error) });
  }
  const q = validation.data;

  const result = await pool.query(
    `SELECT ${APPLICATION_COLUMNS},
            json_build_object(
              'user_id', u.user_id,
              'first_name', u.first_name,
              'last_name', u.last_name,
              'kyc_status', u.kyc_status,
              'member_since', u.created_at
            ) AS applicant,
            json_build_object(
              'account_number', acc.account_number,
              'account_status', acc.account_status,
              'balance_minor', acc.balance_minor,
              'declared_income_minor', acc.income_minor
            ) AS account,
            (SELECT json_build_object(
                      'active_count', count(*),
                      'outstanding_minor', COALESCE(sum(other.balance_remaining_minor), 0))
             FROM loans other
             JOIN account oa ON oa.account_id = other.account_id
             WHERE oa.user_id = a.user_id
               AND other.loan_status IN ('approved', 'active')) AS existing_loans
     FROM loan_applications a
     JOIN users u ON u.user_id = a.user_id
     JOIN account acc ON acc.account_id = a.account_id
     LEFT JOIN loans l ON l.application_id = a.application_id
     WHERE a.status = $1
     ORDER BY a.created_at
     LIMIT $2`,
    [q.status, q.limit],
  );
  return res.status(200).json({ data: result.rows });
}
