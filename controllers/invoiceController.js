import z from "zod";
import { pool } from "../db/connectDB.js";
import { withTransaction } from "../db/withTransaction.js";
import {
  INVOICE_SELECT,
  emailInvoice,
  emailReceipt,
  loadInvoice,
  loadItems,
  newPayToken,
  nextInvoiceNumber,
  paymentDescription,
  priceItems,
  replaceItems,
  settleInvoice,
  shapeInvoice,
} from "../services/invoices.js";
import { postOnce, postTransaction } from "../services/ledger.js";
import { writeAudit } from "../utils/audit.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  KycRequiredError,
  NotFoundError,
  TooManyRequestsError,
  ValidationError,
} from "../utils/errorStr.js";
import { decodeCursor, encodeCursor } from "../utils/pagination.js";
import { isUuid, validationDetails } from "../utils/validation.js";

// Invoices (API doc 8), two kinds:
//
//   to a client    client_id from the issuer's client book, with line
//                  items. Starts as an editable draft; sending it gives it
//                  a number and a pay link that anyone can pay through
//                  (controllers/payLinkController.js), and emails the client.
//   to an account  account_id / billed_account_number of a VergePay account
//                  (the original model): sent at once, paid by that
//                  account's owner from their wallet.
//
// Stored status: draft -> open -> paid -> refunded, or open -> cancelled.
// "overdue" is read, never stored (services/invoices.js). Overdue invoices
// can still be paid or cancelled.
//
// Paying locks the invoice row before the accounts (inside postTransaction),
// the same order loans use.

const minorAmount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const isoDate = z.iso.date("Use the format YYYY-MM-DD.");

const itemSchema = z.strictObject({
  description: z.string().trim().min(1).max(255),
  quantity: z
    .number()
    .positive()
    .max(100000)
    .refine((q) => Math.abs(q * 100 - Math.round(q * 100)) < 1e-6, "At most two decimal places."),
  unit_amount_minor: z.number().int().positive().max(1_000_000_000_000),
});

// To a client: the invoice is in the issuing wallet's currency.
const clientInvoiceSchema = z.strictObject({
  issuer_account_id: z.uuid(),
  client_id: z.uuid(),
  items: z.array(itemSchema).min(1, "Add at least one item.").max(50),
  due_date: isoDate,
  notes: z.string().trim().max(1000).optional(),
  // true: send straight away (number, pay link, email) instead of saving a draft
  send: z.boolean().optional(),
  // false: send without emailing, e.g. to share the link by hand
  send_email: z.boolean().optional(),
});

// To a VergePay account, named by id or by the 10-digit number a person
// would type; exactly one is required.
const accountInvoiceSchema = z
  .strictObject({
    issuer_account_id: z.uuid(),
    account_id: z.uuid().optional(),
    billed_account_number: z.string().trim().regex(/^\d{10}$/, "Must be a 10-digit account number.").optional(),
    amount_due_minor: minorAmount,
    currency_code: z.string().trim().toUpperCase().length(3),
    due_date: isoDate,
    description: z.string().trim().min(1).max(255).optional(),
  })
  .refine((b) => Boolean(b.account_id) !== Boolean(b.billed_account_number), {
    message: "Send exactly one of account_id or billed_account_number.",
    path: ["account_id"],
  });

const updateDraftSchema = z
  .strictObject({
    issuer_account_id: z.uuid().optional(),
    client_id: z.uuid().optional(),
    items: z.array(itemSchema).min(1, "Add at least one item.").max(50).optional(),
    due_date: isoDate.optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to change." });

const sendSchema = z.strictObject({ send_email: z.boolean().optional() });
const remindSchema = z.strictObject({ message: z.string().trim().min(1).max(500).optional() });

const paySchema = z.strictObject({
  source_account_id: z.uuid(),
});

const refundSchema = z.strictObject({
  reason: z.string().trim().min(1).max(255).optional(),
});

const listQuerySchema = z.strictObject({
  role: z.enum(["all", "issued", "received"]).default("all"),
  status: z.enum(["draft", "open", "paid", "overdue", "cancelled", "refunded"]).optional(),
  client_id: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  after: z.string().optional(),
});

// A reminder at most once an hour, so a client isn't spammed.
const REMINDER_INTERVAL_MINUTES = 60;

function parseBody(schema, body, { allowEmpty = false } = {}) {
  if (!allowEmpty && (!body || Object.keys(body).length === 0)) {
    throw new BadRequestError({ message: "Request body is empty." });
  }
  const validation = schema.safeParse(body ?? {});
  if (!validation.success) {
    throw new ValidationError({ details: validationDetails(validation.error) });
  }
  return validation.data;
}

const notFound = () => new NotFoundError({ message: "Invoice not found." });

async function requireVerifiedKyc(db, userId, message) {
  const result = await db.query(`SELECT kyc_status FROM users WHERE user_id = $1`, [userId]);
  if (result.rows[0]?.kyc_status !== "verified") throw new KycRequiredError({ message });
}

const KYC_TO_INVOICE = "Identity verification is required before you can send invoices.";
const KYC_TO_PAY = "Identity verification is required before you can move money.";

// Only the issuer and the billed user can see an invoice; anyone else gets
// 404. The billed user never sees drafts.
async function findVisibleInvoice(db, userId, invoiceId, { withEmails = false } = {}) {
  if (!isUuid(invoiceId)) throw notFound();
  const result = await db.query(
    `${INVOICE_SELECT}
     WHERE i.invoice_id = $2
       AND (i.issuer_user_id = $1 OR (bu.user_id = $1 AND i.invoice_status <> 'draft'))`,
    [userId, invoiceId],
  );
  const row = result.rows[0];
  if (!row) throw notFound();
  const items = await loadItems(db, [invoiceId]);
  const invoice = shapeInvoice(row, items.get(invoiceId));
  if (withEmails && invoice.direction === "issued") {
    const emails = await db.query(
      `SELECT email_id, kind, to_address, subject, status, attempts, preview_url, error, created_at, sent_at
       FROM email_log WHERE invoice_id = $1 ORDER BY created_at DESC`,
      [invoiceId],
    );
    invoice.emails = emails.rows;
  }
  return invoice;
}

// The issuing wallet: the caller's own current/savings account, active.
async function checkIssuerAccount(client, userId, accountId) {
  const issuer = await client.query(
    `SELECT a.account_type, a.account_status, a.currency_code,
            (NOW() AT TIME ZONE u.timezone)::date::text AS today
     FROM account a JOIN users u ON u.user_id = a.user_id
     WHERE a.account_id = $1 AND a.user_id = $2 AND NOT a.is_system`,
    [accountId, userId],
  );
  const from = issuer.rows[0];
  if (!from) {
    throw new ValidationError({ details: { issuer_account_id: ["Account not found."] } });
  }
  if (!["current", "savings"].includes(from.account_type)) {
    throw new ValidationError({
      details: { issuer_account_id: ["Invoices can only be paid into a current or savings account."] },
    });
  }
  if (from.account_status !== "active") {
    throw new ConflictError({ message: `The issuing account is ${from.account_status}.` });
  }
  return from;
}

async function checkClient(client, userId, clientId) {
  const found = await client.query(
    `SELECT client_id, name, email, archived_at FROM clients WHERE client_id = $1 AND user_id = $2`,
    [clientId, userId],
  );
  const row = found.rows[0];
  if (!row) throw new ValidationError({ details: { client_id: ["Client not found."] } });
  if (row.archived_at) throw new ValidationError({ details: { client_id: ["This client is archived."] } });
  return row;
}

function checkDueDate(dueDate, today) {
  if (dueDate < today) throw new ValidationError({ details: { due_date: ["Can't be in the past."] } });
}

// Draft -> open: number, pay link, sent time. Inside the caller's DB
// transaction, with the invoice row locked.
async function markSent(client, invoiceId, userId) {
  const number = await nextInvoiceNumber(client, userId);
  await client.query(
    `UPDATE invoices
     SET invoice_status = 'open', invoice_number = $2, pay_token = COALESCE(pay_token, $3), sent_at = NOW()
     WHERE invoice_id = $1`,
    [invoiceId, number, newPayToken()],
  );
  await writeAudit(client, {
    actorId: userId,
    entityType: "invoice",
    entityId: invoiceId,
    action: "status_change",
    before: { invoice_status: "draft" },
    after: { invoice_status: "open", invoice_number: number },
  });
}

// Emails a just-sent invoice to its client, if asked and possible.
async function emailIfWanted(client, invoiceId, userId, sendEmail) {
  if (sendEmail === false) return null;
  const loaded = await loadInvoice(client, invoiceId, userId);
  if (!loaded.invoice.client?.email) return null;
  return emailInvoice(client, loaded.invoice, { kind: "invoice", userId });
}

// POST /v1/invoices
export async function createInvoice(req, res) {
  if (!req.body || Object.keys(req.body).length === 0) {
    throw new BadRequestError({ message: "Request body is empty." });
  }
  return "client_id" in req.body ? createClientInvoice(req, res) : createAccountInvoice(req, res);
}

async function createClientInvoice(req, res) {
  const body = parseBody(clientInvoiceSchema, req.body);
  const userId = req.user.sub;

  const invoiceId = await withTransaction(async (client) => {
    await requireVerifiedKyc(client, userId, KYC_TO_INVOICE);
    const from = await checkIssuerAccount(client, userId, body.issuer_account_id);
    const billed = await checkClient(client, userId, body.client_id);
    checkDueDate(body.due_date, from.today);
    const { items, total } = priceItems(body.items);

    const inserted = await client.query(
      `INSERT INTO invoices (
          issuer_user_id, issuer_account_id, client_id, amount_due_minor,
          currency_code, due_date, notes, invoice_status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft')
       RETURNING invoice_id`,
      [userId, body.issuer_account_id, billed.client_id, total, from.currency_code, body.due_date, body.notes || null],
    );
    const id = inserted.rows[0].invoice_id;
    await replaceItems(client, id, items);
    await writeAudit(client, {
      actorId: userId,
      entityType: "invoice",
      entityId: id,
      action: "create",
      after: { client_id: billed.client_id, amount_due_minor: total, invoice_status: "draft" },
    });
    if (body.send) {
      await markSent(client, id, userId);
      await emailIfWanted(client, id, userId, body.send_email);
    }
    return id;
  });

  return res.status(201).json(await findVisibleInvoice(pool, userId, invoiceId, { withEmails: true }));
}

async function createAccountInvoice(req, res) {
  const body = parseBody(accountInvoiceSchema, req.body);
  const userId = req.user.sub;

  const invoiceId = await withTransaction(async (client) => {
    await requireVerifiedKyc(client, userId, KYC_TO_INVOICE);
    const from = await checkIssuerAccount(client, userId, body.issuer_account_id);

    const billedField = body.account_id ? "account_id" : "billed_account_number";
    const billed = await client.query(
      body.account_id
        ? `SELECT account_id, account_status, currency_code FROM account WHERE account_id = $1 AND NOT is_system`
        : `SELECT account_id, account_status, currency_code FROM account WHERE account_number = $1 AND NOT is_system`,
      [body.account_id ?? body.billed_account_number],
    );
    const to = billed.rows[0];
    if (!to || to.account_status === "closed") {
      throw new ValidationError({ details: { [billedField]: ["No open account with this number."] } });
    }
    if (to.account_id === body.issuer_account_id) {
      throw new ValidationError({ details: { [billedField]: ["An account can't bill itself."] } });
    }
    if (from.currency_code !== body.currency_code || to.currency_code !== body.currency_code) {
      throw new ValidationError({
        details: { currency_code: [`Both accounts must hold ${body.currency_code}.`] },
      });
    }
    checkDueDate(body.due_date, from.today);

    // sent at once: numbered, with a pay link
    const inserted = await client.query(
      `INSERT INTO invoices (
          issuer_user_id, issuer_account_id, account_id, amount_due_minor,
          currency_code, due_date, description, invoice_status,
          invoice_number, pay_token, sent_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, NOW())
       RETURNING invoice_id`,
      [
        userId,
        body.issuer_account_id,
        to.account_id,
        body.amount_due_minor,
        body.currency_code,
        body.due_date,
        body.description ?? null,
        await nextInvoiceNumber(client, userId),
        newPayToken(),
      ],
    );
    const id = inserted.rows[0].invoice_id;
    await replaceItems(client, id, [
      { description: body.description ?? "Invoice", quantity: 1, unit_amount_minor: body.amount_due_minor, amount_minor: body.amount_due_minor },
    ]);
    await writeAudit(client, {
      actorId: userId,
      entityType: "invoice",
      entityId: id,
      action: "create",
      after: { ...body, account_id: to.account_id, invoice_status: "open" },
    });
    return id;
  });

  return res.status(201).json(await findVisibleInvoice(pool, userId, invoiceId));
}

// GET /v1/invoices?role=all|issued|received&status=&client_id=&limit=&after=
export async function listInvoices(req, res) {
  const validation = listQuerySchema.safeParse(req.query);
  if (!validation.success) {
    throw new ValidationError({ details: validationDetails(validation.error) });
  }
  const q = validation.data;
  const cursor = q.after ? decodeCursor(q.after) : null;

  const result = await pool.query(
    `SELECT inv.*, inv.created_at::text AS cursor_ts FROM (
       ${INVOICE_SELECT}
       WHERE CASE $2
               WHEN 'issued' THEN i.issuer_user_id = $1
               WHEN 'received' THEN bu.user_id = $1 AND i.issuer_user_id <> $1
               ELSE $1 IN (i.issuer_user_id, bu.user_id)
             END
         AND (i.issuer_user_id = $1 OR i.invoice_status <> 'draft')
         AND ($7::uuid IS NULL OR i.client_id = $7)
     ) inv
     WHERE ($3::text IS NULL OR inv.invoice_status = $3)
       AND ($4::timestamptz IS NULL OR (inv.created_at, inv.invoice_id) < ($4::timestamptz, $5::uuid))
     ORDER BY inv.created_at DESC, inv.invoice_id DESC
     LIMIT $6`,
    [req.user.sub, q.role, q.status ?? null, cursor?.t ?? null, cursor?.id ?? null, q.limit + 1, q.client_id ?? null],
  );

  const hasMore = result.rows.length > q.limit;
  const page = result.rows.slice(0, q.limit);
  const last = page[page.length - 1];
  const items = await loadItems(pool, page.map((row) => row.invoice_id));
  return res.status(200).json({
    data: page.map(({ cursor_ts, ...row }) => shapeInvoice(row, items.get(row.invoice_id))),
    next_cursor: hasMore ? encodeCursor(last.cursor_ts, last.invoice_id) : null,
    has_more: hasMore,
  });
}

// GET /v1/invoices/:invoiceId  (the issuer also gets the emails sent about it)
export async function getInvoice(req, res) {
  return res.status(200).json(await findVisibleInvoice(pool, req.user.sub, req.params.invoiceId, { withEmails: true }));
}

// Loads and locks one of the caller's own invoices for a change.
async function lockOwnInvoice(client, userId, invoiceId) {
  if (!isUuid(invoiceId)) throw notFound();
  const found = await client.query(
    `SELECT i.*, to_char(i.due_date, 'YYYY-MM-DD') AS due_date_text, ba.user_id AS billed_user_id
     FROM invoices i LEFT JOIN account ba ON ba.account_id = i.account_id
     WHERE i.invoice_id = $1
     FOR UPDATE OF i`,
    [invoiceId],
  );
  const invoice = found.rows[0];
  if (!invoice) throw notFound();
  if (invoice.issuer_user_id !== userId) {
    if (invoice.billed_user_id === userId && invoice.invoice_status !== "draft") {
      throw new ForbiddenError({ message: "Only the issuer can change this invoice." });
    }
    throw notFound();
  }
  return invoice;
}

function requireDraft(invoice) {
  if (invoice.invoice_status !== "draft") {
    throw new ConflictError({ message: `This invoice has been sent and is ${invoice.invoice_status}; only drafts can be changed.` });
  }
}

// PATCH /v1/invoices/:invoiceId  (drafts only)
export async function updateInvoice(req, res) {
  const body = parseBody(updateDraftSchema, req.body);
  const userId = req.user.sub;

  await withTransaction(async (client) => {
    const invoice = await lockOwnInvoice(client, userId, req.params.invoiceId);
    requireDraft(invoice);
    const from = await checkIssuerAccount(client, userId, body.issuer_account_id ?? invoice.issuer_account_id);
    if (body.client_id) await checkClient(client, userId, body.client_id);
    if (body.due_date) checkDueDate(body.due_date, from.today);

    let total = invoice.amount_due_minor;
    if (body.items) {
      const priced = priceItems(body.items);
      total = priced.total;
      await replaceItems(client, invoice.invoice_id, priced.items);
    }
    await client.query(
      `UPDATE invoices
       SET issuer_account_id = $2, client_id = $3, amount_due_minor = $4, currency_code = $5,
           due_date = COALESCE($6, due_date), notes = CASE WHEN $7 THEN $8 ELSE notes END
       WHERE invoice_id = $1`,
      [
        invoice.invoice_id,
        body.issuer_account_id ?? invoice.issuer_account_id,
        body.client_id ?? invoice.client_id,
        total,
        from.currency_code,
        body.due_date ?? null,
        "notes" in body,
        body.notes || null,
      ],
    );
    await writeAudit(client, {
      actorId: userId,
      entityType: "invoice",
      entityId: invoice.invoice_id,
      action: "update",
      after: { ...body, amount_due_minor: total },
    });
  });

  return res.status(200).json(await findVisibleInvoice(pool, userId, req.params.invoiceId, { withEmails: true }));
}

// DELETE /v1/invoices/:invoiceId  (drafts only; a sent invoice is cancelled instead)
export async function deleteInvoice(req, res) {
  const userId = req.user.sub;
  await withTransaction(async (client) => {
    const invoice = await lockOwnInvoice(client, userId, req.params.invoiceId);
    if (invoice.invoice_status !== "draft") {
      throw new ConflictError({ message: "Only drafts can be deleted. Cancel a sent invoice instead." });
    }
    await client.query(`DELETE FROM invoices WHERE invoice_id = $1`, [invoice.invoice_id]);
    await writeAudit(client, {
      actorId: userId,
      entityType: "invoice",
      entityId: invoice.invoice_id,
      action: "delete",
      before: { invoice_status: "draft", amount_due_minor: invoice.amount_due_minor },
    });
  });
  return res.status(200).json({ invoice_id: req.params.invoiceId, deleted: true });
}

// POST /v1/invoices/:invoiceId/send  { send_email? }
// Draft -> open: number, pay link, and an email to the client (unless
// send_email is false, or the client has no email address).
export async function sendInvoice(req, res) {
  const body = parseBody(sendSchema, req.body, { allowEmpty: true });
  const userId = req.user.sub;

  await withTransaction(async (client) => {
    await requireVerifiedKyc(client, userId, KYC_TO_INVOICE);
    const invoice = await lockOwnInvoice(client, userId, req.params.invoiceId);
    if (invoice.invoice_status !== "draft") {
      throw new ConflictError({ message: "This invoice has already been sent. Send a reminder instead." });
    }
    const from = await checkIssuerAccount(client, userId, invoice.issuer_account_id);
    await checkClient(client, userId, invoice.client_id);
    if (invoice.due_date_text < from.today) {
      throw new ValidationError({ details: { due_date: ["The due date has passed. Change it before sending."] } });
    }
    await markSent(client, invoice.invoice_id, userId);
    await emailIfWanted(client, invoice.invoice_id, userId, body.send_email);
  });

  return res.status(200).json(await findVisibleInvoice(pool, userId, req.params.invoiceId, { withEmails: true }));
}

// POST /v1/invoices/:invoiceId/remind  { message? }
// Emails the client a reminder with the pay link. At most once an hour.
export async function remindInvoice(req, res) {
  const body = parseBody(remindSchema, req.body, { allowEmpty: true });
  const userId = req.user.sub;

  const email = await withTransaction(async (client) => {
    const invoice = await lockOwnInvoice(client, userId, req.params.invoiceId);
    const loaded = await loadInvoice(client, invoice.invoice_id, userId);
    const status = loaded.invoice.invoice_status;
    if (status !== "open" && status !== "overdue") {
      throw new ConflictError({ message: `Only an unpaid sent invoice can be reminded; this one is ${status}.` });
    }
    if (!loaded.invoice.client?.email) {
      throw new ValidationError({
        details: { client_id: ["This client has no email address. Add one, or share the pay link instead."] },
      });
    }
    const recent = await client.query(
      `SELECT 1 FROM email_log
       WHERE invoice_id = $1 AND kind IN ('invoice', 'reminder')
         AND created_at > NOW() - make_interval(mins => $2)`,
      [invoice.invoice_id, REMINDER_INTERVAL_MINUTES],
    );
    if (recent.rowCount > 0) {
      throw new TooManyRequestsError({
        message: `This client was emailed about this invoice less than ${REMINDER_INTERVAL_MINUTES} minutes ago. Try again later.`,
      });
    }
    return emailInvoice(client, loaded.invoice, { kind: "reminder", message: body.message, userId });
  });

  return res.status(202).json(email);
}

// POST /v1/invoices/:invoiceId/pay
// Only the billed user pays. It posts a real invoice_payment transaction
// from their chosen account into the issuer's account and links it back as
// settling_transaction_id, all in one DB transaction (API doc 8.2).
export async function payInvoice(req, res) {
  const { invoiceId } = req.params;
  if (!isUuid(invoiceId)) throw notFound();
  const body = parseBody(paySchema, req.body);
  const userId = req.user.sub;

  const replayed = await payFromWallet({
    userId,
    idempotencyKey: `${userId}:${req.idempotencyKey}`,
    sourceAccountId: body.source_account_id,
    lockInvoice: async (client) => {
      const found = await client.query(
        `SELECT i.*, ba.user_id AS billed_user_id, c.name AS client_name
         FROM invoices i
         LEFT JOIN account ba ON ba.account_id = i.account_id
         LEFT JOIN clients c ON c.client_id = i.client_id
         WHERE i.invoice_id = $1
         FOR UPDATE OF i`,
        [invoiceId],
      );
      const invoice = found.rows[0];
      if (!invoice || ![invoice.issuer_user_id, invoice.billed_user_id].includes(userId) || invoice.invoice_status === "draft") {
        throw notFound();
      }
      if (invoice.billed_user_id !== userId) {
        throw new ForbiddenError({ message: "Only the billed account's owner can pay this invoice." });
      }
      return invoice;
    },
  });

  if (replayed) res.set("Idempotent-Replayed", "true");
  const invoice = await findVisibleInvoice(pool, userId, invoiceId);
  return res.status(200).json({
    invoice_id: invoice.invoice_id,
    invoice_status: invoice.invoice_status,
    settling_transaction_id: invoice.settling_transaction_id,
  });
}

/**
 * Pays an invoice from one of the caller's wallets, exactly once per
 * idempotency key. lockInvoice(client) loads and locks the invoice row and
 * decides who may pay it. Returns true if this was a replay.
 */
export async function payFromWallet({ userId, idempotencyKey, sourceAccountId, lockInvoice }) {
  let invoiceId;
  const isSamePayment = async (existing) => {
    if (existing.transaction_type !== "invoice_payment") return false;
    if (existing.sender_account_id !== sourceAccountId) return false;
    const settled = await pool.query(`SELECT 1 FROM invoices WHERE settling_transaction_id = $1`, [existing.transaction_id]);
    return settled.rowCount > 0;
  };

  const { replayed } = await postOnce(
    idempotencyKey,
    async (client) => {
      await requireVerifiedKyc(client, userId, KYC_TO_PAY);
      const invoice = await lockInvoice(client);
      invoiceId = invoice.invoice_id;
      if (invoice.invoice_status !== "open") {
        throw new ConflictError({
          message: `This invoice is already ${invoice.invoice_status} and can't be paid.`,
        });
      }
      if (invoice.issuer_user_id === userId) {
        throw new ValidationError({ details: { source_account_id: ["You can't pay your own invoice."] } });
      }

      const source = await client.query(
        `SELECT 1 FROM account WHERE account_id = $1 AND user_id = $2 AND NOT is_system`,
        [sourceAccountId, userId],
      );
      if (source.rowCount === 0) {
        throw new ValidationError({ details: { source_account_id: ["Account not found."] } });
      }

      // postTransaction checks the source is active, in the invoice's
      // currency and can afford it, and that the issuer's account isn't closed.
      const posted = await postTransaction(client, {
        transactionType: "invoice_payment",
        senderAccountId: sourceAccountId,
        receiverAccountId: invoice.issuer_account_id,
        amountMinor: invoice.amount_due_minor,
        currencyCode: invoice.currency_code,
        description: paymentDescription(invoice),
        idempotencyKey,
        invoiceId: invoice.invoice_id,
      });

      await settleInvoice(client, invoice, posted, { actorId: userId, payerAccountId: sourceAccountId });
      const clientEmail = invoice.client_id
        ? (await client.query(`SELECT email FROM clients WHERE client_id = $1`, [invoice.client_id])).rows[0]?.email
        : null;
      await emailReceipt(client, invoice.invoice_id, clientEmail);
      return posted;
    },
    isSamePayment,
  );
  return { replayed, invoiceId };
}

// POST /v1/invoices/:invoiceId/refund
// The issuer (who received the money), or a back-office caller settling a
// dispute, returns a paid invoice's payment in full. Like a transfer
// reversal (API doc 6.3) it's a new refund transaction in the opposite
// direction, from the issuer's account back to the account that paid; the
// original payment's ledger rows are untouched, only its status moves to
// reversed. The billed user can't refund themselves. A payment made by
// card or bank transfer on the pay link can't be returned this way.
export async function refundInvoice(req, res) {
  const { invoiceId } = req.params;
  if (!isUuid(invoiceId)) throw notFound();
  const validation = refundSchema.safeParse(req.body ?? {});
  if (!validation.success) {
    throw new ValidationError({ details: validationDetails(validation.error) });
  }
  const { reason = null } = validation.data;
  const userId = req.internalCaller ? null : req.user.sub;
  const idempotencyKey = `${userId ?? "internal"}:${req.idempotencyKey}`;

  const isSameRefund = async (existing) => {
    const settled = await pool.query(
      `SELECT 1 FROM invoices WHERE invoice_id = $1 AND settling_transaction_id = $2`,
      [invoiceId, existing.reverses_transaction_id],
    );
    return settled.rowCount > 0;
  };

  const { replayed } = await postOnce(idempotencyKey, async (client) => {
    const found = await client.query(
      `SELECT i.invoice_status, i.issuer_account_id, i.settling_transaction_id, i.issuer_user_id,
              ba.user_id AS billed_user_id,
              t.sender_account_id AS paid_from_account_id, t.amount_minor, t.currency_code,
              sa.is_system AS paid_from_system
       FROM invoices i
       LEFT JOIN account ba ON ba.account_id = i.account_id
       LEFT JOIN transactions t ON t.transaction_id = i.settling_transaction_id
       LEFT JOIN account sa ON sa.account_id = t.sender_account_id
       WHERE i.invoice_id = $1
       FOR UPDATE OF i`,
      [invoiceId],
    );
    const invoice = found.rows[0];
    if (!invoice) throw notFound();
    if (userId) {
      if (![invoice.issuer_user_id, invoice.billed_user_id].includes(userId)) throw notFound();
      if (invoice.issuer_user_id !== userId) {
        throw new ForbiddenError({ message: "Only the issuer can refund this invoice." });
      }
      await requireVerifiedKyc(client, userId, KYC_TO_PAY);
    }
    if (invoice.invoice_status !== "paid") {
      throw new ConflictError({
        message:
          invoice.invoice_status === "refunded"
            ? "This invoice has already been refunded."
            : `Only a paid invoice can be refunded; this one is ${invoice.invoice_status}.`,
      });
    }
    if (invoice.paid_from_system) {
      throw new ConflictError({
        message: "This invoice was paid by card or bank transfer on its pay link, so it can't be refunded to a wallet. Return the money to the payer directly.",
      });
    }

    // postTransaction checks the issuer's account is active and can cover
    // the refund, and that the account that paid isn't closed.
    const refund = await postTransaction(client, {
      transactionType: "refund",
      senderAccountId: invoice.issuer_account_id,
      receiverAccountId: invoice.paid_from_account_id,
      amountMinor: invoice.amount_minor,
      currencyCode: invoice.currency_code,
      description: `Refund of invoice ${invoiceId}`,
      idempotencyKey,
      reversesTransactionId: invoice.settling_transaction_id,
    });

    await client.query(
      `UPDATE transactions SET status = 'reversed' WHERE transaction_id = $1`,
      [invoice.settling_transaction_id],
    );
    await client.query(
      `UPDATE invoices
       SET invoice_status = 'refunded', refunded_at = NOW(), refund_reason = $2
       WHERE invoice_id = $1`,
      [invoiceId, reason],
    );
    await writeAudit(client, {
      actorId: userId,
      entityType: "invoice",
      entityId: invoiceId,
      action: "status_change",
      before: { invoice_status: "paid" },
      after: {
        invoice_status: "refunded",
        refund_transaction_id: refund.transaction_id,
        refund_reason: reason,
      },
    });
    return refund;
  }, isSameRefund);

  if (replayed) res.set("Idempotent-Replayed", "true");
  const { invoice } = await loadInvoice(pool, invoiceId, userId);
  return res.status(200).json({
    invoice_id: invoice.invoice_id,
    invoice_status: invoice.invoice_status,
    settling_transaction_id: invoice.settling_transaction_id,
    refund_transaction_id: invoice.refund_transaction_id,
    refund_reason: invoice.refund_reason,
  });
}

// POST /v1/invoices/:invoiceId/cancel
// The issuer withdraws an unpaid sent invoice, or a back-office caller
// cancels it. Its pay link stops working. Cancelling a paid invoice is a
// 409, never a silent success (API doc 8.2).
export async function cancelInvoice(req, res) {
  const { invoiceId } = req.params;
  if (!isUuid(invoiceId)) throw notFound();
  const userId = req.internalCaller ? null : req.user.sub;

  await withTransaction(async (client) => {
    const found = await client.query(
      `SELECT i.invoice_status, i.issuer_user_id, ba.user_id AS billed_user_id
       FROM invoices i
       LEFT JOIN account ba ON ba.account_id = i.account_id
       WHERE i.invoice_id = $1
       FOR UPDATE OF i`,
      [invoiceId],
    );
    const invoice = found.rows[0];
    if (!invoice) throw notFound();
    if (userId) {
      if (![invoice.issuer_user_id, invoice.billed_user_id].includes(userId)) throw notFound();
      if (invoice.issuer_user_id !== userId) {
        throw new ForbiddenError({ message: "Only the issuer can cancel this invoice." });
      }
    }
    if (invoice.invoice_status !== "open") {
      throw new ConflictError({
        message:
          invoice.invoice_status === "paid"
            ? "This invoice has already been paid, so it can't be cancelled."
            : invoice.invoice_status === "draft"
              ? "This invoice is a draft. Delete it instead."
              : "This invoice is already cancelled.",
      });
    }

    await client.query(
      `UPDATE invoices SET invoice_status = 'cancelled', cancelled_at = NOW()
       WHERE invoice_id = $1`,
      [invoiceId],
    );
    await writeAudit(client, {
      actorId: userId,
      entityType: "invoice",
      entityId: invoiceId,
      action: "status_change",
      before: { invoice_status: "open" },
      after: { invoice_status: "cancelled" },
    });
  });

  const { invoice } = await loadInvoice(pool, invoiceId, userId);
  return res.status(200).json(invoice);
}
