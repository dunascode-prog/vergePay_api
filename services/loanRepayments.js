import { writeAudit } from "../utils/audit.js";
import { ValidationError } from "../utils/errorStr.js";
import { postTransaction } from "./ledger.js";

// How a loan repayment is applied (db/migrations.db/loan_rules.sql).
//
// Any amount is applied in this order:
//   1. late fees, oldest first
//   2. installments already due, oldest first: interest, then principal
//   3. the next installment (money paid early counts as this month's first)
//   4. anything more pays the LAST installments' principal, newest first,
//      waiving their interest in proportion: the loan ends sooner while the
//      monthly amount stays the same
//
// Paying it all off costs only the principal left, plus what's overdue,
// plus interest for the days of the current period (payoffQuote); interest
// for later months is waived.
//
// Everything works on rows locked FOR UPDATE inside the caller's DB
// transaction, with the loan row locked first.

// What's still owed on one installment, by part.
const owedFee = (r) => r.late_fee_minor - r.late_fee_paid_minor;
const owedInterest = (r) => r.interest_minor - r.interest_paid_minor - r.interest_waived_minor;
const owedPrincipal = (r) => r.principal_minor - r.principal_paid_minor;
export const owed = (r) => owedFee(r) + owedInterest(r) + owedPrincipal(r);

const dayNumber = (iso) => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

/** The loan, locked, with the borrower and their "today". Null if not found. */
export async function lockLoan(client, loanId) {
  const result = await client.query(
    `SELECT l.loan_id, l.account_id, l.currency_code, l.loan_status, l.balance_remaining_minor,
            l.auto_debit, l.auto_debit_last_attempt_on::text, l.auto_debit_last_alert_at, l.defaulted_at,
            to_char((l.disbursed_at AT TIME ZONE u.timezone)::date, 'YYYY-MM-DD') AS disbursed_on,
            acc.user_id, (NOW() AT TIME ZONE u.timezone)::date::text AS today
     FROM loans l
     JOIN account acc ON acc.account_id = l.account_id
     JOIN users u ON u.user_id = acc.user_id
     WHERE l.loan_id = $1
     FOR UPDATE OF l`,
    [loanId],
  );
  return result.rows[0] ?? null;
}

/** The loan's installments in order, locked. */
export async function lockSchedule(client, loanId) {
  const result = await client.query(
    `SELECT schedule_id, installment_number, to_char(due_date, 'YYYY-MM-DD') AS due_date,
            installment_amount_minor, principal_minor, interest_minor,
            principal_paid_minor, interest_paid_minor, interest_waived_minor,
            late_fee_minor, late_fee_paid_minor, paid_flag
     FROM loan_repayment_schedule WHERE loan_id = $1
     ORDER BY installment_number
     FOR UPDATE`,
    [loanId],
  );
  return result.rows;
}

const unpaid = (rows) => rows.filter((r) => !r.paid_flag);
const isDue = (r, today) => r.due_date <= today;

/** Late fees plus everything on installments whose date has come. */
export function dueNow(rows, today) {
  return unpaid(rows)
    .filter((r) => isDue(r, today))
    .reduce((sum, r) => sum + owed(r), 0);
}

/**
 * What paying the loan off today costs: everything overdue, the principal
 * left, and interest for the days of the current period only.
 */
export function payoffQuote(loan, rows, today) {
  const open = unpaid(rows);
  const due = open.filter((r) => isDue(r, today));
  const future = open.filter((r) => !isDue(r, today));
  const overdue = due.reduce((sum, r) => sum + owed(r), 0);
  const lateFees = due.reduce((sum, r) => sum + owedFee(r), 0);
  const principalLeft = future.reduce((sum, r) => sum + owedPrincipal(r), 0);

  let accrued = 0;
  if (future.length) {
    const next = future[0];
    const previous = rows.find((r) => r.installment_number === next.installment_number - 1);
    const start = previous?.due_date ?? loan.disbursed_on ?? today;
    const span = dayNumber(next.due_date) - dayNumber(start);
    const elapsed = Math.max(0, dayNumber(today) - dayNumber(start));
    const accruedTotal = span > 0 ? Math.floor((next.interest_minor * Math.min(elapsed, span)) / span) : next.interest_minor;
    accrued = Math.max(0, Math.min(owedInterest(next), accruedTotal - next.interest_paid_minor));
  }
  const futureInterest = future.reduce((sum, r) => sum + owedInterest(r), 0);
  return {
    as_of: today,
    overdue_minor: overdue,
    late_fees_minor: lateFees,
    principal_left_minor: principalLeft,
    interest_to_date_minor: accrued,
    total_minor: overdue + principalLeft + accrued,
    interest_saved_minor: futureInterest - accrued,
  };
}

// An empty allocation for a row, and adding to it.
function allocator() {
  const byRow = new Map();
  const of = (r) => {
    if (!byRow.has(r.schedule_id)) byRow.set(r.schedule_id, { row: r, fee: 0, interest: 0, principal: 0, waived: 0 });
    return byRow.get(r.schedule_id);
  };
  return { of, list: () => [...byRow.values()] };
}

/**
 * Splits `amount` across the installments (it must be less than the payoff
 * total; a payoff goes through allocatePayoff). Returns the allocations;
 * `rows` are updated to match.
 */
export function allocate(rows, amount, today) {
  const a = allocator();
  let left = amount;
  const take = (r, part, field, max) => {
    const n = Math.min(left, max);
    if (n <= 0) return;
    a.of(r)[part] += n;
    r[field] += n;
    left -= n;
  };
  const open = unpaid(rows);
  const due = open.filter((r) => isDue(r, today));
  const future = open.filter((r) => !isDue(r, today));

  for (const r of due) take(r, "fee", "late_fee_paid_minor", owedFee(r));
  for (const r of due) {
    take(r, "interest", "interest_paid_minor", owedInterest(r));
    take(r, "principal", "principal_paid_minor", owedPrincipal(r));
  }
  // paid early: this month's installment first
  if (future.length) {
    take(future[0], "interest", "interest_paid_minor", owedInterest(future[0]));
    take(future[0], "principal", "principal_paid_minor", owedPrincipal(future[0]));
  }
  // beyond that: the last installments' principal, waiving their interest in proportion
  for (const r of [...future.slice(1)].reverse()) {
    if (left <= 0) break;
    const principalBefore = owedPrincipal(r);
    const interestBefore = owedInterest(r);
    const paid = Math.min(left, principalBefore);
    if (paid <= 0) continue;
    a.of(r).principal += paid;
    r.principal_paid_minor += paid;
    left -= paid;
    const waive = paid === principalBefore ? interestBefore : Math.floor((interestBefore * paid) / principalBefore);
    a.of(r).waived += waive;
    r.interest_waived_minor += waive;
  }
  if (left !== 0) throw new Error(`Repayment allocation left ${left} unallocated.`);
  return a.list();
}

/** Pays everything in `quote` (from payoffQuote): later interest is waived. */
export function allocatePayoff(rows, quote, today) {
  const a = allocator();
  const open = unpaid(rows);
  const future = open.filter((r) => !isDue(r, today));
  for (const r of open.filter((x) => isDue(x, today))) {
    const s = a.of(r);
    s.fee = owedFee(r);
    s.interest = owedInterest(r);
    s.principal = owedPrincipal(r);
    r.late_fee_paid_minor = r.late_fee_minor;
    r.interest_paid_minor = r.interest_minor - r.interest_waived_minor;
    r.principal_paid_minor = r.principal_minor;
  }
  future.forEach((r, i) => {
    const s = a.of(r);
    const interestOwed = owedInterest(r);
    s.principal = owedPrincipal(r);
    s.interest = i === 0 ? quote.interest_to_date_minor : 0;
    s.waived = interestOwed - s.interest;
    r.principal_paid_minor = r.principal_minor;
    r.interest_paid_minor += s.interest;
    r.interest_waived_minor += s.waived;
  });
  return a.list();
}

/**
 * Posts one repayment of `amountMinor` from `sourceAccountId` and applies
 * it. `kind`: "repayment", "payoff" or "auto_debit". Inside the caller's DB
 * transaction, with the loan and schedule locked (lockLoan, lockSchedule).
 */
export async function postRepayment(client, { loan, rows, sourceAccountId, amountMinor, kind, idempotencyKey, holdingAccountId }) {
  const quote = payoffQuote(loan, rows, loan.today);
  const allocations = kind === "payoff" ? allocatePayoff(rows, quote, loan.today) : allocate(rows, amountMinor, loan.today);
  const total = allocations.reduce((sum, x) => sum + x.fee + x.interest + x.principal, 0);
  if (total !== amountMinor) throw new Error(`Allocated ${total}, expected ${amountMinor}.`);

  const description = { repayment: "Loan repayment", payoff: "Loan paid off", auto_debit: "Automatic loan repayment" }[kind];
  const txn = await postTransaction(client, {
    transactionType: "loan_repayment",
    senderAccountId: sourceAccountId,
    receiverAccountId: holdingAccountId,
    amountMinor,
    currencyCode: loan.currency_code,
    description,
    idempotencyKey,
    loanId: loan.loan_id,
  });

  // the installments' new state
  for (const { row: r } of allocations) {
    const settled = owed(r) === 0;
    await client.query(
      `UPDATE loan_repayment_schedule
       SET principal_paid_minor = $2, interest_paid_minor = $3, interest_waived_minor = $4, late_fee_paid_minor = $5,
           paid_flag = $6, paid_at = CASE WHEN $6 THEN COALESCE(paid_at, NOW()) END,
           paid_transaction_id = CASE WHEN $6 THEN COALESCE(paid_transaction_id, $7::uuid) END
       WHERE schedule_id = $1`,
      [r.schedule_id, r.principal_paid_minor, r.interest_paid_minor, r.interest_waived_minor, r.late_fee_paid_minor, settled, txn.transaction_id],
    );
    r.paid_flag = settled;
  }

  const balance = unpaid(rows).reduce((sum, r) => sum + owed(r), 0);
  const overdueLeft = unpaid(rows).some((r) => r.due_date < loan.today);
  const status = balance === 0 ? "repaid" : loan.loan_status === "defaulted" && !overdueLeft ? "active" : loan.loan_status;
  await client.query(
    `UPDATE loans SET balance_remaining_minor = $2, loan_status = $3::loan_status_enum,
            defaulted_at = CASE WHEN $3::loan_status_enum = 'defaulted' THEN defaulted_at END
     WHERE loan_id = $1`,
    [loan.loan_id, balance, status],
  );
  if (status !== loan.loan_status) {
    await writeAudit(client, {
      actorId: kind === "auto_debit" ? null : loan.user_id,
      entityType: "loan",
      entityId: loan.loan_id,
      action: "status_change",
      before: { loan_status: loan.loan_status },
      after: { loan_status: status },
    });
  }

  await client.query(
    `INSERT INTO loan_payments (transaction_id, loan_id, kind, amount_minor, balance_after_minor)
     VALUES ($1, $2, $3, $4, $5)`,
    [txn.transaction_id, loan.loan_id, kind, amountMinor, balance],
  );
  for (const x of allocations) {
    await client.query(
      `INSERT INTO loan_payment_allocations
          (transaction_id, schedule_id, late_fee_minor, interest_minor, principal_minor, interest_waived_minor)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [txn.transaction_id, x.row.schedule_id, x.fee, x.interest, x.principal, x.waived],
    );
  }
  return txn;
}

/** Checks the amount against what's allowed, before any money moves. */
export function checkRepaymentAmount(amountMinor, quote, minMinor) {
  if (amountMinor > quote.total_minor) {
    throw new ValidationError({
      message: "That's more than the loan needs.",
      details: { amount_minor: [`Paying ${quote.total_minor} clears this loan today; that's the most you can pay.`] },
    });
  }
  const smallest = Math.min(minMinor, quote.total_minor);
  if (amountMinor < smallest) {
    throw new ValidationError({ details: { amount_minor: [`Pay at least ${smallest}.`] } });
  }
}

/** The response for a repayment, rebuilt from what was committed (so a replay matches). */
export async function paymentResponse(db, transactionId) {
  const result = await db.query(
    `SELECT p.transaction_id, p.loan_id, p.kind, p.amount_minor, p.balance_after_minor, t.status, l.loan_status,
            COALESCE(sum(a.late_fee_minor), 0)::bigint AS late_fees_minor,
            COALESCE(sum(a.interest_minor), 0)::bigint AS interest_minor,
            COALESCE(sum(a.principal_minor), 0)::bigint AS principal_minor,
            COALESCE(sum(a.interest_waived_minor), 0)::bigint AS interest_waived_minor,
            COALESCE(array_agg(s.installment_number ORDER BY s.installment_number)
                     FILTER (WHERE s.paid_transaction_id = p.transaction_id), '{}') AS installments_completed
     FROM loan_payments p
     JOIN transactions t ON t.transaction_id = p.transaction_id
     JOIN loans l ON l.loan_id = p.loan_id
     LEFT JOIN loan_payment_allocations a ON a.transaction_id = p.transaction_id
     LEFT JOIN loan_repayment_schedule s ON s.schedule_id = a.schedule_id
     WHERE p.transaction_id = $1
     GROUP BY p.transaction_id, t.status, l.loan_status`,
    [transactionId],
  );
  const r = result.rows[0];
  const completed = r.installments_completed;
  return {
    transaction_id: r.transaction_id,
    loan_id: r.loan_id,
    kind: r.kind,
    amount_minor: r.amount_minor,
    status: r.status,
    applied: {
      late_fees_minor: r.late_fees_minor,
      interest_minor: r.interest_minor,
      principal_minor: r.principal_minor,
      interest_waived_minor: r.interest_waived_minor,
    },
    installments_completed: completed,
    // kept for older clients: the last installment this payment finished
    schedule_installment_marked_paid: completed.length ? completed[completed.length - 1] : null,
    new_balance_remaining_minor: r.balance_after_minor,
    loan_status: r.loan_status,
  };
}
