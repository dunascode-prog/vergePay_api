import { INVOICE_SELECT, shapeInvoice } from "./invoices.js";
import { formatMoney } from "./notifications.js";

// A client as the clients page needs it: the profile, and their payment
// behaviour worked out from their invoices on read (so it's never stale).
//
// "Today" and lateness are counted in the customer's timezone, like overdue
// invoices elsewhere (services/invoices.js). Drafts don't count; refunded
// invoices count as invoices but not as revenue.

// $1 is the customer's user_id.
export const CLIENT_SELECT = `
    SELECT c.client_id, c.name, c.email, c.phone, c.contact_name, c.industry, c.location, c.notes, c.is_vip,
           c.archived_at, c.created_at, c.updated_at,
           s.invoice_count, s.open_count, s.overdue_count, s.paid_count, s.paid_on_time_count,
           s.avg_days_to_pay, s.avg_days_late, s.oldest_overdue_days,
           s.last_invoiced_at, s.last_paid_at,
           COALESCE((
             SELECT json_agg(json_build_object('currency_code', r.currency_code, 'amount_minor', r.amount_minor) ORDER BY r.currency_code)
             FROM (SELECT i.currency_code, sum(i.amount_due_minor)::bigint AS amount_minor
                   FROM invoices i WHERE i.client_id = c.client_id AND i.invoice_status = 'paid'
                   GROUP BY i.currency_code) r
           ), '[]'::json) AS revenue,
           COALESCE((
             SELECT json_agg(json_build_object('currency_code', o.currency_code, 'amount_minor', o.amount_minor) ORDER BY o.currency_code)
             FROM (SELECT i.currency_code, sum(i.amount_due_minor)::bigint AS amount_minor
                   FROM invoices i WHERE i.client_id = c.client_id AND i.invoice_status = 'open'
                   GROUP BY i.currency_code) o
           ), '[]'::json) AS outstanding,
           COALESCE((
             SELECT json_agg(json_build_object('currency_code', o.currency_code, 'amount_minor', o.amount_minor) ORDER BY o.currency_code)
             FROM (SELECT i.currency_code, sum(i.amount_due_minor)::bigint AS amount_minor
                   FROM invoices i WHERE i.client_id = c.client_id AND i.invoice_status = 'open' AND i.due_date < s.today
                   GROUP BY i.currency_code) o
           ), '[]'::json) AS overdue,
           COALESCE((
             SELECT json_agg(json_build_object(
                      'plan_id', p.plan_id, 'plan_status', p.plan_status, 'description', p.description,
                      'frequency', p.frequency, 'amount_minor', p.amount_minor, 'currency_code', p.currency_code,
                      'next_billing_date', CASE WHEN p.plan_status = 'cancelled' THEN NULL ELSE to_char(p.next_billing_date, 'YYYY-MM-DD') END)
                    ORDER BY (p.plan_status = 'active') DESC, p.created_at DESC)
             FROM recurring_plans p WHERE p.client_id = c.client_id
           ), '[]'::json) AS recurring_plans
    FROM clients c
    JOIN users u ON u.user_id = c.user_id
    CROSS JOIN LATERAL (
      SELECT (NOW() AT TIME ZONE u.timezone)::date AS today
    ) d
    CROSS JOIN LATERAL (
      SELECT d.today,
             count(*) FILTER (WHERE i.invoice_status <> 'draft')::int AS invoice_count,
             count(*) FILTER (WHERE i.invoice_status = 'open' AND i.due_date >= d.today)::int AS open_count,
             count(*) FILTER (WHERE i.invoice_status = 'open' AND i.due_date < d.today)::int AS overdue_count,
             count(*) FILTER (WHERE i.invoice_status = 'paid')::int AS paid_count,
             count(*) FILTER (WHERE i.invoice_status = 'paid'
                                AND (i.paid_at AT TIME ZONE u.timezone)::date <= i.due_date)::int AS paid_on_time_count,
             round(avg(EXTRACT(EPOCH FROM i.paid_at - COALESCE(i.sent_at, i.created_at)) / 86400)
                   FILTER (WHERE i.invoice_status = 'paid'))::int AS avg_days_to_pay,
             round(avg(GREATEST(0, (i.paid_at AT TIME ZONE u.timezone)::date - i.due_date))
                   FILTER (WHERE i.invoice_status = 'paid'), 1)::float AS avg_days_late,
             max(d.today - i.due_date) FILTER (WHERE i.invoice_status = 'open' AND i.due_date < d.today) AS oldest_overdue_days,
             max(i.sent_at) AS last_invoiced_at,
             max(i.paid_at) FILTER (WHERE i.invoice_status = 'paid') AS last_paid_at
      FROM invoices i WHERE i.client_id = c.client_id
    ) s`;

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * How reliably a client pays, 0–100, with the reasons in words. A client
 * with nothing paid and nothing overdue has no score yet ("new").
 *
 *   60%  paying on time: of the invoices that have come due (paid or now
 *        overdue), the share paid by their due date
 *   25%  how late: full marks at 0 days late on average, none at 30+
 *   15%  what's overdue now: the share of their invoices past due
 *
 * Any invoice more than 30 days overdue caps the score at 49 (at risk).
 */
export function clientHealth(row) {
  const paid = row.paid_count;
  const overdue = row.overdue_count;
  if (paid === 0 && overdue === 0) {
    return {
      score: null,
      label: "new",
      reasons: [row.open_count ? `${plural(row.open_count, "invoice")} sent, none due yet` : "No invoices paid yet"],
    };
  }
  // an invoice still unpaid past its due date counts as not on time
  const onTime = row.paid_on_time_count / (paid + overdue);
  const speed = paid ? Math.max(0, 1 - (row.avg_days_late ?? 0) / 30) : 0;
  const billed = paid + row.open_count + overdue;
  const overdueShare = billed ? overdue / billed : 0;
  let score = Math.round(100 * (0.6 * onTime + 0.25 * speed + 0.15 * (1 - overdueShare)));
  if ((row.oldest_overdue_days ?? 0) > 30) score = Math.min(score, 49);

  const reasons = [];
  if (overdue) {
    const amounts = row.overdue.map((o) => formatMoney(o.amount_minor, o.currency_code)).join(" + ");
    reasons.push(`${plural(overdue, "invoice")} overdue (${amounts}), the oldest by ${plural(row.oldest_overdue_days, "day")}`);
  }
  if (paid) {
    // of the invoices that have come due, like the score
    reasons.push(`Paid ${row.paid_on_time_count} of ${paid + overdue} on time`);
    if (row.avg_days_late > 0) reasons.push(`${row.avg_days_late} days late on average`);
    if (row.avg_days_to_pay !== null) {
      reasons.push(row.avg_days_to_pay === 0 ? "Usually pays the day the invoice is sent" : `Usually pays within ${plural(row.avg_days_to_pay, "day")} of the invoice`);
    }
  }
  return { score, label: score >= 80 ? "reliable" : score >= 55 ? "watch" : "at_risk", reasons };
}

export function shapeClient(row) {
  const { today: _today, ...rest } = row;
  return { ...rest, health: clientHealth(row) };
}

export async function loadClients(db, userId, where = "", params = [], tail = "") {
  const result = await db.query(`${CLIENT_SELECT} WHERE c.user_id = $1 ${where} ${tail}`, [userId, ...params]);
  return result.rows.map(shapeClient);
}

/** A client's latest invoices (not drafts), newest first, without items. */
export async function clientInvoices(db, userId, clientId, limit = 20) {
  const result = await db.query(
    `${INVOICE_SELECT} WHERE i.client_id = $2 AND i.issuer_user_id = $1 AND i.invoice_status <> 'draft'
     ORDER BY i.created_at DESC LIMIT $3`,
    [userId, clientId, limit],
  );
  return result.rows.map((row) => {
    const { items: _items, ...invoice } = shapeInvoice(row, []);
    return invoice;
  });
}
