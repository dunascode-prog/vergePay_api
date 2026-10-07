import { pool } from "../db/connectDB.js";
import { withTransaction } from "../db/withTransaction.js";
import logger from "../logger.js";
import { ServiceUnavailableError } from "../utils/errorStr.js";
import * as flutterwave from "./flutterwave.js";
import { postTransaction } from "./ledger.js";

// Withdrawals to bank accounts (db/migrations.db/withdrawals.sql has the
// money flow). The wallet is debited when the withdrawal is accepted, so the
// money can't be spent twice while Flutterwave sends it; a transfer that
// fails gives everything back, fee included.
//
// Flutterwave's word is only taken from its API (GET /transfers/:id), never
// from a webhook body, the same rule as for card payments.

/**
 * Flutterwave's fee for a transfer of `amountMinor`, split between the
 * customer and VergePay. The customer pays half, rounded down to the kobo,
 * so they never pay more than half; VergePay covers the rest.
 */
export async function quoteFee(amountMinor, currency = "NGN") {
  const feeMajor = await flutterwave.transferFee(amountMinor, currency);
  const exactMinor = feeMajor * 100; // may have a fraction of a kobo
  const processorFeeMinor = Math.round(exactMinor);
  const customerFeeMinor = Math.min(processorFeeMinor, Math.floor(exactMinor / 2));
  return {
    processor_fee_minor: processorFeeMinor,
    customer_fee_minor: customerFeeMinor,
    vergepay_fee_minor: processorFeeMinor - customerFeeMinor,
  };
}

export async function systemAccountId(db, prefix, currency) {
  const result = await db.query(`SELECT account_id FROM account WHERE account_number = $1 AND is_system`, [
    `${prefix}-${currency}`,
  ]);
  return result.rows[0].account_id;
}

const WITHDRAWAL_COLUMNS = `
    w.withdrawal_id, w.user_id, w.account_id, w.bank_account_id, w.currency_code,
    w.amount_minor, w.processor_fee_minor, w.customer_fee_minor, w.narration, w.status,
    w.reference, w.processor_transfer_id, w.transaction_id, w.fee_transaction_id,
    w.failure_reason, w.created_at, w.completed_at,
    b.bank_code, b.bank_name, b.account_number AS bank_account_number, b.account_name AS bank_account_name`;

export async function loadWithdrawal(db, withdrawalId, { lock = false } = {}) {
  const result = await db.query(
    `SELECT ${WITHDRAWAL_COLUMNS}
     FROM withdrawals w JOIN bank_accounts b ON b.bank_account_id = w.bank_account_id
     WHERE w.withdrawal_id = $1 ${lock ? "FOR UPDATE OF w" : ""}`,
    [withdrawalId],
  );
  return result.rows[0] ?? null;
}

// What the customer sees: no internal transaction ids or our user id.
export function publicWithdrawal(w) {
  return {
    withdrawal_id: w.withdrawal_id,
    account_id: w.account_id,
    bank_account_id: w.bank_account_id,
    bank_name: w.bank_name,
    bank_account_number: w.bank_account_number,
    bank_account_name: w.bank_account_name,
    currency_code: w.currency_code,
    amount_minor: w.amount_minor,
    fee_minor: w.customer_fee_minor,
    total_debited_minor: w.amount_minor + w.customer_fee_minor,
    narration: w.narration,
    status: w.status,
    reference: w.reference,
    failure_reason: w.failure_reason,
    created_at: w.created_at,
    completed_at: w.completed_at,
  };
}

// The transfer arrived: the money has left VergePay's Flutterwave balance,
// and Flutterwave took its whole fee. Inside the caller's DB transaction,
// with the withdrawal locked and still pending.
async function markPaid(client, w) {
  const payout = await systemAccountId(client, "SYS-PAYOUT", w.currency_code);
  const clearing = await systemAccountId(client, "SYS-FLW", w.currency_code);
  await postTransaction(client, {
    transactionType: "withdrawal",
    senderAccountId: payout,
    receiverAccountId: clearing,
    amountMinor: w.amount_minor,
    currencyCode: w.currency_code,
    description: `Paid out: withdrawal ${w.reference}`,
    idempotencyKey: `withdrawal-paid:${w.withdrawal_id}`,
  });
  if (w.processor_fee_minor > 0) {
    await postTransaction(client, {
      transactionType: "fee",
      senderAccountId: await systemAccountId(client, "SYS-FEES", w.currency_code),
      receiverAccountId: clearing,
      amountMinor: w.processor_fee_minor,
      currencyCode: w.currency_code,
      description: `Flutterwave transfer fee: withdrawal ${w.reference}`,
      idempotencyKey: `withdrawal-processor-fee:${w.withdrawal_id}`,
    });
  }
  await client.query(`UPDATE withdrawals SET status = 'successful', completed_at = NOW() WHERE withdrawal_id = $1`, [
    w.withdrawal_id,
  ]);
}

// The transfer failed: the amount and the customer's fee go back to the
// wallet, as refunds of the original transactions.
async function markFailed(client, w, reason) {
  await postTransaction(client, {
    transactionType: "refund",
    senderAccountId: await systemAccountId(client, "SYS-PAYOUT", w.currency_code),
    receiverAccountId: w.account_id,
    amountMinor: w.amount_minor,
    currencyCode: w.currency_code,
    description: `Withdrawal to ${w.bank_name} failed`,
    idempotencyKey: `withdrawal-refund:${w.withdrawal_id}`,
    reversesTransactionId: w.transaction_id,
  });
  const reversed = [w.transaction_id];
  if (w.fee_transaction_id) {
    await postTransaction(client, {
      transactionType: "refund",
      senderAccountId: await systemAccountId(client, "SYS-FEES", w.currency_code),
      receiverAccountId: w.account_id,
      amountMinor: w.customer_fee_minor,
      currencyCode: w.currency_code,
      description: "Withdrawal fee returned",
      idempotencyKey: `withdrawal-fee-refund:${w.withdrawal_id}`,
      reversesTransactionId: w.fee_transaction_id,
    });
    reversed.push(w.fee_transaction_id);
  }
  await client.query(`UPDATE transactions SET status = 'reversed' WHERE transaction_id = ANY($1::uuid[])`, [reversed]);
  await client.query(
    `UPDATE withdrawals SET status = 'failed', failure_reason = $2, completed_at = NOW() WHERE withdrawal_id = $1`,
    [w.withdrawal_id, (reason || "The bank transfer failed.").slice(0, 255)],
  );
}

// Applies an outcome to a withdrawal that is still pending. Two checks
// arriving together (a webhook and a sync) can't both apply it: the row is
// locked and re-read first.
async function settle(withdrawalId, outcome, reason) {
  return withTransaction(async (client) => {
    const w = await loadWithdrawal(client, withdrawalId, { lock: true });
    if (!w || w.status !== "pending") return w?.status ?? null;
    if (outcome === "successful") await markPaid(client, w);
    else await markFailed(client, w, reason);
    return outcome;
  });
}

/**
 * Asks Flutterwave to send a pending withdrawal. Called right after the
 * customer's request commits, and again by syncWithdrawal when a first
 * attempt never got an answer (same reference, so it can't pay twice).
 */
export async function submitWithdrawal(withdrawalId) {
  const w = await loadWithdrawal(pool, withdrawalId);
  if (!w || w.status !== "pending" || w.processor_transfer_id) return w?.status ?? null;
  try {
    const transfer = await flutterwave.createTransfer({
      bankCode: w.bank_code,
      accountNumber: w.bank_account_number,
      amountMinor: w.amount_minor,
      currency: w.currency_code,
      narration: w.narration || "VergePay withdrawal",
      reference: w.reference,
    });
    await pool.query(
      `UPDATE withdrawals SET processor_transfer_id = $2 WHERE withdrawal_id = $1 AND processor_transfer_id IS NULL`,
      [w.withdrawal_id, String(transfer.id)],
    );
    if (String(transfer.status).toUpperCase() === "FAILED") {
      return settle(w.withdrawal_id, "failed", transfer.complete_message);
    }
    return "pending";
  } catch (err) {
    // No answer, or Flutterwave is down: the outcome is unknown, so the money
    // stays held and the sync tries again later.
    if (err instanceof ServiceUnavailableError) {
      logger.error({ message: "withdrawal not sent yet", withdrawalId, error: err.message });
      return "pending";
    }
    // Flutterwave already has a transfer with this reference: a first attempt
    // got through but its answer was lost. Leave it held for a person to
    // match up, rather than guess.
    if (/reference/i.test(err.message) && /(exist|duplicate|already)/i.test(err.message)) {
      logger.error({ message: "withdrawal reference already used at Flutterwave; needs review", withdrawalId });
      return "pending";
    }
    // Refused outright (bad account, insufficient platform balance, ...).
    return settle(w.withdrawal_id, "failed", err.message);
  }
}

/** Brings a pending withdrawal up to date with Flutterwave. Safe to call any number of times. */
export async function syncWithdrawal(withdrawalId) {
  const w = await loadWithdrawal(pool, withdrawalId);
  if (!w || w.status !== "pending") return w?.status ?? null;
  if (!w.processor_transfer_id) return submitWithdrawal(withdrawalId);

  let transfer;
  try {
    transfer = await flutterwave.getTransfer(w.processor_transfer_id);
  } catch (err) {
    logger.error({ message: "withdrawal sync failed", withdrawalId, error: err.message });
    return "pending";
  }
  // the transfer must be the one we sent
  if (transfer.reference !== w.reference) {
    logger.error({ message: "withdrawal transfer reference mismatch", withdrawalId });
    return "pending";
  }
  const status = String(transfer.status).toUpperCase();
  if (status === "SUCCESSFUL") return settle(withdrawalId, "successful");
  if (status === "FAILED") return settle(withdrawalId, "failed", transfer.complete_message);
  return "pending";
}

/** For the worker: every withdrawal pending longer than `olderThanMs`. */
export async function syncPendingWithdrawals(olderThanMs = 120_000, limit = 100) {
  const pending = await pool.query(
    `SELECT withdrawal_id FROM withdrawals
     WHERE status = 'pending' AND created_at < NOW() - make_interval(secs => $1)
     ORDER BY created_at LIMIT $2`,
    [olderThanMs / 1000, limit],
  );
  const results = { checked: pending.rowCount, successful: 0, failed: 0 };
  for (const { withdrawal_id: id } of pending.rows) {
    const outcome = await syncWithdrawal(id);
    if (outcome === "successful") results.successful += 1;
    if (outcome === "failed") results.failed += 1;
  }
  return results;
}
