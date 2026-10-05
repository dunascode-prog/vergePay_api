import z from "zod";
import { pool } from "../db/connectDB.js";
import { withTransaction } from "../db/withTransaction.js";
import { buildSchedule, monthlyInstallment } from "../services/amortization.js";
import { postOnce, postTransaction } from "../services/ledger.js";
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
});

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

    let inserted;
    try {
      inserted = await client.query(
        `INSERT INTO loan_applications (
            user_id, account_id, loan_type, requested_amount_minor,
            currency_code, term_months, purpose
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING application_id, status, created_at AS submitted_at`,
        [
          userId,
          body.account_id,
          body.loan_type,
          body.requested_amount_minor,
          body.currency_code,
          body.term_months,
          body.purpose ?? null,
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

// A borrower's loans, and one of them, with the next installment due.
const LOAN_WITH_PROGRESS = `
    SELECT ${LOAN_COLUMNS},
           (SELECT count(*)::int FROM loan_repayment_schedule s
            WHERE s.loan_id = l.loan_id AND s.paid_flag) AS installments_paid,
           (SELECT json_build_object(
                     'installment_number', s.installment_number,
                     'due_date', to_char(s.due_date, 'YYYY-MM-DD'),
                     'installment_amount_minor', s.installment_amount_minor)
            FROM loan_repayment_schedule s
            WHERE s.loan_id = l.loan_id AND NOT s.paid_flag
            ORDER BY s.installment_number
            LIMIT 1) AS next_installment
    FROM loans l
    JOIN account acc ON acc.account_id = l.account_id`;

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
            paid_flag,
            paid_transaction_id
     FROM loan_repayment_schedule
     WHERE loan_id = $1
     ORDER BY installment_number`,
    [loanId],
  );
  return res.status(200).json({ loan_id: loanId, data: schedule.rows });
}

// The repayment response, rebuilt from what was committed so a replay
// returns the same body. Installments are paid strictly in order, so the
// balance right after installment k is the sum of the installments after k.
async function repaymentResponse(db, transaction) {
  const result = await db.query(
    `SELECT s.installment_number,
            (SELECT COALESCE(sum(later.installment_amount_minor), 0)::bigint
             FROM loan_repayment_schedule later
             WHERE later.loan_id = s.loan_id
               AND later.installment_number > s.installment_number) AS balance_after
     FROM loan_repayment_schedule s
     WHERE s.paid_transaction_id = $1`,
    [transaction.transaction_id],
  );
  const row = result.rows[0];
  return {
    transaction_id: transaction.transaction_id,
    loan_id: transaction.loan_id,
    amount_minor: transaction.amount_minor,
    status: transaction.status,
    schedule_installment_marked_paid: row.installment_number,
    new_balance_remaining_minor: row.balance_after,
  };
}

// POST /v1/loans/:loanId/repayments
// Pays the next unpaid installment, in full. In one DB transaction it posts
// the ledger pair (borrower's account -> loan-holding account), marks the
// installment paid and lowers the balance, closing the loan on the last
// installment (API doc 7.4).
export async function repayLoan(req, res) {
  const { loanId } = req.params;
  if (!isUuid(loanId)) throw loanNotFound();
  const body = parseBody(repaymentSchema, req.body);
  const userId = req.user.sub;
  const idempotencyKey = `${userId}:${req.idempotencyKey}`;

  const isSameRepayment = (existing) =>
    existing.transaction_type === "loan_repayment" &&
    existing.loan_id === loanId &&
    existing.sender_account_id === body.source_account_id &&
    existing.amount_minor === body.amount_minor;

  const { transaction, replayed } = await postOnce(idempotencyKey, async (client) => {
    const found = await client.query(
      `SELECT l.loan_id, l.loan_status, l.currency_code, l.balance_remaining_minor
       FROM loans l JOIN account acc ON acc.account_id = l.account_id
       WHERE l.loan_id = $1 AND acc.user_id = $2
       FOR UPDATE OF l`,
      [loanId, userId],
    );
    const loan = found.rows[0];
    if (!loan) throw loanNotFound();
    if (loan.loan_status !== "active") {
      throw new ConflictError({
        message: `Can't repay a loan that is ${loan.loan_status}.`,
      });
    }

    const source = await client.query(
      `SELECT currency_code FROM account
       WHERE account_id = $1 AND user_id = $2 AND NOT is_system`,
      [body.source_account_id, userId],
    );
    if (source.rowCount === 0) {
      throw new ValidationError({ details: { source_account_id: ["Account not found."] } });
    }

    const next = await client.query(
      `SELECT schedule_id, installment_number, installment_amount_minor
       FROM loan_repayment_schedule
       WHERE loan_id = $1 AND NOT paid_flag
       ORDER BY installment_number
       LIMIT 1`,
      [loanId],
    );
    const installment = next.rows[0];
    if (body.amount_minor !== installment.installment_amount_minor) {
      throw new ValidationError({
        details: {
          amount_minor: [
            `Installment ${installment.installment_number} is due: pay exactly ${installment.installment_amount_minor}.`,
          ],
        },
      });
    }

    // postTransaction checks the source is active, in the loan's currency
    // and can afford it.
    const posted = await postTransaction(client, {
      transactionType: "loan_repayment",
      senderAccountId: body.source_account_id,
      receiverAccountId: await loanHoldingAccountId(client, loan.currency_code),
      amountMinor: body.amount_minor,
      currencyCode: loan.currency_code,
      description: `Loan repayment, installment ${installment.installment_number}`,
      idempotencyKey,
      loanId,
    });

    await client.query(
      `UPDATE loan_repayment_schedule
       SET paid_flag = TRUE, paid_transaction_id = $2
       WHERE schedule_id = $1`,
      [installment.schedule_id, posted.transaction_id],
    );

    const balanceAfter = loan.balance_remaining_minor - body.amount_minor;
    const statusAfter = balanceAfter === 0 ? "repaid" : "active";
    await client.query(
      `UPDATE loans SET balance_remaining_minor = $2, loan_status = $3 WHERE loan_id = $1`,
      [loanId, balanceAfter, statusAfter],
    );
    if (statusAfter === "repaid") {
      await writeAudit(client, {
        actorId: userId,
        entityType: "loan",
        entityId: loanId,
        action: "status_change",
        before: { loan_status: "active" },
        after: { loan_status: "repaid" },
      });
    }
    return posted;
  }, isSameRepayment);

  if (replayed) res.set("Idempotent-Replayed", "true");
  return res.status(201).json(await repaymentResponse(pool, transaction));
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
          balance_remaining_minor, loan_status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'approved')
       RETURNING loan_id, loan_status`,
      [
        application.application_id,
        application.account_id,
        application.loan_type,
        principal,
        body.interest_rate_bps,
        term,
        application.currency_code,
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
