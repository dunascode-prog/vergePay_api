import crypto from "crypto";
import z from "zod";
import { pool } from "../db/connectDB.js";
import { withTransaction } from "../db/withTransaction.js";
import env from "../env.js";
import logger from "../logger.js";
import * as flutterwave from "../services/flutterwave.js";
import { createPendingTransaction, failPendingTransaction } from "../services/ledger.js";
import { clearingAccountId, syncCardPayment } from "../services/processorPayments.js";
import { writeAudit } from "../utils/audit.js";
import {
  BadRequestError,
  ConflictError,
  KycRequiredError,
  NotFoundError,
  ValidationError,
} from "../utils/errorStr.js";
import { IdempotencyConflictError } from "../utils/idempotency.js";
import { isUuid, validationDetails } from "../utils/validation.js";

// Cards (API doc 5) are debit cards a user links to fund their VergePay
// account, tokenized by Flutterwave. Our API never accepts, stores or
// returns a card number: the customer types it on Flutterwave's hosted
// checkout, and we keep only the processor's token plus the display-safe
// BIN, last four and expiry (data model 4.8).
//
// Linking (POST /v1/cards) differs from the doc's shape on purpose. The doc
// has the client send card_token; with Flutterwave the token only comes back
// to the server when it verifies a completed payment, and accepting a token
// from the client would let anyone attach a token they don't own. So adding
// a card returns a hosted-checkout link for a small charge (which tops up
// the account), and the verified payment attaches the card.
//
// Every charge is a card_payment transaction created pending; ledger entries
// are written only once Flutterwave confirms it (API doc 10.2), by the
// webhook or by POST /v1/transactions/:id/sync.

// ₦100 in kobo: the linking charge, credited to the account like any top-up.
const CARD_LINK_AMOUNT_MINOR = 10_000;
const MIN_CHARGE_MINOR = 10_000;
const MAX_CHARGE_MINOR = 1_000_000_000;
// Cards can fund NGN accounts only for now.
const CARD_CURRENCY = "NGN";

const linkSchema = z.strictObject({
  account_id: z.uuid(),
});

const chargeSchema = z.strictObject({
  amount_minor: z.number().int().min(MIN_CHARGE_MINOR).max(MAX_CHARGE_MINOR),
});

const controlsSchema = z
  .strictObject({
    daily_limit_minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    online_payments_enabled: z.boolean(),
    atm_withdrawals_enabled: z.boolean(),
  })
  .partial();

const listQuerySchema = z.strictObject({
  account_id: z.uuid().optional(),
});

function parseBody(schema, body) {
  if (!body || Object.keys(body).length === 0) {
    throw new BadRequestError({ message: "Request body is empty." });
  }
  const validation = schema.safeParse(body);
  if (!validation.success) {
    throw new ValidationError({ details: validationDetails(validation.error) });
  }
  return validation.data;
}

const cardNotFound = () => new NotFoundError({ message: "Card not found." });

async function requireVerifiedKyc(db, userId) {
  const result = await db.query(`SELECT kyc_status FROM users WHERE user_id = $1`, [userId]);
  if (result.rows[0]?.kyc_status !== "verified") throw new KycRequiredError();
}

// Display-safe fields only (API doc 5.2): never the token.
const CARD_SELECT = `
    SELECT c.card_id,
           c.account_id,
           p.provider_name,
           c.pan_bin,
           c.pan_last_four,
           c.cardholder_name,
           c.issuer,
           c.expiry_month,
           c.expiry_year,
           CASE WHEN c.card_status = 'active'
                 AND make_date(c.expiry_year, c.expiry_month, 1) + interval '1 month' <= CURRENT_DATE
                THEN 'expired'
                ELSE c.card_status::text
           END AS card_status,
           json_build_object(
             'daily_limit_minor', cc.daily_limit_minor,
             'online_payments_enabled', cc.online_payments_enabled,
             'atm_withdrawals_enabled', cc.atm_withdrawals_enabled,
             'updated_at', cc.updated_at
           ) AS controls,
           c.created_at
    FROM cards c
    JOIN card_providers p ON p.provider_id = c.provider_id
    JOIN account a ON a.account_id = c.account_id
    LEFT JOIN card_controls cc ON cc.card_id = c.card_id`;

async function findOwnCard(db, userId, cardId) {
  if (!isUuid(cardId)) throw cardNotFound();
  const result = await db.query(
    `${CARD_SELECT} WHERE c.card_id = $1 AND a.user_id = $2 AND c.card_status <> 'removed'`,
    [cardId, userId],
  );
  if (result.rowCount === 0) throw cardNotFound();
  return result.rows[0];
}

// Locks the card row for a status change or a charge.
async function lockOwnCard(client, userId, cardId) {
  if (!isUuid(cardId)) throw cardNotFound();
  const result = await client.query(
    `SELECT c.*, a.currency_code AS account_currency, a.account_status
     FROM cards c JOIN account a ON a.account_id = c.account_id
     WHERE c.card_id = $1 AND a.user_id = $2 AND c.card_status <> 'removed'
     FOR UPDATE OF c`,
    [cardId, userId],
  );
  if (result.rowCount === 0) throw cardNotFound();
  return result.rows[0];
}

// ---------------------------------------------------------------------------
// Linking

function linkResponse(row) {
  return {
    card_link_id: row.card_link_id,
    transaction_id: row.transaction_id,
    account_id: row.account_id,
    checkout_url: row.checkout_url,
    status: row.status,
    card_id: row.card_id,
    failure_reason: row.failure_reason,
    amount_minor: CARD_LINK_AMOUNT_MINOR,
    currency_code: CARD_CURRENCY,
  };
}

// POST /v1/cards  (User + 2FA, Idempotency-Key required)
export async function startCardLink(req, res) {
  const body = parseBody(linkSchema, req.body);
  const userId = req.user.sub;
  const idempotencyKey = `${userId}:${req.idempotencyKey}`;

  // A retry whose idempotency record was lost finds the link it created.
  const earlier = await pool.query(
    `SELECT l.* FROM card_links l JOIN transactions t ON t.transaction_id = l.transaction_id
     WHERE t.idempotency_key = $1`,
    [idempotencyKey],
  );
  if (earlier.rows[0]) {
    res.set("Idempotent-Replayed", "true");
    return res.status(202).json(linkResponse(earlier.rows[0]));
  }

  const { link, user } = await withTransaction(async (client) => {
    await requireVerifiedKyc(client, userId);
    const account = await client.query(
      `SELECT account_type, account_status, currency_code FROM account
       WHERE account_id = $1 AND user_id = $2 AND NOT is_system`,
      [body.account_id, userId],
    );
    const target = account.rows[0];
    if (!target) throw new ValidationError({ details: { account_id: ["Account not found."] } });
    if (!["current", "savings"].includes(target.account_type)) {
      throw new ValidationError({ details: { account_id: ["Cards can fund current or savings accounts only."] } });
    }
    if (target.account_status !== "active") {
      throw new ConflictError({ message: `The account is ${target.account_status}.` });
    }
    if (target.currency_code !== CARD_CURRENCY) {
      throw new ValidationError({ details: { account_id: [`Cards can fund ${CARD_CURRENCY} accounts only for now.`] } });
    }

    const txn = await createPendingTransaction(client, {
      transactionType: "card_payment",
      senderAccountId: await clearingAccountId(client, CARD_CURRENCY),
      receiverAccountId: body.account_id,
      amountMinor: CARD_LINK_AMOUNT_MINOR,
      currencyCode: CARD_CURRENCY,
      description: "Card linking payment",
      idempotencyKey,
      processorTxRef: `vp-${crypto.randomUUID()}`,
    });
    const inserted = await client.query(
      `INSERT INTO card_links (user_id, account_id, transaction_id)
       VALUES ($1, $2, $3) RETURNING *`,
      [userId, body.account_id, txn.transaction_id],
    );
    const user = await client.query(
      `SELECT email, NULLIF(concat_ws(' ', first_name, last_name), '') AS name FROM users WHERE user_id = $1`,
      [userId],
    );
    return { link: { ...inserted.rows[0], processor_tx_ref: txn.processor_tx_ref }, user: user.rows[0] };
  });

  // The hosted checkout is created after the commit, so a processor outage
  // can't hold a DB transaction open; if it fails, the link is failed.
  let checkout;
  try {
    checkout = await flutterwave.createPaymentLink({
      txRef: link.processor_tx_ref,
      amountMinor: CARD_LINK_AMOUNT_MINOR,
      currency: CARD_CURRENCY,
      redirectUrl: `${env.flutterwave.redirectUrl}?transaction_id=${link.transaction_id}`,
      customer: { email: user.email, name: user.name ?? undefined },
      title: "VergePay",
      description: "Link your card (₦100 is added to your account)",
      paymentOptions: "card",
    });
  } catch (err) {
    await withTransaction(async (client) => {
      await failPendingTransaction(client, link.transaction_id, `Checkout couldn't be created: ${err.message}`);
      await client.query(
        `UPDATE card_links SET status = 'failed', failure_reason = $2, completed_at = NOW() WHERE card_link_id = $1`,
        [link.card_link_id, "Checkout couldn't be created."],
      );
    });
    throw err;
  }

  const saved = await pool.query(
    `UPDATE card_links SET checkout_url = $2 WHERE card_link_id = $1 RETURNING *`,
    [link.card_link_id, checkout.link],
  );
  return res.status(202).json(linkResponse(saved.rows[0]));
}

// ---------------------------------------------------------------------------
// Viewing

// GET /v1/cards?account_id=
export async function listCards(req, res) {
  const validation = listQuerySchema.safeParse(req.query);
  if (!validation.success) {
    throw new ValidationError({ details: validationDetails(validation.error) });
  }
  const result = await pool.query(
    `${CARD_SELECT}
     WHERE a.user_id = $1 AND c.card_status <> 'removed'
       AND ($2::uuid IS NULL OR c.account_id = $2)
     ORDER BY c.created_at DESC`,
    [req.user.sub, validation.data.account_id ?? null],
  );
  return res.status(200).json({ data: result.rows });
}

// GET /v1/cards/:cardId
export async function getCard(req, res) {
  return res.status(200).json(await findOwnCard(pool, req.user.sub, req.params.cardId));
}

// ---------------------------------------------------------------------------
// Block, unblock, remove (API doc 5.3)

// Blocking is plain User auth so a lost card can be stopped in one tap;
// unblocking and removing need a recent 2FA code (see the routes).
const STATUS_ACTIONS = {
  block: { from: "active", to: "blocked", conflict: "Only an active card can be blocked." },
  unblock: { from: "blocked", to: "active", conflict: "This card isn't blocked." },
};

function changeCardStatus(action) {
  const { from, to, conflict } = STATUS_ACTIONS[action];
  return async function (req, res) {
    const userId = req.user.sub;
    await withTransaction(async (client) => {
      const card = await lockOwnCard(client, userId, req.params.cardId);
      if (card.card_status !== from) throw new ConflictError({ message: conflict });
      await client.query(
        `UPDATE cards SET card_status = $2, blocked_at = ${to === "blocked" ? "NOW()" : "NULL"}
         WHERE card_id = $1`,
        [card.card_id, to],
      );
      await writeAudit(client, {
        actorId: userId,
        entityType: "card",
        entityId: card.card_id,
        action: "status_change",
        before: { card_status: from },
        after: { card_status: to },
      });
    });
    return res.status(200).json(await findOwnCard(pool, userId, req.params.cardId));
  };
}

export const blockCard = changeCardStatus("block");
export const unblockCard = changeCardStatus("unblock");

// DELETE /v1/cards/:cardId
// The row stays (transactions reference it), but the token is overwritten,
// so the credential itself is gone from our database for good.
export async function removeCard(req, res) {
  const userId = req.user.sub;
  const cardId = await withTransaction(async (client) => {
    const card = await lockOwnCard(client, userId, req.params.cardId);
    await client.query(
      `UPDATE cards
       SET card_status = 'removed', removed_at = NOW(), card_token = 'removed:' || card_id::text
       WHERE card_id = $1`,
      [card.card_id],
    );
    await writeAudit(client, {
      actorId: userId,
      entityType: "card",
      entityId: card.card_id,
      action: "delete",
      before: { card_status: card.card_status },
      after: { card_status: "removed" },
    });
    return card.card_id;
  });
  return res.status(200).json({ card_id: cardId, card_status: "removed" });
}

// PATCH /v1/cards/:cardId/controls  (API doc 5.4)
export async function updateCardControls(req, res) {
  const body = parseBody(controlsSchema, req.body);
  const userId = req.user.sub;

  await withTransaction(async (client) => {
    const card = await lockOwnCard(client, userId, req.params.cardId);
    const before = await client.query(
      `SELECT daily_limit_minor, online_payments_enabled, atm_withdrawals_enabled
       FROM card_controls WHERE card_id = $1`,
      [card.card_id],
    );
    const fields = Object.keys(body);
    const after = await client.query(
      `UPDATE card_controls
       SET ${fields.map((field, i) => `${field} = $${i + 2}`).join(", ")}, updated_at = NOW()
       WHERE card_id = $1
       RETURNING daily_limit_minor, online_payments_enabled, atm_withdrawals_enabled`,
      [card.card_id, ...fields.map((field) => body[field])],
    );
    await writeAudit(client, {
      actorId: userId,
      entityType: "card_controls",
      entityId: card.card_id,
      action: "update",
      before: before.rows[0],
      after: after.rows[0],
    });
  });
  return res.status(200).json(await findOwnCard(pool, userId, req.params.cardId));
}

// ---------------------------------------------------------------------------
// Charging a saved card

// authorization_url is set while the card's bank waits for the customer to
// approve the charge (3-D Secure): the client should open it.
function chargeResponse(state) {
  return {
    transaction_id: state.transaction_id,
    card_id: state.card_id,
    account_id: state.account_id,
    amount_minor: state.amount_minor,
    currency_code: state.currency_code,
    status: state.status,
    authorization_url: state.status === "pending" ? state.processor_authorization_url ?? null : null,
    failure_reason: state.failure_reason,
  };
}

const CHARGE_STATE = `
    SELECT transaction_id, card_id, receiver_account_id AS account_id, amount_minor,
           currency_code, status, failure_reason, processor_authorization_url
    FROM transactions WHERE transaction_id = $1`;

// POST /v1/cards/:cardId/charges
// Tops up the card's account. Returns 202 with the transaction pending (or
// already settled if the processor confirmed at once). Honours the card's
// controls: it must be active and unexpired, online payments must be on,
// and today's card top-ups must stay within the daily limit.
export async function chargeCard(req, res) {
  const body = parseBody(chargeSchema, req.body);
  // Checked before anything is recorded, so a misconfigured server can't
  // leave a pending charge that was never sent.
  flutterwave.chargeRedirectUrl();
  const userId = req.user.sub;
  const idempotencyKey = `${userId}:${req.idempotencyKey}`;

  const earlier = await pool.query(`SELECT transaction_id, card_id FROM transactions WHERE idempotency_key = $1`, [
    idempotencyKey,
  ]);
  if (earlier.rows[0]) {
    if (earlier.rows[0].card_id !== req.params.cardId) throw new IdempotencyConflictError();
    res.set("Idempotent-Replayed", "true");
    await syncCardPayment(earlier.rows[0].transaction_id);
    const replay = await pool.query(CHARGE_STATE, [earlier.rows[0].transaction_id]);
    return res.status(202).json(chargeResponse(replay.rows[0]));
  }

  const { txn, card } = await withTransaction(async (client) => {
    await requireVerifiedKyc(client, userId);
    const card = await lockOwnCard(client, userId, req.params.cardId);

    const expiresAfter = new Date(Date.UTC(card.expiry_year, card.expiry_month, 1));
    if (card.card_status === "active" && expiresAfter <= new Date()) {
      await client.query(`UPDATE cards SET card_status = 'expired' WHERE card_id = $1`, [card.card_id]);
      card.card_status = "expired";
    }
    if (card.card_status !== "active") {
      throw new ConflictError({ message: `This card is ${card.card_status} and can't be charged.` });
    }
    if (card.account_status !== "active") {
      throw new ConflictError({ message: `The card's account is ${card.account_status}.` });
    }

    const controls = await client.query(`SELECT * FROM card_controls WHERE card_id = $1`, [card.card_id]);
    const { online_payments_enabled: online, daily_limit_minor: dailyLimit } = controls.rows[0];
    if (!online) {
      throw new ConflictError({ message: "Online payments are turned off for this card. Turn them on in its controls." });
    }
    if (dailyLimit !== null) {
      // today in the card owner's timezone; failed charges don't count
      const used = await client.query(
        `SELECT COALESCE(sum(t.amount_minor), 0)::bigint AS total
         FROM transactions t, users u
         WHERE u.user_id = $2
           AND t.card_id = $1
           AND t.status IN ('pending', 'settled')
           AND (t.created_at AT TIME ZONE u.timezone)::date = (NOW() AT TIME ZONE u.timezone)::date`,
        [card.card_id, userId],
      );
      if (used.rows[0].total + body.amount_minor > dailyLimit) {
        throw new ValidationError({
          details: {
            amount_minor: [
              `This would exceed the card's daily limit of ${dailyLimit} (${used.rows[0].total} used today).`,
            ],
          },
        });
      }
    }

    const txn = await createPendingTransaction(client, {
      transactionType: "card_payment",
      senderAccountId: await clearingAccountId(client, card.account_currency),
      receiverAccountId: card.account_id,
      amountMinor: body.amount_minor,
      currencyCode: card.account_currency,
      description: `Card top-up from ${card.pan_bin.slice(0, 4)} •••• ${card.pan_last_four}`,
      idempotencyKey,
      cardId: card.card_id,
      processorTxRef: `vp-${crypto.randomUUID()}`,
    });
    return { txn, card };
  });

  // Charged after the commit, so the processor call never holds DB locks.
  let charge;
  try {
    charge = await flutterwave.chargeCardToken({
      token: card.card_token,
      email: card.processor_customer_email,
      amountMinor: txn.amount_minor,
      currency: txn.currency_code,
      txRef: txn.processor_tx_ref,
      narration: "VergePay top-up",
    });
  } catch (err) {
    if (err instanceof flutterwave.ProcessorError) {
      await withTransaction((client) => failPendingTransaction(client, txn.transaction_id, err.message));
      logger.error({ message: "card charge rejected", transactionId: txn.transaction_id, error: err.message });
    }
    // An outage leaves it pending: the charge may still have gone through,
    // and a later sync or webhook will settle or fail it.
    throw err;
  }

  const authorization = charge?.meta?.authorization;
  const authorizationUrl = authorization?.mode === "redirect" ? authorization.redirect : null;
  if (authorization && !authorizationUrl) {
    logger.error({ message: "unhandled card authorization mode", transactionId: txn.transaction_id, mode: authorization.mode });
  }
  await pool.query(
    `UPDATE transactions
     SET processor_transaction_id = COALESCE(processor_transaction_id, $2),
         processor_authorization_url = $3
     WHERE transaction_id = $1`,
    [txn.transaction_id, charge?.id != null ? String(charge.id) : null, authorizationUrl],
  );
  // If the processor already says successful, settle straight away.
  if (charge?.status === "successful") await syncCardPayment(txn.transaction_id);
  const current = await pool.query(CHARGE_STATE, [txn.transaction_id]);
  return res.status(202).json(chargeResponse(current.rows[0]));
}

// POST /v1/transactions/:transactionId/sync
// Asks the processor again about one of the caller's pending card payments
// and settles or fails it. For when the webhook is slow or can't reach the
// server (local development), and for the UI's return from checkout.
export async function syncTransaction(req, res) {
  const { transactionId } = req.params;
  if (!isUuid(transactionId)) throw new NotFoundError({ message: "Transaction not found." });
  const owned = await pool.query(
    `SELECT t.transaction_type FROM transactions t JOIN account a ON a.account_id = t.receiver_account_id
     WHERE t.transaction_id = $1 AND a.user_id = $2`,
    [transactionId, req.user.sub],
  );
  if (owned.rowCount === 0) throw new NotFoundError({ message: "Transaction not found." });
  if (owned.rows[0].transaction_type !== "card_payment") {
    throw new ConflictError({ message: "Only card payments settle through the processor." });
  }
  return res.status(200).json(await syncCardPayment(transactionId));
}
