import { pool } from "../db/connectDB.js";
import { withTransaction } from "../db/withTransaction.js";
import { ConflictError, InsufficientFundsError, ValidationError } from "../utils/errorStr.js";
import { IdempotencyConflictError } from "../utils/idempotency.js";

// The ledger-posting routine (data model 7.1). Every movement of money, be it
// a transfer, a top-up, a reversal or a loan payment, goes through
// postTransaction, and it must run inside the caller's DB transaction (pass
// the client from withTransaction) so that everything below commits or rolls
// back together:
//
//   1. lock both accounts, always in account_id order, so two opposite
//      transfers (A->B and B->A) can't deadlock
//   2. check both accounts can take part and the sender can afford it
//   3. insert the TRANSACTION row as pending
//   4. insert one DEBIT and one CREDIT ledger entry with running balances
//   5. update both cached balances
//   6. mark the transaction settled
//
// The row locks mean a concurrent posting against either account waits for
// this one, then re-reads the updated balance, so money can't be spent twice.

const TRANSACTION_COLUMNS = `
    transaction_id,
    transaction_type,
    sender_account_id,
    receiver_account_id,
    amount_minor,
    currency_code,
    status,
    description,
    reverses_transaction_id,
    loan_id,
    created_at,
    settled_at`;

export async function postTransaction(
  client,
  {
    transactionType,
    senderAccountId,
    receiverAccountId,
    amountMinor,
    currencyCode,
    description = null,
    idempotencyKey,
    reversesTransactionId = null,
    loanId = null,
  },
) {
  const locked = await client.query(
    `SELECT account_id, account_status, currency_code, balance_minor, is_system
     FROM account
     WHERE account_id = ANY($1::uuid[])
     ORDER BY account_id
     FOR UPDATE`,
    [[senderAccountId, receiverAccountId]],
  );
  const sender = locked.rows.find((a) => a.account_id === senderAccountId);
  const receiver = locked.rows.find((a) => a.account_id === receiverAccountId);

  if (!sender || !receiver) {
    throw new ValidationError({
      message: "Account not found.",
      details: { [sender ? "receiver_account_id" : "sender_account_id"]: ["Account not found."] },
    });
  }
  // A frozen account can still receive money but can't send it (API doc 4.5).
  if (sender.account_status !== "active") {
    throw new ConflictError({
      message: `The sending account is ${sender.account_status} and can't send money.`,
    });
  }
  if (receiver.account_status === "closed") {
    throw new ConflictError({
      message: "The receiving account is closed and can't receive money.",
    });
  }
  // Cross-currency movement needs an FX step, not a mismatched ledger row.
  if (sender.currency_code !== currencyCode || receiver.currency_code !== currencyCode) {
    throw new ValidationError({
      message: "Currency mismatch.",
      details: {
        currency_code: [
          `Both accounts must hold ${currencyCode}. Currency conversion isn't supported yet.`,
        ],
      },
    });
  }
  if (!sender.is_system && sender.balance_minor < amountMinor) {
    throw new InsufficientFundsError({
      message: `Account balance (${sender.balance_minor}) is less than the requested debit (${amountMinor}).`,
    });
  }

  const inserted = await client.query(
    `INSERT INTO transactions (
        idempotency_key,
        transaction_type,
        sender_account_id,
        receiver_account_id,
        amount_minor,
        currency_code,
        status,
        description,
        reverses_transaction_id,
        loan_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9)
     RETURNING transaction_id`,
    [
      idempotencyKey,
      transactionType,
      senderAccountId,
      receiverAccountId,
      amountMinor,
      currencyCode,
      description,
      reversesTransactionId,
      loanId,
    ],
  );
  const transactionId = inserted.rows[0].transaction_id;

  const senderBalanceAfter = sender.balance_minor - amountMinor;
  const receiverBalanceAfter = receiver.balance_minor + amountMinor;

  const entries = await client.query(
    `INSERT INTO ledger_entries (
        account_id,
        transaction_id,
        direction,
        amount_minor,
        currency_code,
        running_balance_after_minor
     )
     VALUES
        ($1, $3, 'DEBIT',  $4, $5, $6),
        ($2, $3, 'CREDIT', $4, $5, $7)
     RETURNING entry_id, account_id, direction, amount_minor, running_balance_after_minor`,
    [
      senderAccountId,
      receiverAccountId,
      transactionId,
      amountMinor,
      currencyCode,
      senderBalanceAfter,
      receiverBalanceAfter,
    ],
  );

  await client.query(
    `UPDATE account
     SET balance_minor = CASE account_id WHEN $1 THEN $3::bigint ELSE $4::bigint END,
         updated_at = NOW()
     WHERE account_id IN ($1, $2)`,
    [senderAccountId, receiverAccountId, senderBalanceAfter, receiverBalanceAfter],
  );

  const settled = await client.query(
    `UPDATE transactions
     SET status = 'settled', settled_at = NOW()
     WHERE transaction_id = $1
     RETURNING ${TRANSACTION_COLUMNS}`,
    [transactionId],
  );

  return { ...settled.rows[0], ledger_entries: entries.rows };
}

// The idempotency middleware stores a response only after the DB commit, so
// a crash in that gap (or a request slower than the middleware's stale
// window) lets a retry reach postTransaction again. The UNIQUE
// transactions.idempotency_key then rejects the duplicate and its DB
// transaction rolls back, so money never moves twice. These two helpers let
// the caller turn that rejection into a normal replay of the original.
function isDuplicateIdempotencyKey(err) {
  return err.code === "23505" && err.constraint === "transactions_idempotency_key_key";
}

async function findTransactionByIdempotencyKey(db, idempotencyKey) {
  const result = await db.query(
    `SELECT ${TRANSACTION_COLUMNS} FROM transactions WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return result.rows[0] ?? null;
}

// Runs work(client) in a DB transaction and returns the transaction it
// posted. If an earlier attempt with the same key already committed, returns
// that one instead with replayed = true, but only if isSameRequest(existing)
// confirms it was the same operation; a key reused for something else -> 422.
//
// The lookup happens before work runs, so a retry is answered with the
// original result even when re-running the checks would now fail (the money
// has already left, or the transfer is already reversed). The unique-key
// fallback covers two attempts that race past the lookup together.
export async function postOnce(idempotencyKey, work, isSameRequest) {
  const replay = async () => {
    const existing = await findTransactionByIdempotencyKey(pool, idempotencyKey);
    if (!existing) return null;
    if (!(await isSameRequest(existing))) throw new IdempotencyConflictError();
    return { transaction: existing, replayed: true };
  };

  const earlier = await replay();
  if (earlier) return earlier;

  try {
    return { transaction: await withTransaction(work), replayed: false };
  } catch (err) {
    if (!isDuplicateIdempotencyKey(err)) throw err;
    const raced = await replay();
    if (!raced) throw err;
    return raced;
  }
}
