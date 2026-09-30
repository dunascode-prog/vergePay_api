import { generateAccountNumber } from "../utils/accountNumber.js";
import { writeAudit } from "../utils/audit.js";

export const ACCOUNT_COLUMNS = `
    account_id,
    account_type,
    purpose,
    account_number,
    currency_code,
    balance_minor,
    income_minor,
    total_savings_minor,
    account_status,
    created_at,
    updated_at`;

// Serialises account opening for one user, so two requests racing to open
// "the" personal wallet (or "the" investment wallet) can't both get one.
// Held until the surrounding transaction ends.
export async function lockUserForAccountOpening(client, userId) {
  await client.query(`SELECT 1 FROM users WHERE user_id = $1 FOR UPDATE`, [userId]);
}

// The user's open (not closed) account of this type and purpose, if any.
export async function findOpenAccount(client, userId, accountType, purpose = null) {
  const result = await client.query(
    `SELECT ${ACCOUNT_COLUMNS} FROM account
     WHERE user_id = $1 AND NOT is_system
       AND account_type = $2
       AND ($3::account_purpose_enum IS NULL OR purpose = $3::account_purpose_enum)
       AND account_status <> 'closed'
     ORDER BY created_at
     LIMIT 1`,
    [userId, accountType, purpose],
  );
  return result.rows[0] ?? null;
}

// Inserts an account with a fresh random number, inside the caller's
// transaction. A number collision is possible but rare: each attempt runs in
// a savepoint so a clash can be retried without aborting the transaction.
export async function insertAccount(client, { userId, accountType, currencyCode, purpose }) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    await client.query("SAVEPOINT open_account");
    try {
      const result = await client.query(
        `INSERT INTO account (user_id, account_type, account_number, currency_code, purpose)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${ACCOUNT_COLUMNS}`,
        [userId, accountType, generateAccountNumber(), currencyCode, purpose],
      );
      await client.query("RELEASE SAVEPOINT open_account");
      const created = result.rows[0];
      await writeAudit(client, {
        actorId: userId,
        entityType: "account",
        entityId: created.account_id,
        action: "create",
        after: created,
      });
      return created;
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT open_account");
      const numberTaken = err.code === "23505" && err.constraint === "account_account_number_key";
      if (!numberTaken || attempt === 5) throw err;
    }
  }
}
