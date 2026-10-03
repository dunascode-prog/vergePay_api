import crypto from "crypto";
import env from "../env.js";
import { writeAudit } from "../utils/audit.js";
import { ValidationError } from "../utils/errorStr.js";
import { queueEmail } from "./email.js";
import { invoiceEmail, receiptEmail } from "./invoiceEmails.js";
import { recordUserNotification, formatMoney } from "./notifications.js";

// What every invoice read shares (controllers/invoiceController.js and
// controllers/payLinkController.js).
//
// An invoice is addressed either to a client from the issuer's client book
// (client_id; paid by anyone holding its pay link) or to a VergePay account
// (account_id; the original model). Status is stored as draft, open, paid,
// refunded or cancelled; "overdue" is never stored: an open invoice past
// its due date reads as overdue, in the billed user's timezone (or the
// issuer's, for a client invoice), so it can't go stale.

// $1 is always the viewer's user_id (NULL for a back-office caller).
export const INVOICE_SELECT = `
    SELECT i.invoice_id,
           i.invoice_number,
           CASE WHEN i.invoice_status = 'open'
                 AND i.due_date < (NOW() AT TIME ZONE COALESCE(bu.timezone, iu.timezone))::date
                THEN 'overdue'
                ELSE i.invoice_status::text
           END AS invoice_status,
           CASE WHEN i.issuer_user_id = $1 THEN 'issued' ELSE 'received' END AS direction,
           i.issuer_user_id,
           i.issuer_account_id,
           ia.account_number AS issuer_account_number,
           COALESCE(NULLIF(concat_ws(' ', iu.first_name, iu.last_name), ''), iu.username) AS issuer_name,
           i.account_id,
           ba.account_number AS billed_account_number,
           bu.user_id AS billed_user_id,
           i.client_id,
           c.name AS client_name,
           c.email AS client_email,
           c.phone AS client_phone,
           i.amount_due_minor,
           i.currency_code,
           to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
           i.description,
           i.notes,
           i.settling_transaction_id,
           (SELECT CASE WHEN sa.is_system THEN 'pay_link' ELSE 'wallet' END
            FROM transactions st JOIN account sa ON sa.account_id = st.sender_account_id
            WHERE st.transaction_id = i.settling_transaction_id) AS paid_via,
           i.paid_at,
           i.paid_by_name,
           i.paid_by_email,
           i.cancelled_at,
           (SELECT r.transaction_id FROM transactions r
            WHERE r.reverses_transaction_id = i.settling_transaction_id) AS refund_transaction_id,
           i.refunded_at,
           i.refund_reason,
           i.sent_at,
           i.created_at,
           i.pay_token
    FROM invoices i
    JOIN account ia ON ia.account_id = i.issuer_account_id
    JOIN users iu ON iu.user_id = i.issuer_user_id
    LEFT JOIN account ba ON ba.account_id = i.account_id
    LEFT JOIN users bu ON bu.user_id = ba.user_id
    LEFT JOIN clients c ON c.client_id = i.client_id`;

export const payUrl = (token) => (token ? `${env.appUrl}/pay/${token}` : null);

export const newPayToken = () => crypto.randomBytes(32).toString("base64url");

const toItem = (row) => ({
  item_id: row.item_id,
  description: row.description,
  quantity: Number(row.quantity),
  unit_amount_minor: row.unit_amount_minor,
  amount_minor: row.amount_minor,
});

export async function loadItems(db, invoiceIds) {
  const byInvoice = new Map(invoiceIds.map((id) => [id, []]));
  if (invoiceIds.length === 0) return byInvoice;
  const result = await db.query(
    `SELECT * FROM invoice_items WHERE invoice_id = ANY($1::uuid[]) ORDER BY invoice_id, position`,
    [invoiceIds],
  );
  for (const row of result.rows) byInvoice.get(row.invoice_id)?.push(toItem(row));
  return byInvoice;
}

/**
 * The API's view of an invoice row. The issuer sees the client's contact
 * details and the pay link; the billed user doesn't see the issuer's notes
 * about the client.
 */
export function shapeInvoice(row, items) {
  const {
    pay_token: token,
    client_id: clientId,
    client_name: clientName,
    client_email: clientEmail,
    client_phone: clientPhone,
    issuer_user_id: _issuerUserId,
    billed_user_id: _billedUserId,
    ...rest
  } = row;
  const isIssuer = row.direction === "issued";
  return {
    ...rest,
    client: clientId
      ? { client_id: clientId, name: clientName, ...(isIssuer ? { email: clientEmail, phone: clientPhone } : {}) }
      : null,
    items: items ?? [],
    pay_url: payUrl(token),
  };
}

/** An invoice by id, with no visibility check. Null if there's none. */
export async function loadInvoice(db, invoiceId, viewerUserId = null) {
  const result = await db.query(`${INVOICE_SELECT} WHERE i.invoice_id = $2`, [viewerUserId, invoiceId]);
  const row = result.rows[0];
  if (!row) return null;
  const items = await loadItems(db, [invoiceId]);
  return { row, invoice: shapeInvoice(row, items.get(invoiceId)) };
}

/**
 * Line items with their amounts, and the total. quantity has at most two
 * decimals; each amount is quantity × unit price, rounded half up to the
 * kobo, worked out in integers so nothing is lost to floating point.
 */
export function priceItems(items) {
  let total = 0n;
  const priced = items.map((item, index) => {
    const hundredths = BigInt(Math.round(item.quantity * 100));
    const amount = (hundredths * BigInt(item.unit_amount_minor) + 50n) / 100n;
    if (amount <= 0n) {
      throw new ValidationError({ details: { [`items.${index}.quantity`]: ["The line comes to nothing."] } });
    }
    total += amount;
    return { ...item, amount_minor: amount };
  });
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ValidationError({ details: { items: ["The total is too large."] } });
  }
  return { items: priced.map((i) => ({ ...i, amount_minor: Number(i.amount_minor) })), total: Number(total) };
}

export async function replaceItems(client, invoiceId, pricedItems) {
  await client.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [invoiceId]);
  for (const [position, item] of pricedItems.entries()) {
    await client.query(
      `INSERT INTO invoice_items (invoice_id, position, description, quantity, unit_amount_minor, amount_minor)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [invoiceId, position, item.description, item.quantity.toFixed(2), item.unit_amount_minor, item.amount_minor],
    );
  }
}

/** The issuer's next invoice number: INV-0001, INV-0002… */
export async function nextInvoiceNumber(client, userId) {
  const result = await client.query(
    `INSERT INTO invoice_counters (user_id, last_number) VALUES ($1, 1)
     ON CONFLICT (user_id) DO UPDATE SET last_number = invoice_counters.last_number + 1
     RETURNING last_number`,
    [userId],
  );
  return `INV-${String(result.rows[0].last_number).padStart(4, "0")}`;
}

/** What the ledger records for an invoice payment, seen by both sides. */
export function paymentDescription(row) {
  const label = row.invoice_number ? `Invoice ${row.invoice_number}` : "Invoice payment";
  return row.client_name ? `${label} · ${row.client_name}` : label;
}

/** Emails an invoice (or a reminder) to its client. Returns the email_log row. */
export async function emailInvoice(db, invoice, { kind, message, userId }) {
  const { subject, html, text } = invoiceEmail(invoice, { kind, payUrl: invoice.pay_url, message });
  return queueEmail(db, { userId, invoiceId: invoice.invoice_id, kind, to: invoice.client.email, subject, html, text });
}

/**
 * Marks an invoice paid by a settled transaction, inside that DB
 * transaction (the invoice row must already be locked). If it's no longer
 * payable (paid by someone else a moment earlier, or cancelled), the money
 * has still arrived: the issuer is told to return it, and the invoice is
 * left as it is. Returns true if this payment settled the invoice.
 */
export async function settleInvoice(client, invoiceRow, txn, { actorId = null, paidByName = null, paidByEmail = null, payerAccountId = null }) {
  if (invoiceRow.invoice_status !== "open" && invoiceRow.invoice_status !== "overdue") {
    await recordUserNotification(client, invoiceRow.issuer_user_id, {
      kind: "invoice_extra_payment",
      title: `Extra payment of ${formatMoney(txn.amount_minor, txn.currency_code)} for ${invoiceRow.invoice_number ?? "an invoice"}`,
      body: `It arrived after the invoice was ${invoiceRow.invoice_status}. It's in your wallet; return it to the payer.`,
    });
    await writeAudit(client, {
      actorId,
      entityType: "invoice",
      entityId: invoiceRow.invoice_id,
      action: "update",
      before: { invoice_status: invoiceRow.invoice_status },
      after: { extra_payment_transaction_id: txn.transaction_id, amount_minor: txn.amount_minor },
    });
    return false;
  }
  await client.query(
    `UPDATE invoices
     SET invoice_status = 'paid', settling_transaction_id = $2, paid_at = NOW(),
         paid_by_name = $3, paid_by_email = $4, account_id = COALESCE(account_id, $5)
     WHERE invoice_id = $1`,
    [invoiceRow.invoice_id, txn.transaction_id, paidByName?.slice(0, 120) ?? null, paidByEmail?.slice(0, 255) ?? null, payerAccountId],
  );
  await writeAudit(client, {
    actorId,
    entityType: "invoice",
    entityId: invoiceRow.invoice_id,
    action: "status_change",
    before: { invoice_status: invoiceRow.invoice_status },
    after: { invoice_status: "paid", settling_transaction_id: txn.transaction_id },
  });
  return true;
}

/** A receipt to whoever paid, if we have an address for them. */
export async function emailReceipt(db, invoiceId, toAddress) {
  if (!toAddress) return null;
  const loaded = await loadInvoice(db, invoiceId);
  if (!loaded) return null;
  const { invoice, row } = loaded;
  const { subject, html, text } = receiptEmail(invoice, { payUrl: invoice.pay_url, paidAt: invoice.paid_at ?? new Date() });
  return queueEmail(db, { userId: row.issuer_user_id, invoiceId, kind: "receipt", to: toAddress, subject, html, text });
}
