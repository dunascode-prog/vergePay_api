import crypto from "crypto";
import { pool } from "../db/connectDB.js";
import env from "../env.js";
import logger from "../logger.js";
import { creditBankDeposit, syncCardPayment } from "../services/processorPayments.js";
import { UnauthorizedError } from "../utils/errorStr.js";

// POST /v1/webhooks/payment-processor  (API doc 10.1, 10.2)
//
// Authenticity: Flutterwave v3 sends the dashboard's "secret hash" in the
// verif-hash header; v4 sends flutterwave-signature, a base64 HMAC-SHA256 of
// the raw body keyed with the same secret. Either is accepted; anything
// else is 401 before any business logic runs.
//
// v3 signs no timestamp, so a captured delivery could be replayed. That is
// made harmless rather than detected: every event is deduplicated on its
// identity, and no payload is trusted. The handler only uses the payload to
// find which of our payments it is about, then asks Flutterwave's verify
// API for the real outcome (services/processorPayments.js).

function safeEqual(a, b) {
  const x = crypto.createHash("sha256").update(a).digest();
  const y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

function isAuthentic(req) {
  const secret = env.flutterwave.secretHash;
  if (!secret) return false;
  const hash = req.header("verif-hash");
  if (hash && safeEqual(hash, secret)) return true;
  const signature = req.header("flutterwave-signature");
  if (signature && req.rawBody) {
    const expected = crypto.createHmac("sha256", secret).update(req.rawBody).digest("base64");
    return safeEqual(signature, expected);
  }
  return false;
}

// v3: { event, data }; v4: { type, data, id }.
function eventIdentity(body) {
  const type = body?.event ?? body?.type ?? "unknown";
  const id = body?.data?.id ?? body?.id ?? crypto.createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
  return { type, dedupeKey: `${type}:${id}` };
}

// Routes one charge.completed event to the payment it's about.
async function handleChargeCompleted(data) {
  const txRef = data?.tx_ref;
  if (!txRef) return { outcome: "ignored", note: "no tx_ref" };

  const payment = await pool.query(
    `SELECT transaction_id FROM transactions
     WHERE processor_tx_ref = $1 AND transaction_type IN ('card_payment', 'invoice_payment')`,
    [txRef],
  );
  if (payment.rows[0]) {
    const state = await syncCardPayment(payment.rows[0].transaction_id);
    return { outcome: "processed", note: `card payment ${state?.status}` };
  }

  const virtualAccount = await pool.query(`SELECT * FROM virtual_accounts WHERE processor_tx_ref = $1`, [txRef]);
  if (virtualAccount.rows[0]) {
    if (data.id == null) return { outcome: "ignored", note: "no transaction id" };
    const result = await creditBankDeposit(String(data.id), virtualAccount.rows[0]);
    return { outcome: "processed", note: `bank deposit ${result}` };
  }

  return { outcome: "ignored", note: "unknown tx_ref" };
}

export async function receivePaymentProcessorWebhook(req, res) {
  if (!isAuthentic(req)) {
    throw new UnauthorizedError({ message: "Invalid webhook signature." });
  }

  const { type, dedupeKey } = eventIdentity(req.body);

  // Record first. A second delivery of something already handled is
  // acknowledged without doing anything; one that failed before is retried.
  const recorded = await pool.query(
    `INSERT INTO webhook_events (processor, dedupe_key, event_type, payload)
     VALUES ('flutterwave', $1, $2, $3)
     ON CONFLICT (processor, dedupe_key) DO NOTHING
     RETURNING webhook_event_id`,
    [dedupeKey, type, JSON.stringify(req.body ?? null)],
  );
  let eventId = recorded.rows[0]?.webhook_event_id;
  if (!eventId) {
    const existing = await pool.query(
      `SELECT webhook_event_id, outcome FROM webhook_events WHERE processor = 'flutterwave' AND dedupe_key = $1`,
      [dedupeKey],
    );
    if (["processed", "ignored", "recorded"].includes(existing.rows[0].outcome)) {
      return res.status(200).json({ received: true, duplicate: true });
    }
    eventId = existing.rows[0].webhook_event_id;
  }

  let result;
  try {
    if (type === "charge.completed") {
      result = await handleChargeCompleted(req.body.data);
    } else if (type.startsWith("chargeback.")) {
      // Stored for review; acting on disputes (freezing funds, reversing)
      // isn't built yet.
      logger.error({ message: "chargeback event received", dedupeKey });
      result = { outcome: "recorded", note: "chargeback stored for review" };
    } else {
      result = { outcome: "ignored", note: "event type not handled" };
    }
  } catch (err) {
    await pool.query(
      `UPDATE webhook_events SET outcome = 'failed', error = $2, processed_at = NOW() WHERE webhook_event_id = $1`,
      [eventId, err.message?.slice(0, 1000)],
    );
    // A non-2xx answer makes Flutterwave retry the delivery (if retries are
    // enabled in the dashboard).
    throw err;
  }

  await pool.query(
    `UPDATE webhook_events SET outcome = $2, error = $3, processed_at = NOW() WHERE webhook_event_id = $1`,
    [eventId, result.outcome, result.note],
  );
  return res.status(200).json({ received: true });
}
