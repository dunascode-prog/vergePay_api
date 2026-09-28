import { pool } from "../db/connectDB.js";
import { withTransaction } from "../db/withTransaction.js";
import logger from "../logger.js";
import AppError from "../utils/appError.js";
import { writeAudit } from "../utils/audit.js";
import * as flutterwave from "./flutterwave.js";
import { failPendingTransaction, postTransaction, settlePendingTransaction } from "./ledger.js";

// Turns a payment-processor outcome into ledger movements. Both the webhook
// and a client's "sync" call end up here, so whichever arrives first does
// the work and the other finds it already done.
//
// The rule throughout: a webhook body or a redirect's query string is only
// a hint. Value is given only on what Flutterwave's verify endpoint says,
// and only if the reference, currency and amount match what we asked for.

// The processor clearing account for a currency (processor.sql).
export async function clearingAccountId(db, currencyCode) {
  const result = await db.query(
    `SELECT account_id FROM account WHERE account_number = $1 AND is_system`,
    [`SYS-FLW-${currencyCode}`],
  );
  return result.rows[0]?.account_id ?? null;
}

// Flutterwave reports the network in card.type, e.g. "MASTERCARD".
function providerName(cardType = "") {
  const type = cardType.toUpperCase();
  if (type.includes("MASTER")) return "Mastercard";
  if (type.includes("VISA")) return "Visa";
  if (type.includes("VERVE")) return "Verve";
  if (type.includes("AMERICAN") || type.includes("AMEX")) return "American Express";
  return cardType.trim() || "Unknown";
}

async function providerId(client, name) {
  await client.query(
    `INSERT INTO card_providers (provider_name) VALUES ($1) ON CONFLICT (provider_name) DO NOTHING`,
    [name],
  );
  const result = await client.query(`SELECT provider_id FROM card_providers WHERE provider_name = $1`, [name]);
  return result.rows[0].provider_id;
}

// "09/32" -> { month: 9, year: 2032 }
function parseExpiry(expiry = "") {
  const match = /^(\d{1,2})\/(\d{2,4})$/.exec(expiry.trim());
  if (!match) return null;
  const month = Number(match[1]);
  const year = match[2].length === 2 ? 2000 + Number(match[2]) : Number(match[2]);
  return month >= 1 && month <= 12 ? { month, year } : null;
}

// Saves the card from a verified card-link payment, inside the settling DB
// transaction. Returns { cardId } or { failure }.
async function attachLinkedCard(client, link, verified, txn) {
  const card = verified.card;
  const expiry = parseExpiry(card?.expiry);
  if (!card?.token || !/^\d{6}$/.test(card.first_6digits ?? "") || !/^\d{4}$/.test(card.last_4digits ?? "") || !expiry) {
    return { failure: "The processor didn't return a reusable card for this payment." };
  }

  const existing = await client.query(
    `SELECT c.card_id, c.account_id FROM cards c WHERE c.card_token = $1`,
    [card.token],
  );
  if (existing.rows[0]) {
    return existing.rows[0].account_id === link.account_id
      ? { cardId: existing.rows[0].card_id }
      : { failure: "This card is already linked to another account." };
  }

  const holder = await client.query(
    `SELECT email, NULLIF(concat_ws(' ', first_name, last_name), '') AS name FROM users WHERE user_id = $1`,
    [link.user_id],
  );
  // Flutterwave returns no name on the card itself, and its customer name
  // isn't reliable (the sandbox fills in the merchant's), so use our own
  // profile name.
  const cardholderName = (holder.rows[0].name || verified.customer?.name || holder.rows[0].email).slice(0, 100);

  const inserted = await client.query(
    `INSERT INTO cards (
        account_id, provider_id, card_token, pan_bin, pan_last_four,
        cardholder_name, expiry_month, expiry_year, card_status,
        processor, processor_customer_email, issuer
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', 'flutterwave', $9, $10)
     RETURNING card_id`,
    [
      link.account_id,
      await providerId(client, providerName(card.type)),
      card.token,
      card.first_6digits,
      card.last_4digits,
      cardholderName,
      expiry.month,
      expiry.year,
      verified.customer?.email || holder.rows[0].email,
      card.issuer?.trim().replace(/s+/g, " ").slice(0, 100) || null,
    ],
  );
  const cardId = inserted.rows[0].card_id;
  await client.query(`INSERT INTO card_controls (card_id) VALUES ($1)`, [cardId]);
  await client.query(`UPDATE transactions SET card_id = $2 WHERE transaction_id = $1`, [
    txn.transaction_id,
    cardId,
  ]);
  await writeAudit(client, {
    actorId: link.user_id,
    entityType: "card",
    entityId: cardId,
    action: "create",
    after: {
      account_id: link.account_id,
      pan_bin: card.first_6digits,
      pan_last_four: card.last_4digits,
      provider: providerName(card.type),
    },
  });
  return { cardId };
}

// Checks a verified processor result against the transaction we created.
function mismatch(txn, verified) {
  if (verified.tx_ref !== txn.processor_tx_ref) return "reference mismatch";
  if (verified.currency !== txn.currency_code) return `currency mismatch (${verified.currency})`;
  if (flutterwave.toMinor(verified.amount) !== txn.amount_minor) {
    return `amount mismatch (${verified.amount} ${verified.currency})`;
  }
  return null;
}

// Re-checks one of our pending card payments with Flutterwave and settles
// or fails it. Safe to call any number of times. Returns the transaction's
// current state and, for a card link, the link.
export async function syncCardPayment(transactionId) {
  const found = await pool.query(
    `SELECT transaction_id, status, processor_tx_ref, processor_transaction_id,
            amount_minor, currency_code, transaction_type
     FROM transactions WHERE transaction_id = $1`,
    [transactionId],
  );
  const txn = found.rows[0];
  if (!txn || txn.transaction_type !== "card_payment" || !txn.processor_tx_ref) return null;
  if (txn.status !== "pending") return currentState(transactionId);

  let verified;
  try {
    verified = txn.processor_transaction_id
      ? await flutterwave.verifyTransaction(txn.processor_transaction_id)
      : await flutterwave.verifyByReference(txn.processor_tx_ref);
  } catch (err) {
    // Not paid yet (the customer hasn't finished checkout) looks like this;
    // it stays pending and can be synced again later.
    if (err instanceof flutterwave.ProcessorError) return currentState(transactionId);
    throw err;
  }

  const problem = mismatch(txn, verified);
  if (problem) {
    logger.error({ message: "processor result doesn't match our transaction", transactionId, problem });
  }

  await withTransaction(async (client) => {
    const processorTransactionId = verified.id != null ? String(verified.id) : null;
    const linkRow = await client.query(`SELECT * FROM card_links WHERE transaction_id = $1 FOR UPDATE`, [
      transactionId,
    ]);
    const link = linkRow.rows[0];

    if (problem || verified.status === "failed") {
      const reason = problem ?? `Declined by the processor: ${verified.processor_response ?? "failed"}`;
      const failed = await failPendingTransaction(client, transactionId, reason, { processorTransactionId });
      if (link && !failed.alreadyFinal) {
        await client.query(
          `UPDATE card_links SET status = 'failed', failure_reason = $2, completed_at = NOW() WHERE card_link_id = $1`,
          [link.card_link_id, reason.slice(0, 255)],
        );
      }
      return;
    }
    if (verified.status !== "successful") return; // still pending at the processor

    let settled;
    try {
      settled = await settlePendingTransaction(client, transactionId, { processorTransactionId });
    } catch (err) {
      // The account can't take the money any more (closed since the charge
      // started). The account checks throw before any write, so this DB
      // transaction is still usable: record it as failed for a manual
      // refund rather than leaving it pending forever.
      if (!(err instanceof AppError)) throw err;
      const reason = `Paid at the processor but not credited: ${err.message} Needs a manual refund.`;
      logger.error({ message: "card payment needs manual refund", transactionId, reason });
      await failPendingTransaction(client, transactionId, reason, { processorTransactionId });
      if (link) {
        await client.query(
          `UPDATE card_links SET status = 'failed', failure_reason = $2, completed_at = NOW() WHERE card_link_id = $1`,
          [link.card_link_id, reason.slice(0, 255)],
        );
      }
      return;
    }
    if (settled.alreadyFinal || !link) return;

    const { cardId, failure } = await attachLinkedCard(client, link, verified, settled);
    await client.query(
      `UPDATE card_links
       SET status = $2, card_id = $3, failure_reason = $4, completed_at = NOW()
       WHERE card_link_id = $1`,
      [link.card_link_id, cardId ? "linked" : "failed", cardId ?? null, failure ?? null],
    );
  });

  return currentState(transactionId);
}

async function currentState(transactionId) {
  const result = await pool.query(
    `SELECT t.transaction_id, t.transaction_type, t.status, t.amount_minor, t.currency_code,
            t.receiver_account_id AS account_id, t.card_id, t.failure_reason, t.settled_at,
            l.card_link_id, l.status AS card_link_status, l.card_id AS linked_card_id,
            l.failure_reason AS card_link_failure_reason
     FROM transactions t
     LEFT JOIN card_links l ON l.transaction_id = t.transaction_id
     WHERE t.transaction_id = $1`,
    [transactionId],
  );
  return result.rows[0] ?? null;
}

// Credits a bank transfer into a virtual account, after verifying it with
// Flutterwave. Keyed on Flutterwave's transaction id, so a repeated webhook
// credits nothing twice. Returns "credited", "duplicate" or a reason it
// wasn't credited.
export async function creditBankDeposit(processorTransactionId, virtualAccount) {
  const verified = await flutterwave.verifyTransaction(processorTransactionId);
  if (verified.status !== "successful") return `not successful (${verified.status})`;
  if (verified.tx_ref !== virtualAccount.processor_tx_ref) return "reference mismatch";
  if (verified.currency !== "NGN") return `unsupported currency ${verified.currency}`;
  const amountMinor = flutterwave.toMinor(verified.amount);
  if (!(amountMinor > 0)) return "no amount";

  const already = await pool.query(`SELECT 1 FROM transactions WHERE processor_transaction_id = $1`, [
    String(verified.id),
  ]);
  if (already.rowCount > 0) return "duplicate";

  const sender = verified.meta_data?.originatorname
    ? ` from ${verified.meta_data.originatorname}${verified.meta_data.bankname ? ` (${verified.meta_data.bankname})` : ""}`
    : "";
  try {
    await withTransaction(async (client) =>
      postTransaction(client, {
        transactionType: "bank_deposit",
        senderAccountId: await clearingAccountId(client, "NGN"),
        receiverAccountId: virtualAccount.account_id,
        amountMinor,
        currencyCode: "NGN",
        description: `Bank transfer${sender}`.slice(0, 255),
        idempotencyKey: `flw:${verified.id}`,
        processorTransactionId: String(verified.id),
      }),
    );
  } catch (err) {
    if (err.code === "23505") return "duplicate";
    throw err;
  }
  return "credited";
}
