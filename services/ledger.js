import { pool } from "../db/connectDB.js";
import { withTransaction } from "../db/withTransaction.js";
import { ConflictError, InsufficientFundsError, ValidationError } from "../utils/errorStr.js";
import { IdempotencyConflictError } from "../utils/idempotency.js";

// The ledger-posting routine (data model 7.1). Every movement of money, be it
// a transfer, a top-up, a reversal, a loan payment or a card payment, goes
// through here, inside the caller's DB transaction (pass the client from
// withTransaction) so that everything below commits or rolls back together:
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
//
// postTransaction does all six at once. Money that settles later, a card
// charge waiting on the payment processor, is split in two: step 3 with
// createPendingTransaction when it starts, the rest with
// settlePendingTransaction once the processor confirms (API doc 10.2: for
// card payments the ledger is written on settlement, not at initiation).

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
    card_id,
    processor_tx_ref,
    processor_transaction_id,
    failure_reason,
    created_at,
    settled_at`;

// The fields a transfer-style response shows.
export function publicTransaction(txn) {
  const {
    transaction_id,
    transaction_type,
    sender_account_id,
    receiver_account_id,
    amount_minor,
    currency_code,
    status,
    description,
    created_at,
    settled_at,
  } = txn;
  return {
    transaction_id,
    transaction_type,
    sender_account_id,
    receiver_account_id,
    amount_minor,
    currency_code,
    status,
    description,
    created_at,
    settled_at,
  };
}

// Steps 1 and 2.
async function lockAndCheckAccounts(client, { senderAccountId, receiverAccountId, amountMinor, currencyCode }) {
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
  return { sender, receiver };
}

// Step 3.
async function insertPending(
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
    cardId = null,
    processorTxRef = null,
    processorTransactionId = null,
  },
) {
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
        loan_id,
        card_id,
        processor_tx_ref,
        processor_transaction_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, $10, $11, $12)
     RETURNING ${TRANSACTION_COLUMNS}`,
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
      cardId,
      processorTxRef,
      processorTransactionId,
    ],
  );
  return inserted.rows[0];
}

// Steps 4 to 6, for a pending transaction whose accounts are already locked
// and checked.
async function writeEntriesAndSettle(client, txn, sender, receiver) {
  const { transaction_id: transactionId, amount_minor: amountMinor, currency_code: currencyCode } = txn;
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
      sender.account_id,
      receiver.account_id,
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
    [sender.account_id, receiver.account_id, senderBalanceAfter, receiverBalanceAfter],
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

// Posts a transaction that settles immediately: all six steps.
export async function postTransaction(client, params) {
  const { sender, receiver } = await lockAndCheckAccounts(client, params);
  const pending = await insertPending(client, params);
  return writeEntriesAndSettle(client, pending, sender, receiver);
}

// Step 3 only: records money that is on its way (a card charge sent to the
// payment processor). No ledger entries and no balance change until
// settlePendingTransaction. Takes the same params as postTransaction.
export async function createPendingTransaction(client, params) {
  return insertPending(client, params);
}

// Loads and locks a transaction row, so settling and failing it can't race.
async function lockTransaction(client, transactionId) {
  const result = await client.query(
    `SELECT ${TRANSACTION_COLUMNS} FROM transactions WHERE transaction_id = $1 FOR UPDATE`,
    [transactionId],
  );
  return result.rows[0] ?? null;
}

// Steps 1, 2 and 4 to 6 for a pending transaction, once the processor has
// confirmed it. Settling one that is no longer pending changes nothing and
// returns it with alreadyFinal = true, so repeated confirmations (webhook
// retries, a client polling) are harmless.
export async function settlePendingTransaction(client, transactionId, { processorTransactionId = null } = {}) {
  const txn = await lockTransaction(client, transactionId);
  if (!txn) throw new Error(`Transaction ${transactionId} not found.`);
  if (txn.status !== "pending") return { ...txn, alreadyFinal: true };

  if (processorTransactionId && !txn.processor_transaction_id) {
    await client.query(
      `UPDATE transactions SET processor_transaction_id = $2 WHERE transaction_id = $1`,
      [transactionId, processorTransactionId],
    );
  }
  const { sender, receiver } = await lockAndCheckAccounts(client, {
    senderAccountId: txn.sender_account_id,
    receiverAccountId: txn.receiver_account_id,
    amountMinor: txn.amount_minor,
    currencyCode: txn.currency_code,
  });
  const settled = await writeEntriesAndSettle(client, txn, sender, receiver);
  return { ...settled, alreadyFinal: false };
}

// Marks a pending transaction failed, with the reason. No ledger rows ever
// existed for it, so there is nothing to undo.
export async function failPendingTransaction(client, transactionId, reason, { processorTransactionId = null } = {}) {
  const txn = await lockTransaction(client, transactionId);
  if (!txn) throw new Error(`Transaction ${transactionId} not found.`);
  if (txn.status !== "pending") return { ...txn, alreadyFinal: true };

  const result = await client.query(
    `UPDATE transactions
     SET status = 'failed',
         failure_reason = $2,
         processor_transaction_id = COALESCE(processor_transaction_id, $3)
     WHERE transaction_id = $1
     RETURNING ${TRANSACTION_COLUMNS}`,
    [transactionId, reason?.slice(0, 255) ?? null, processorTransactionId],
  );
  return { ...result.rows[0], alreadyFinal: false };
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
