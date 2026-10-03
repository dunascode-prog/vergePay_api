import crypto from "crypto";
import z from "zod";
import { pool } from "../db/connectDB.js";
import { withTransaction } from "../db/withTransaction.js";
import env from "../env.js";
import * as flutterwave from "../services/flutterwave.js";
import { INVOICE_SELECT, loadItems, paymentDescription } from "../services/invoices.js";
import { createPendingTransaction, failPendingTransaction } from "../services/ledger.js";
import { clearingAccountId, syncCardPayment } from "../services/processorPayments.js";
import { BadRequestError, ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from "../utils/errorStr.js";
import { validationDetails } from "../utils/validation.js";
import { payFromWallet } from "./invoiceController.js";

// Pay links: /v1/pay/:token. The token in an invoice's pay link is the
// only key (a capability URL, like a hosted invoice page): whoever holds it
// can see that one invoice and pay it, nothing else. No session needed,
// except to pay from a VergePay wallet.
//
// What a payer sees is deliberately small: who's billing, what for, how
// much and by when. No account numbers, no email addresses.
//
// Paying by card, bank transfer or USSD goes through Flutterwave's hosted
// checkout, as a pending invoice_payment from the processor's clearing
// account into the issuer's wallet. It settles only once Flutterwave's
// verify endpoint confirms it (services/processorPayments.js), which also
// marks the invoice paid in the same DB transaction.

const checkoutSchema = z.strictObject({
  email: z.string().trim().toLowerCase().max(255).email("Enter a valid email address.").optional(),
  name: z.string().trim().min(1).max(120).optional(),
});
const syncSchema = z.strictObject({ transaction_id: z.uuid() });
const walletSchema = z.strictObject({ source_account_id: z.uuid() });

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const notFound = () => new NotFoundError({ message: "This payment link isn't valid." });

function parse(schema, body) {
  const validation = schema.safeParse(body ?? {});
  if (!validation.success) throw new ValidationError({ details: validationDetails(validation.error) });
  return validation.data;
}

async function findByToken(db, token) {
  if (!TOKEN_PATTERN.test(token ?? "")) throw notFound();
  const result = await db.query(`${INVOICE_SELECT} WHERE i.pay_token = $2 AND i.invoice_status <> 'draft'`, [null, token]);
  if (result.rowCount === 0) throw notFound();
  return result.rows[0];
}

const payable = (row) => row.invoice_status === "open" || row.invoice_status === "overdue";

// GET /v1/pay/:token
export async function getPayLink(req, res) {
  const row = await findByToken(pool, req.params.token);
  const items = await loadItems(pool, [row.invoice_id]);
  return res.status(200).json({
    invoice_number: row.invoice_number,
    invoice_status: row.invoice_status,
    issuer_name: row.issuer_name,
    billed_to: row.client_name ?? null,
    amount_due_minor: row.amount_due_minor,
    currency_code: row.currency_code,
    due_date: row.due_date,
    description: row.description,
    notes: row.notes,
    items: items.get(row.invoice_id),
    sent_at: row.sent_at,
    paid_at: row.paid_at,
    cancelled_at: row.cancelled_at,
    payment_methods: {
      // card, bank transfer and USSD through Flutterwave
      checkout: payable(row) && flutterwave.isConfigured(),
      // a VergePay customer can pay from their wallet when signed in
      wallet: payable(row),
    },
  });
}

// POST /v1/pay/:token/checkout  { email?, name? }
// Starts a Flutterwave checkout for the full amount. The email is where the
// receipt goes; without one, the client's email from the invoice is used.
export async function startCheckout(req, res) {
  const body = parse(checkoutSchema, req.body);
  if (!flutterwave.isConfigured()) {
    throw new ServiceUnavailableError({ message: "Card and bank-transfer payments aren't available right now." });
  }

  const { txn, row } = await withTransaction(async (client) => {
    const found = await findByToken(client, req.params.token);
    // lock it, so a cancel can't slip in while the payment is being set up
    await client.query(`SELECT 1 FROM invoices WHERE invoice_id = $1 FOR UPDATE`, [found.invoice_id]);
    const row = await findByToken(client, req.params.token);
    if (!payable(row)) throw new ConflictError({ message: `This invoice is ${row.invoice_status} and can't be paid.` });

    const issuer = await client.query(`SELECT account_status FROM account WHERE account_id = $1`, [row.issuer_account_id]);
    if (issuer.rows[0]?.account_status !== "active") {
      throw new ConflictError({ message: "This invoice can't be paid right now. Please contact the sender." });
    }
    const clearing = await clearingAccountId(client, row.currency_code);
    if (!clearing) throw new ConflictError({ message: `Payments in ${row.currency_code} aren't supported yet.` });
    if (!body.email && !row.client_email) {
      throw new ValidationError({ details: { email: ["Enter your email address for the receipt."] } });
    }

    const txn = await createPendingTransaction(client, {
      transactionType: "invoice_payment",
      senderAccountId: clearing,
      receiverAccountId: row.issuer_account_id,
      amountMinor: row.amount_due_minor,
      currencyCode: row.currency_code,
      description: paymentDescription(row),
      idempotencyKey: `paylink:${crypto.randomUUID()}`,
      processorTxRef: `vpi-${crypto.randomUUID()}`,
      invoiceId: row.invoice_id,
    });
    return { txn, row };
  });

  const email = body.email ?? row.client_email;

  // created after the commit, so a processor outage can't hold a DB
  // transaction open; if it fails, the payment is marked failed
  let checkout;
  try {
    checkout = await flutterwave.createPaymentLink({
      txRef: txn.processor_tx_ref,
      amountMinor: row.amount_due_minor,
      currency: row.currency_code,
      redirectUrl: `${env.appUrl}/pay/${req.params.token}?transaction_id=${txn.transaction_id}`,
      customer: { email, name: body.name ?? row.client_name ?? undefined },
      title: row.issuer_name,
      description: `Invoice ${row.invoice_number}`,
      paymentOptions: "card,banktransfer,ussd",
    });
  } catch (err) {
    await withTransaction((client) =>
      failPendingTransaction(client, txn.transaction_id, `Checkout couldn't be created: ${err.message}`),
    );
    throw err;
  }
  return res.status(201).json({ transaction_id: txn.transaction_id, checkout_url: checkout.link });
}

// POST /v1/pay/:token/sync  { transaction_id }
// After checkout: asks Flutterwave how the payment went (never trusting the
// redirect) and settles it if it succeeded. Safe to repeat.
export async function syncPayLink(req, res) {
  const body = parse(syncSchema, req.body);
  const row = await findByToken(pool, req.params.token);
  const found = await pool.query(
    `SELECT 1 FROM transactions WHERE transaction_id = $1 AND invoice_id = $2 AND transaction_type = 'invoice_payment'
       AND processor_tx_ref IS NOT NULL`,
    [body.transaction_id, row.invoice_id],
  );
  if (found.rowCount === 0) throw new NotFoundError({ message: "Payment not found." });

  const state = await syncCardPayment(body.transaction_id);
  const after = await findByToken(pool, req.params.token);
  return res.status(200).json({
    transaction_id: state.transaction_id,
    status: state.status,
    failure_reason: state.failure_reason,
    invoice_status: after.invoice_status,
    // true only if this payment is the one that settled the invoice
    settled_invoice: after.settling_transaction_id === state.transaction_id,
  });
}

// POST /v1/pay/:token/wallet  { source_account_id }  (signed in, KYC verified)
// A VergePay customer pays from one of their wallets.
export async function payLinkFromWallet(req, res) {
  if (!req.body || Object.keys(req.body).length === 0) throw new BadRequestError({ message: "Request body is empty." });
  const body = parse(walletSchema, req.body);
  const userId = req.user.sub;
  if (!TOKEN_PATTERN.test(req.params.token ?? "")) throw notFound();

  const { replayed, invoiceId } = await payFromWallet({
    userId,
    idempotencyKey: `${userId}:${req.idempotencyKey}`,
    sourceAccountId: body.source_account_id,
    lockInvoice: async (client) => {
      const found = await client.query(
        `SELECT i.*, c.name AS client_name
         FROM invoices i LEFT JOIN clients c ON c.client_id = i.client_id
         WHERE i.pay_token = $1 AND i.invoice_status <> 'draft'
         FOR UPDATE OF i`,
        [req.params.token],
      );
      if (!found.rows[0]) throw notFound();
      return found.rows[0];
    },
  });

  if (replayed) res.set("Idempotent-Replayed", "true");
  const settled = await pool.query(`SELECT invoice_status, settling_transaction_id FROM invoices WHERE invoice_id = $1`, [
    invoiceId ?? (await findByToken(pool, req.params.token)).invoice_id,
  ]);
  return res.status(200).json(settled.rows[0]);
}
