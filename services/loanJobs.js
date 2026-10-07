import { pool } from "../db/connectDB.js";
import { withTransaction } from "../db/withTransaction.js";
import env from "../env.js";
import logger from "../logger.js";
import { writeAudit } from "../utils/audit.js";
import { postOnce } from "./ledger.js";
import { dueNow, lockLoan, lockSchedule, postRepayment } from "./loanRepayments.js";
import { formatMoney, recordUserNotification } from "./notifications.js";

// The worker's loan job (worker.js, every LOAN_JOB_INTERVAL_MS). In order:
//
//   1. auto-debit   loans with auto_debit on and something due: take the
//                   whole amount due from the loan's wallet, once a day per
//                   loan, or nothing at all if the wallet can't cover it
//   2. late fees    an installment still unpaid when its grace period has
//                   passed gets its one-off late fee
//   3. defaults     a loan with an installment more than defaultAfterDays
//                   overdue is defaulted (it's cured by the payment that
//                   catches it up, in services/loanRepayments.js)
//
// "Today" is always the borrower's. Each loan is handled in its own DB
// transaction with its row locked, so a run can't race a borrower's payment.

async function holdingAccountId(db, currency) {
  const result = await db.query(`SELECT account_id FROM account WHERE account_number = $1 AND is_system`, [`SYS-LOAN-${currency}`]);
  return result.rows[0].account_id;
}

// Loans with something due today and no collection attempt yet today.
async function loansToCollect(userId) {
  const result = await pool.query(
    `SELECT l.loan_id
     FROM loans l
     JOIN account acc ON acc.account_id = l.account_id
     JOIN users u ON u.user_id = acc.user_id
     CROSS JOIN LATERAL (SELECT (NOW() AT TIME ZONE u.timezone)::date AS today) d
     WHERE l.auto_debit AND l.loan_status IN ('active', 'defaulted')
       AND (l.auto_debit_last_attempt_on IS NULL OR l.auto_debit_last_attempt_on < d.today)
       AND ($1::uuid IS NULL OR acc.user_id = $1)
       AND EXISTS (SELECT 1 FROM loan_repayment_schedule s
                   WHERE s.loan_id = l.loan_id AND NOT s.paid_flag AND s.due_date <= d.today)`,
    [userId],
  );
  return result.rows.map((r) => r.loan_id);
}

/** One loan's collection attempt for its borrower's today. Returns "collected", "short" or "skipped". */
export async function collectLoan(loanId) {
  let outcome = "skipped";
  // The key is the loan, the borrower's day and the oldest installment due,
  // so two workers running together collect it once, and a later
  // installment due the same day is still its own collection.
  const found = (await pool.query(
    `SELECT (NOW() AT TIME ZONE u.timezone)::date::text AS today,
            (SELECT min(s.installment_number) FROM loan_repayment_schedule s
             WHERE s.loan_id = l.loan_id AND NOT s.paid_flag) AS oldest_due
     FROM loans l JOIN account acc ON acc.account_id = l.account_id JOIN users u ON u.user_id = acc.user_id
     WHERE l.loan_id = $1`,
    [loanId],
  )).rows[0];
  if (!found?.oldest_due) return outcome;
  const idempotencyKey = `loan-auto:${loanId}:${found.today}:${found.oldest_due}`;

  await postOnce(idempotencyKey, async (client) => {
    const loan = await lockLoan(client, loanId);
    if (!loan || !loan.auto_debit || !["active", "defaulted"].includes(loan.loan_status)) return null;
    if (loan.auto_debit_last_attempt_on && loan.auto_debit_last_attempt_on >= loan.today) return null;
    const rows = await lockSchedule(client, loanId);
    const amount = dueNow(rows, loan.today);
    if (amount === 0) return null;

    await client.query(`UPDATE loans SET auto_debit_last_attempt_on = $2 WHERE loan_id = $1`, [loanId, loan.today]);
    const wallet = await client.query(
      `SELECT account_status, balance_minor FROM account WHERE account_id = $1 FOR UPDATE`,
      [loan.account_id],
    );
    const w = wallet.rows[0];
    if (w.account_status !== "active" || w.balance_minor < amount) {
      outcome = "short";
      // tell them, but not every day
      const recent = loan.auto_debit_last_alert_at &&
        Date.now() - new Date(loan.auto_debit_last_alert_at).getTime() < env.loans.autoDebitAlertEveryDays * 86_400_000;
      if (!recent) {
        await client.query(`UPDATE loans SET auto_debit_last_alert_at = NOW() WHERE loan_id = $1`, [loanId]);
        await recordUserNotification(client, loan.user_id, {
          kind: "loan_payment_missed",
          title: `We couldn't collect your loan payment of ${formatMoney(amount, loan.currency_code)}`,
          body: w.account_status !== "active"
            ? `Your wallet is ${w.account_status}. Pay from another wallet to avoid late fees.`
            : `Add money to your wallet, or pay from another one. We'll try again tomorrow.`,
        });
      }
      return null;
    }
    outcome = "collected";
    return postRepayment(client, {
      loan,
      rows,
      sourceAccountId: loan.account_id,
      amountMinor: amount,
      kind: "auto_debit",
      idempotencyKey,
      holdingAccountId: await holdingAccountId(client, loan.currency_code),
    });
  }, (existing) => existing.loan_id === loanId && existing.transaction_type === "loan_repayment");
  return outcome;
}

// Installments past their grace period with no late fee yet.
async function chargeLateFees(userId) {
  const due = await pool.query(
    `SELECT s.schedule_id, s.loan_id
     FROM loan_repayment_schedule s
     JOIN loans l ON l.loan_id = s.loan_id
     JOIN account acc ON acc.account_id = l.account_id
     JOIN users u ON u.user_id = acc.user_id
     WHERE NOT s.paid_flag AND s.late_fee_charged_at IS NULL
       AND l.loan_status IN ('active', 'defaulted')
       -- loans older than these rules: only installments due since they went live
       AND s.due_date >= l.rules_from
       AND s.due_date + $1::int < (NOW() AT TIME ZONE u.timezone)::date
       AND ($2::uuid IS NULL OR acc.user_id = $2)`,
    [env.loans.graceDays, userId],
  );
  let charged = 0;
  for (const { schedule_id: scheduleId, loan_id: loanId } of due.rows) {
    const done = await withTransaction(async (client) => {
      const loan = await lockLoan(client, loanId);
      const row = await client.query(
        `SELECT installment_number, installment_amount_minor, paid_flag, late_fee_charged_at
         FROM loan_repayment_schedule WHERE schedule_id = $1 FOR UPDATE`,
        [scheduleId],
      );
      const r = row.rows[0];
      if (!loan || r.paid_flag || r.late_fee_charged_at) return false;
      const fee = Math.max(env.loans.lateFeeMinMinor, Math.ceil((r.installment_amount_minor * env.loans.lateFeeBps) / 10_000));
      await client.query(
        `UPDATE loan_repayment_schedule SET late_fee_minor = late_fee_minor + $2, late_fee_charged_at = NOW() WHERE schedule_id = $1`,
        [scheduleId, fee],
      );
      await client.query(`UPDATE loans SET balance_remaining_minor = balance_remaining_minor + $2 WHERE loan_id = $1`, [loanId, fee]);
      await writeAudit(client, {
        actorId: null,
        entityType: "loan",
        entityId: loanId,
        action: "update",
        after: { late_fee_minor: fee, installment_number: r.installment_number },
      });
      await recordUserNotification(client, loan.user_id, {
        kind: "loan_late_fee",
        title: `Late fee of ${formatMoney(fee, loan.currency_code)} added to your loan`,
        body: `Installment ${r.installment_number} is ${env.loans.graceDays}+ days overdue. Pay now to avoid your loan going into default.`,
      });
      return true;
    });
    if (done) charged += 1;
  }
  return charged;
}

// Active loans with an installment more than defaultAfterDays overdue.
async function markDefaults(userId) {
  const found = await pool.query(
    `SELECT l.loan_id
     FROM loans l
     JOIN account acc ON acc.account_id = l.account_id
     JOIN users u ON u.user_id = acc.user_id
     WHERE l.loan_status = 'active'
       AND EXISTS (SELECT 1 FROM loan_repayment_schedule s
                   WHERE s.loan_id = l.loan_id AND NOT s.paid_flag
                     -- for older loans the clock starts when the rules went live
                     AND GREATEST(s.due_date, l.rules_from) + $1::int < (NOW() AT TIME ZONE u.timezone)::date)
       AND ($2::uuid IS NULL OR acc.user_id = $2)`,
    [env.loans.defaultAfterDays, userId],
  );
  let defaulted = 0;
  for (const { loan_id: loanId } of found.rows) {
    const done = await withTransaction(async (client) => {
      const loan = await lockLoan(client, loanId);
      if (!loan || loan.loan_status !== "active") return false;
      await client.query(`UPDATE loans SET loan_status = 'defaulted', defaulted_at = NOW() WHERE loan_id = $1`, [loanId]);
      await writeAudit(client, {
        actorId: null,
        entityType: "loan",
        entityId: loanId,
        action: "status_change",
        before: { loan_status: "active" },
        after: { loan_status: "defaulted" },
      });
      await recordUserNotification(client, loan.user_id, {
        kind: "loan_defaulted",
        title: "Your loan is in default",
        body: `A payment is more than ${env.loans.defaultAfterDays} days overdue. Catch up to bring it back to normal; until then you can't take a new loan.`,
      });
      return true;
    });
    if (done) defaulted += 1;
  }
  return defaulted;
}

/** One run of the loan job: every loan, or only `userId`'s (the dev endpoint). */
export async function runLoanJobs({ userId = null } = {}) {
  const result = { collected: 0, short: 0, late_fees: 0, defaulted: 0 };
  for (const loanId of await loansToCollect(userId)) {
    try {
      const outcome = await collectLoan(loanId);
      if (outcome === "collected") result.collected += 1;
      if (outcome === "short") result.short += 1;
    } catch (err) {
      logger.error({ message: "loan auto-debit failed", loanId, error: err.message });
    }
  }
  result.late_fees = await chargeLateFees(userId);
  result.defaulted = await markDefaults(userId);
  return result;
}
