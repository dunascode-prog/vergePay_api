import { LOAN_WITH_PROGRESS } from "../../controllers/loanController.js";
import { loadClients } from "../clients.js";
import { loadGoals, shapeGoal } from "../goals.js";
import { payoffQuote } from "../loanRepayments.js";
import { loadPayees, loadRuns } from "../payroll.js";
import { localDate } from "./periods.js";

// Everything the assistant and the recommendations look at, for one
// customer, loaded at once with a few queries. The answers are worked out
// from this in plain code, so every figure comes from the database.

// Money others paid in counts as revenue; card top-ups, loan payouts and
// refunds don't (the same rule as the UI's lib/analytics.ts).
const REVENUE_TYPES = new Set(["invoice_payment", "transfer", "bank_deposit", "payroll_payment"]);

export const SPEND_LABEL = {
  transfer: "Sent to others",
  invoice_payment: "Invoices you paid",
  loan_repayment: "Loan repayments",
  payroll_payment: "Payroll",
  withdrawal: "Withdrawn to banks",
  fee: "Fees",
  card_payment: "Card payments",
};

export async function loadSnapshot(db, userId) {
  const user = (
    await db.query(
      `SELECT user_id, username, first_name, timezone, kyc_status, two_factor_enabled,
              (NOW() AT TIME ZONE timezone)::date::text AS today
       FROM users WHERE user_id = $1`,
      [userId],
    )
  ).rows[0];
  if (!user) return null;

  const [accounts, invoices, clients, payees, runs, goals, loans, plans, moves] = await Promise.all([
    db.query(
      `SELECT a.account_id, a.account_number, a.account_type, a.purpose, a.currency_code, a.balance_minor, a.account_status, a.created_at,
              EXISTS (SELECT 1 FROM goals g WHERE g.account_id = a.account_id) AS is_goal
       FROM account a WHERE a.user_id = $1 AND NOT a.is_system`,
      [userId],
    ),
    db.query(
      `SELECT i.invoice_id, i.invoice_number, i.amount_due_minor, i.currency_code,
              to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
              CASE WHEN i.invoice_status = 'open' AND i.due_date < $2::date THEN 'overdue' ELSE i.invoice_status::text END AS status,
              i.sent_at, i.paid_at, i.created_at, i.cancelled_at, i.refunded_at, i.recurring_plan_id,
              c.client_id,
              COALESCE(c.name, NULLIF(concat_ws(' ', bu.first_name, bu.last_name), ''), bu.username) AS client_name,
              COALESCE(c.client_id::text, 'user:' || bu.user_id::text, i.invoice_id::text) AS payer_key,
              (SELECT max(e.created_at) FROM email_log e WHERE e.invoice_id = i.invoice_id AND e.kind = 'reminder') AS last_reminder_at
       FROM invoices i
       LEFT JOIN clients c ON c.client_id = i.client_id
       LEFT JOIN account ba ON ba.account_id = i.account_id AND i.client_id IS NULL
       LEFT JOIN users bu ON bu.user_id = ba.user_id
       WHERE i.issuer_user_id = $1`,
      [userId, user.today],
    ),
    loadClients(db, userId, "AND c.archived_at IS NULL"),
    loadPayees(db, userId),
    loadRuns(db, userId, "", [], "ORDER BY r.created_at DESC LIMIT 1000"),
    loadGoals(db, userId, "AND g.goal_status = 'active'"),
    db.query(`${LOAN_WITH_PROGRESS} WHERE acc.user_id = $1 AND l.loan_status IN ('active', 'defaulted') ORDER BY l.created_at`, [userId]),
    db.query(
      `SELECT p.plan_id, p.description, p.amount_minor, p.currency_code, p.frequency, p.plan_status,
              to_char(p.next_billing_date, 'YYYY-MM-DD') AS next_billing_date, p.last_error, c.name AS client_name
       FROM recurring_plans p JOIN clients c ON c.client_id = p.client_id
       WHERE p.user_id = $1 AND p.plan_status <> 'cancelled'`,
      [userId],
    ),
    // money that moved in or out of the customer's accounts, about 13 months back
    db.query(
      `SELECT t.transaction_id, t.transaction_type::text AS type, t.status::text AS status, t.amount_minor, t.currency_code,
              t.created_at, t.sender_account_id, t.receiver_account_id,
              sa.account_number AS sender_number, ra.account_number AS receiver_number,
              sa.user_id AS sender_user_id, ra.user_id AS receiver_user_id
       FROM transactions t
       LEFT JOIN account sa ON sa.account_id = t.sender_account_id
       LEFT JOIN account ra ON ra.account_id = t.receiver_account_id
       WHERE (sa.user_id = $1 OR ra.user_id = $1)
         AND t.status IN ('settled', 'reversed')
         AND t.created_at > NOW() - interval '400 days'`,
      [userId],
    ),
  ]);

  // what paying each loan off today would cost (the same quote as the loan page)
  const schedules = new Map();
  if (loans.rows.length) {
    const rows = await db.query(
      `SELECT loan_id, schedule_id, installment_number, to_char(due_date, 'YYYY-MM-DD') AS due_date,
              installment_amount_minor, principal_minor, interest_minor,
              principal_paid_minor, interest_paid_minor, interest_waived_minor,
              late_fee_minor, late_fee_paid_minor, paid_flag
       FROM loan_repayment_schedule WHERE loan_id = ANY($1) ORDER BY loan_id, installment_number`,
      [loans.rows.map((l) => l.loan_id)],
    );
    for (const r of rows.rows) schedules.set(r.loan_id, [...(schedules.get(r.loan_id) ?? []), r]);
  }
  for (const loan of loans.rows) {
    const rows = schedules.get(loan.loan_id) ?? [];
    const disbursedOn = loan.disbursed_at ? localDate(loan.disbursed_at, user.timezone) : null;
    loan.payoff = rows.length ? payoffQuote({ ...loan, disbursed_on: disbursedOn }, rows, user.today) : null;
  }

  const own = new Set(accounts.rows.map((a) => a.account_id));
  // the wallets the app shows (lib/ledger.ts walletsOf): the oldest open
  // personal and business current accounts
  const oldest = (purpose) =>
    accounts.rows
      .filter((a) => a.account_type === "current" && a.purpose === purpose && a.account_status !== "closed" && !a.is_goal)
      .sort((a, b) => a.created_at - b.created_at)[0];
  const wallets = [oldest("personal"), oldest("business")].filter(Boolean);

  return {
    user,
    today: user.today,
    wallets,
    invoices: invoices.rows,
    drafts: invoices.rows.filter((i) => i.status === "draft"),
    clients,
    payees,
    runs,
    goals: goals.map((g) => (g.remaining_minor === undefined ? shapeGoal(g) : g)),
    loans: loans.rows,
    plans: plans.rows,
    flows: toFlows(moves.rows, own, user.timezone),
  };
}

// a withdrawal or its fee that bounced back, or the refund of one, moved nothing
const undone = (t) =>
  (t.status === "reversed" && (t.type === "withdrawal" || t.type === "fee")) || (t.type === "refund" && (t.sender_number ?? "").startsWith("SYS-"));

/**
 * Each move as money in or out of the customer's own accounts. Moves
 * between their own accounts (wallets and goals) are neither.
 */
export function toFlows(rows, own, timeZone) {
  const flows = [];
  for (const t of rows) {
    if (undone(t) || t.type.startsWith("goal_")) continue;
    const fromMe = own.has(t.sender_account_id);
    const toMe = own.has(t.receiver_account_id);
    if (fromMe === toMe) continue; // internal, or not the customer's at all
    const direction = toMe ? "in" : "out";
    flows.push({
      id: t.transaction_id,
      direction,
      type: t.type,
      amount_minor: Number(t.amount_minor),
      currency: t.currency_code,
      date: localDate(t.created_at, timeZone),
      is_revenue: direction === "in" && REVENUE_TYPES.has(t.type),
      category: direction === "out" ? SPEND_LABEL[t.type] ?? "Other" : null,
    });
  }
  return flows;
}
