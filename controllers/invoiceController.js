import z from "zod";
import { pool } from "../db/connectDB.js";
import { withTransaction } from "../db/withTransaction.js";
import { postOnce, postTransaction } from "../services/ledger.js";
import { writeAudit } from "../utils/audit.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  KycRequiredError,
  NotFoundError,
  ValidationError,
} from "../utils/errorStr.js";
import { decodeCursor, encodeCursor } from "../utils/pagination.js";
import { isUuid, validationDetails } from "../utils/validation.js";

// An invoice is one user billing another (API doc 8):
//
//   issuer_account_id  the issuer's account, which the payment goes into
//   account_id         the account billed, whose owner pays
//
// Stored status is open -> paid | cancelled. "overdue" is never stored: an
// open invoice past its due date (in the billed user's timezone) is reported
// as overdue when read, so it can't go stale waiting for a job. Overdue
// invoices can still be paid or cancelled.
//
// Paying locks the invoice row before the accounts (inside postTransaction),
// the same order loans use.

const minorAmount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const isoDate = z.iso.date("Use the format YYYY-MM-DD.");

// The billed account is named by id or by the 10-digit number a person would
// type; exactly one is required.
const createSchema = z
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

const paySchema = z.strictObject({
  source_account_id: z.uuid(),
});

const listQuerySchema = z.strictObject({
  role: z.enum(["all", "issued", "received"]).default("all"),
  status: z.enum(["open", "paid", "overdue", "cancelled"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  after: z.string().optional(),
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

const notFound = () => new NotFoundError({ message: "Invoice not found." });

async function requireVerifiedKyc(db, userId, message) {
  const result = await db.query(`SELECT kyc_status FROM users WHERE user_id = $1`, [userId]);
  if (result.rows[0]?.kyc_status !== "verified") throw new KycRequiredError({ message });
}

// Every read goes through this, so all endpoints report status the same way.
// $1 is always the caller's user_id (or NULL for a back-office caller).
const INVOICE_SELECT = `
    SELECT i.invoice_id,
           CASE WHEN i.invoice_status = 'open'
                 AND i.due_date < (NOW() AT TIME ZONE bu.timezone)::date
                THEN 'overdue'
                ELSE i.invoice_status::text
           END AS invoice_status,
           CASE WHEN ia.user_id = $1 THEN 'issued' ELSE 'received' END AS direction,
           i.issuer_account_id,
           ia.account_number AS issuer_account_number,
           NULLIF(concat_ws(' ', iu.first_name, iu.last_name), '') AS issuer_name,
           i.account_id,
           ba.account_number AS billed_account_number,
           i.amount_due_minor,
           i.currency_code,
           to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
           i.description,
           i.settling_transaction_id,
           i.paid_at,
           i.cancelled_at,
           i.created_at
    FROM invoices i
    JOIN account ia ON ia.account_id = i.issuer_account_id
    JOIN users iu ON iu.user_id = ia.user_id
    JOIN account ba ON ba.account_id = i.account_id
    JOIN users bu ON bu.user_id = ba.user_id`;

// Only the issuer and the billed user can see an invoice; anyone else gets 404.
async function findVisibleInvoice(db, userId, invoiceId) {
  if (!isUuid(invoiceId)) throw notFound();
  const result = await db.query(
    `${INVOICE_SELECT}
     WHERE i.invoice_id = $2 AND $1 IN (ia.user_id, ba.user_id)`,
    [userId, invoiceId],
  );
  if (result.rowCount === 0) throw notFound();
  return result.rows[0];
}

// POST /v1/invoices
export async function createInvoice(req, res) {
  const body = parseBody(createSchema, req.body);
  const userId = req.user.sub;

  const invoiceId = await withTransaction(async (client) => {
    await requireVerifiedKyc(
      client,
      userId,
      "Identity verification is required before you can send invoices.",
    );

    const issuer = await client.query(
      `SELECT a.account_type, a.account_status, a.currency_code,
              (NOW() AT TIME ZONE u.timezone)::date::text AS today
       FROM account a JOIN users u ON u.user_id = a.user_id
       WHERE a.account_id = $1 AND a.user_id = $2 AND NOT a.is_system`,
      [body.issuer_account_id, userId],
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
    if (body.due_date < from.today) {
      throw new ValidationError({ details: { due_date: ["Can't be in the past."] } });
    }

    const inserted = await client.query(
      `INSERT INTO invoices (
          issuer_account_id, account_id, amount_due_minor,
          currency_code, due_date, description
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING invoice_id`,
      [
        body.issuer_account_id,
        to.account_id,
        body.amount_due_minor,
        body.currency_code,
        body.due_date,
        body.description ?? null,
      ],
    );
    const id = inserted.rows[0].invoice_id;
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

// GET /v1/invoices?role=all|issued|received&status=&limit=&after=
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
               WHEN 'issued' THEN ia.user_id = $1
               WHEN 'received' THEN ba.user_id = $1
               ELSE $1 IN (ia.user_id, ba.user_id)
             END
     ) inv
     WHERE ($3::text IS NULL OR inv.invoice_status = $3)
       AND ($4::timestamptz IS NULL OR (inv.created_at, inv.invoice_id) < ($4::timestamptz, $5::uuid))
     ORDER BY inv.created_at DESC, inv.invoice_id DESC
     LIMIT $6`,
    [req.user.sub, q.role, q.status ?? null, cursor?.t ?? null, cursor?.id ?? null, q.limit + 1],
  );

  const hasMore = result.rows.length > q.limit;
  const page = result.rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return res.status(200).json({
    data: page.map(({ cursor_ts, ...invoice }) => invoice),
    next_cursor: hasMore ? encodeCursor(last.cursor_ts, last.invoice_id) : null,
    has_more: hasMore,
  });
}

// GET /v1/invoices/:invoiceId
export async function getInvoice(req, res) {
  return res.status(200).json(await findVisibleInvoice(pool, req.user.sub, req.params.invoiceId));
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
  const idempotencyKey = `${userId}:${req.idempotencyKey}`;

  const isSamePayment = async (existing) => {
    if (existing.transaction_type !== "invoice_payment") return false;
    if (existing.sender_account_id !== body.source_account_id) return false;
    const settled = await pool.query(
      `SELECT 1 FROM invoices WHERE invoice_id = $1 AND settling_transaction_id = $2`,
      [invoiceId, existing.transaction_id],
    );
    return settled.rowCount > 0;
  };

  const { replayed } = await postOnce(idempotencyKey, async (client) => {
    await requireVerifiedKyc(
      client,
      userId,
      "Identity verification is required before you can move money.",
    );

    const found = await client.query(
      `SELECT i.invoice_id, i.invoice_status, i.issuer_account_id, i.amount_due_minor,
              i.currency_code, ia.user_id AS issuer_user_id, ba.user_id AS billed_user_id
       FROM invoices i
       JOIN account ia ON ia.account_id = i.issuer_account_id
       JOIN account ba ON ba.account_id = i.account_id
       WHERE i.invoice_id = $1
       FOR UPDATE OF i`,
      [invoiceId],
    );
    const invoice = found.rows[0];
    if (!invoice || ![invoice.issuer_user_id, invoice.billed_user_id].includes(userId)) {
      throw notFound();
    }
    if (invoice.billed_user_id !== userId) {
      throw new ForbiddenError({ message: "Only the billed account's owner can pay this invoice." });
    }
    if (invoice.invoice_status !== "open") {
      throw new ConflictError({
        message: `This invoice is already ${invoice.invoice_status} and can't be paid.`,
      });
    }

    const source = await client.query(
      `SELECT 1 FROM account WHERE account_id = $1 AND user_id = $2 AND NOT is_system`,
      [body.source_account_id, userId],
    );
    if (source.rowCount === 0) {
      throw new ValidationError({ details: { source_account_id: ["Account not found."] } });
    }
    if (body.source_account_id === invoice.issuer_account_id) {
      throw new ValidationError({
        details: { source_account_id: ["Can't pay an invoice from the account it pays into."] },
      });
    }

    // postTransaction checks the source is active, in the invoice's currency
    // and can afford it, and that the issuer's account isn't closed.
    const posted = await postTransaction(client, {
      transactionType: "invoice_payment",
      senderAccountId: body.source_account_id,
      receiverAccountId: invoice.issuer_account_id,
      amountMinor: invoice.amount_due_minor,
      currencyCode: invoice.currency_code,
      description: `Invoice ${invoice.invoice_id}`,
      idempotencyKey,
    });

    await client.query(
      `UPDATE invoices
       SET invoice_status = 'paid', settling_transaction_id = $2, paid_at = NOW()
       WHERE invoice_id = $1`,
      [invoiceId, posted.transaction_id],
    );
    await writeAudit(client, {
      actorId: userId,
      entityType: "invoice",
      entityId: invoiceId,
      action: "status_change",
      before: { invoice_status: "open" },
      after: { invoice_status: "paid", settling_transaction_id: posted.transaction_id },
    });
    return posted;
  }, isSamePayment);

  if (replayed) res.set("Idempotent-Replayed", "true");
  const invoice = await findVisibleInvoice(pool, userId, invoiceId);
  return res.status(200).json({
    invoice_id: invoice.invoice_id,
    invoice_status: invoice.invoice_status,
    settling_transaction_id: invoice.settling_transaction_id,
  });
}

// POST /v1/invoices/:invoiceId/cancel
// The issuer withdraws an unpaid invoice, or a back-office caller cancels it.
// Cancelling a paid invoice is a 409, never a silent success (API doc 8.2).
export async function cancelInvoice(req, res) {
  const { invoiceId } = req.params;
  if (!isUuid(invoiceId)) throw notFound();
  const userId = req.internalCaller ? null : req.user.sub;

  await withTransaction(async (client) => {
    const found = await client.query(
      `SELECT i.invoice_status, ia.user_id AS issuer_user_id, ba.user_id AS billed_user_id
       FROM invoices i
       JOIN account ia ON ia.account_id = i.issuer_account_id
       JOIN account ba ON ba.account_id = i.account_id
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

  const result = await pool.query(
    `${INVOICE_SELECT} WHERE i.invoice_id = $2`,
    [userId, invoiceId],
  );
  return res.status(200).json(result.rows[0]);
}
