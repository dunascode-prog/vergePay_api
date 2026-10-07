// Payees and pay runs as the payroll page needs them
// (db/migrations.db/payroll.sql). Totals and "last paid" are worked out from
// the payments on read, so they always match the ledger.

// $1 is the paying customer's user_id. The wallet holder's name is the one
// a name lookup would show (GET /v1/accounts/lookup).
export const PAYEE_SELECT = `
    SELECT p.payee_id, p.name, p.role, p.pay_type, p.frequency, p.rate_minor, p.currency_code, p.payee_status,
           p.account_id, a.account_number, a.account_status AS wallet_status,
           COALESCE(NULLIF(concat_ws(' ', holder.first_name, holder.last_name), ''), holder.username) AS account_name,
           s.payment_count, s.total_paid_minor, s.last_paid_at, s.last_paid_minor,
           CASE
             WHEN s.last_paid_at IS NULL OR p.frequency = 'one_off' THEN NULL
             WHEN p.frequency = 'monthly'
               THEN to_char(((s.last_paid_at AT TIME ZONE me.timezone)::date + interval '1 month')::date, 'YYYY-MM-DD')
             ELSE to_char((s.last_paid_at AT TIME ZONE me.timezone)::date + 14, 'YYYY-MM-DD')
           END AS next_pay_date,
           (NOW() AT TIME ZONE me.timezone)::date::text AS today,
           p.created_at, p.updated_at
    FROM payees p
    JOIN account a ON a.account_id = p.account_id
    JOIN users holder ON holder.user_id = a.user_id
    JOIN users me ON me.user_id = p.user_id
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS payment_count,
             COALESCE(sum(pp.amount_minor), 0)::bigint AS total_paid_minor,
             max(pp.created_at) AS last_paid_at,
             (SELECT pp2.amount_minor FROM payroll_payments pp2
              WHERE pp2.payee_id = p.payee_id ORDER BY pp2.created_at DESC LIMIT 1) AS last_paid_minor
      FROM payroll_payments pp WHERE pp.payee_id = p.payee_id
    ) s
    WHERE p.user_id = $1`;

// Due: an active payee never paid yet, or a regular one whose next date has come.
export function shapePayee({ today, ...row }) {
  const isDue =
    row.payee_status === "active" &&
    (row.payment_count === 0 || (row.next_pay_date !== null && row.next_pay_date <= today));
  return { ...row, is_due: isDue };
}

export async function loadPayees(db, userId, where = "", params = [], tail = "ORDER BY lower(p.name), p.created_at") {
  const result = await db.query(`${PAYEE_SELECT} ${where} ${tail}`, [userId, ...params]);
  return result.rows.map(shapePayee);
}

export async function loadPayee(db, userId, payeeId) {
  const [payee] = await loadPayees(db, userId, "AND p.payee_id = $2", [payeeId]);
  return payee ?? null;
}

// One payee's payments, newest first, with the wallet each was paid from.
export async function payeePayments(db, payeeId, limit = 50) {
  const result = await db.query(
    `SELECT pp.payment_id, pp.run_id, pp.amount_minor, pp.transaction_id, r.currency_code, r.note,
            r.source_account_id, src.purpose AS source_purpose, pp.created_at
     FROM payroll_payments pp
     JOIN payroll_runs r ON r.run_id = pp.run_id
     JOIN account src ON src.account_id = r.source_account_id
     WHERE pp.payee_id = $1
     ORDER BY pp.created_at DESC
     LIMIT $2`,
    [payeeId, limit],
  );
  return result.rows;
}

// $1 is the paying customer's user_id.
const RUN_SELECT = `
    SELECT r.run_id, r.source_account_id, src.purpose AS source_purpose, r.currency_code,
           r.total_minor, r.payment_count, r.note, r.created_at,
           COALESCE((
             SELECT json_agg(json_build_object(
                      'payment_id', pp.payment_id, 'payee_id', pp.payee_id, 'payee_name', p.name,
                      'amount_minor', pp.amount_minor, 'transaction_id', pp.transaction_id)
                    ORDER BY lower(p.name))
             FROM payroll_payments pp JOIN payees p ON p.payee_id = pp.payee_id
             WHERE pp.run_id = r.run_id
           ), '[]'::json) AS payments
    FROM payroll_runs r
    JOIN account src ON src.account_id = r.source_account_id
    WHERE r.user_id = $1`;

export async function loadRuns(db, userId, where = "", params = [], tail = "ORDER BY r.created_at DESC LIMIT 50") {
  const result = await db.query(`${RUN_SELECT} ${where} ${tail}`, [userId, ...params]);
  return result.rows;
}

export async function loadRun(db, userId, runId) {
  const [run] = await loadRuns(db, userId, "AND r.run_id = $2", [runId], "");
  return run ?? null;
}
