// A savings goal as the goals page needs it (db/migrations.db/goals.sql).
//
// What a goal has saved is its account's balance, and the totals below are
// worked out from its settled transactions on read, so they always agree
// with the ledger.

// $1 is the customer's user_id.
export const GOAL_SELECT = `
    SELECT g.goal_id, g.name, g.category, g.currency_code, g.target_minor,
           to_char(g.target_date, 'YYYY-MM-DD') AS target_date,
           g.goal_status, g.account_id, a.account_number,
           a.balance_minor AS saved_minor,
           s.contributed_minor, s.withdrawn_minor, s.contribution_count, s.last_contribution_at,
           g.created_at, g.updated_at, g.closed_at
    FROM goals g
    JOIN account a ON a.account_id = g.account_id
    CROSS JOIN LATERAL (
      SELECT COALESCE(sum(t.amount_minor) FILTER (WHERE t.receiver_account_id = g.account_id), 0)::bigint AS contributed_minor,
             COALESCE(sum(t.amount_minor) FILTER (WHERE t.sender_account_id = g.account_id), 0)::bigint AS withdrawn_minor,
             count(*) FILTER (WHERE t.receiver_account_id = g.account_id)::int AS contribution_count,
             max(t.created_at) FILTER (WHERE t.receiver_account_id = g.account_id) AS last_contribution_at
      FROM transactions t
      WHERE t.status = 'settled'
        AND (t.receiver_account_id = g.account_id OR t.sender_account_id = g.account_id)
    ) s
    WHERE g.user_id = $1`;

// Adds the figures the page shows next to the progress bar.
export function shapeGoal(row) {
  const remaining = Math.max(0, row.target_minor - row.saved_minor);
  return {
    ...row,
    remaining_minor: remaining,
    progress_percent: Math.min(100, Math.floor((row.saved_minor / row.target_minor) * 100)),
    is_funded: remaining === 0,
  };
}

// Goals matching `where` (extra SQL after "WHERE g.user_id = $1"), shaped.
export async function loadGoals(db, userId, where = "", params = [], tail = "ORDER BY g.created_at") {
  const result = await db.query(`${GOAL_SELECT} ${where} ${tail}`, [userId, ...params]);
  return result.rows.map(shapeGoal);
}

export async function loadGoal(db, userId, goalId) {
  const [goal] = await loadGoals(db, userId, "AND g.goal_id = $2", [goalId]);
  return goal ?? null;
}

// The money in and out of a goal, newest first, with the goal's balance after
// each one and the wallet on the other side.
export async function goalActivity(db, accountId, limit = 100) {
  const result = await db.query(
    `SELECT t.transaction_id,
            CASE WHEN le.direction = 'CREDIT' THEN 'contribution' ELSE 'withdrawal' END AS kind,
            t.amount_minor, t.currency_code, le.running_balance_after_minor AS balance_after_minor,
            w.account_id AS wallet_account_id, w.purpose AS wallet_purpose,
            t.created_at
     FROM ledger_entries le
     JOIN transactions t ON t.transaction_id = le.transaction_id
     LEFT JOIN account w ON w.account_id =
         CASE WHEN le.direction = 'CREDIT' THEN t.sender_account_id ELSE t.receiver_account_id END
         AND NOT w.is_system
     WHERE le.account_id = $1
     ORDER BY le.created_at DESC, le.entry_id
     LIMIT $2`,
    [accountId, limit],
  );
  return result.rows;
}

// True when the account holds a goal's money. Such an account only moves
// money through the goal endpoints, and is closed by closing its goal.
export async function isGoalAccount(db, accountId) {
  const result = await db.query(`SELECT 1 FROM goals WHERE account_id = $1`, [accountId]);
  return result.rowCount > 0;
}
