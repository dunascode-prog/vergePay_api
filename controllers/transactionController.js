import z from "zod";
import { pool } from "../db/connectDB.js";
import { postOnce, postTransaction } from "../services/ledger.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  KycRequiredError,
  NotFoundError,
  ValidationError,
} from "../utils/errorStr.js";
import { isUuid, validationDetails } from "../utils/validation.js";

const minorAmount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

// The receiver can be named by id or by the 10-digit account number a person
// would actually type; exactly one of the two is required.
const transferSchema = z
  .strictObject({
    transaction_type: z.literal("transfer").optional(),
    sender_account_id: z.uuid(),
    receiver_account_id: z.uuid().optional(),
    receiver_account_number: z.string().trim().regex(/^\d{10}$/, "Must be a 10-digit account number.").optional(),
    amount_minor: minorAmount,
    currency_code: z.string().trim().toUpperCase().length(3),
    description: z.string().trim().max(255).optional(),
  })
  .refine((b) => Boolean(b.receiver_account_id) !== Boolean(b.receiver_account_number), {
    message: "Send exactly one of receiver_account_id or receiver_account_number.",
    path: ["receiver_account_id"],
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

// Money only moves for verified users (API doc 2.1).
async function requireVerifiedKyc(db, userId) {
  const result = await db.query(`SELECT kyc_status FROM users WHERE user_id = $1`, [userId]);
  if (result.rows[0]?.kyc_status !== "verified") throw new KycRequiredError();
}

// Stored keys are namespaced per user so two users can't collide.
function storedKey(req) {
  return `${req.user.sub}:${req.idempotencyKey}`;
}

// Loads one of the caller's own (non-system) accounts, or 404.
async function findOwnAccount(db, userId, accountId, { lock = false } = {}) {
  if (!isUuid(accountId)) throw new NotFoundError({ message: "Account not found." });
  const result = await db.query(
    `SELECT account_id, currency_code FROM account
     WHERE account_id = $1 AND user_id = $2 AND NOT is_system
     ${lock ? "FOR UPDATE" : ""}`,
    [accountId, userId],
  );
  if (result.rowCount === 0) throw new NotFoundError({ message: "Account not found." });
  return result.rows[0];
}

function transferResponse(txn) {
  const { ledger_entries, reverses_transaction_id, ...rest } = txn;
  return rest;
}

// POST /v1/transactions
export async function createTransfer(req, res) {
  const body = parseBody(transferSchema, req.body);

  const idempotencyKey = storedKey(req);

  // A replay must be the same transfer: same sender, receiver, amount and
  // currency as the one already posted under this key.
  const isSameTransfer = async (existing) => {
    if (
      existing.transaction_type !== "transfer" ||
      existing.sender_account_id !== body.sender_account_id ||
      existing.amount_minor !== body.amount_minor ||
      existing.currency_code !== body.currency_code
    ) {
      return false;
    }
    if (body.receiver_account_id) return existing.receiver_account_id === body.receiver_account_id;
    const receiver = await pool.query(`SELECT account_number FROM account WHERE account_id = $1`, [
      existing.receiver_account_id,
    ]);
    return receiver.rows[0]?.account_number === body.receiver_account_number;
  };

  const { transaction, replayed } = await postOnce(idempotencyKey, async (client) => {
    await requireVerifiedKyc(client, req.user.sub);
    await findOwnAccount(client, req.user.sub, body.sender_account_id);

    // Resolve the receiver. System accounts are never a valid destination.
    const receiver = await client.query(
      body.receiver_account_id
        ? `SELECT account_id FROM account WHERE account_id = $1 AND NOT is_system`
        : `SELECT account_id FROM account WHERE account_number = $1 AND NOT is_system`,
      [body.receiver_account_id ?? body.receiver_account_number],
    );
    if (receiver.rowCount === 0) {
      const field = body.receiver_account_id ? "receiver_account_id" : "receiver_account_number";
      throw new ValidationError({ details: { [field]: ["No account with this number."] } });
    }
    const receiverAccountId = receiver.rows[0].account_id;
    if (receiverAccountId === body.sender_account_id) {
      throw new ValidationError({
        details: { receiver_account_id: ["You can't send money to the same account."] },
      });
    }

    return postTransaction(client, {
      transactionType: "transfer",
      senderAccountId: body.sender_account_id,
      receiverAccountId,
      amountMinor: body.amount_minor,
      currencyCode: body.currency_code,
      description: body.description,
      idempotencyKey,
    });
  }, isSameTransfer);

  if (replayed) res.set("Idempotent-Replayed", "true");
  return res.status(201).json(transferResponse(transaction));
}

// GET /v1/transactions/:transactionId  (caller must own the sender or receiver)
export async function getTransaction(req, res) {
  const { transactionId } = req.params;
  if (!isUuid(transactionId)) throw new NotFoundError({ message: "Transaction not found." });

  const result = await pool.query(
    `SELECT t.transaction_id, t.transaction_type, t.sender_account_id,
            t.receiver_account_id, t.amount_minor, t.currency_code, t.status,
            t.description, t.reverses_transaction_id, t.created_at, t.settled_at,
            (SELECT r.transaction_id FROM transactions r
             WHERE r.reverses_transaction_id = t.transaction_id) AS reversed_by_transaction_id
     FROM transactions t
     WHERE t.transaction_id = $1
       AND EXISTS (
         SELECT 1 FROM account a
         WHERE a.account_id IN (t.sender_account_id, t.receiver_account_id)
           AND a.user_id = $2
       )`,
    [transactionId, req.user.sub],
  );
  if (result.rowCount === 0) throw new NotFoundError({ message: "Transaction not found." });

  const entries = await pool.query(
    `SELECT entry_id, account_id, direction, amount_minor, running_balance_after_minor, created_at
     FROM ledger_entries
     WHERE transaction_id = $1
     ORDER BY direction`,
    [transactionId],
  );

  return res.status(200).json({ ...result.rows[0], ledger_entries: entries.rows });
}

// POST /v1/transactions/:transactionId/reverse
// The recipient returns a settled transfer. The reversal is a brand-new
// transaction in the opposite direction; the original's ledger rows are never
// touched, only its status moves to reversed (API doc 6.3). Only the
// receiving side may reverse, so a sender can't claw money back on their own.
export async function reverseTransaction(req, res) {
  const { transactionId } = req.params;
  if (!isUuid(transactionId)) throw new NotFoundError({ message: "Transaction not found." });

  const idempotencyKey = storedKey(req);
  const isSameReversal = (existing) => existing.reverses_transaction_id === transactionId;

  const { transaction: reversal, replayed } = await postOnce(idempotencyKey, async (client) => {
    await requireVerifiedKyc(client, req.user.sub);

    const found = await client.query(
      `SELECT t.transaction_id, t.transaction_type, t.status, t.sender_account_id,
              t.receiver_account_id, t.amount_minor, t.currency_code,
              s.user_id AS sender_user_id, r.user_id AS receiver_user_id
       FROM transactions t
       LEFT JOIN account s ON s.account_id = t.sender_account_id
       LEFT JOIN account r ON r.account_id = t.receiver_account_id
       WHERE t.transaction_id = $1
       FOR UPDATE OF t`,
      [transactionId],
    );
    const original = found.rows[0];
    const isParty =
      original &&
      [original.sender_user_id, original.receiver_user_id].includes(req.user.sub);
    if (!isParty) throw new NotFoundError({ message: "Transaction not found." });

    if (original.receiver_user_id !== req.user.sub) {
      throw new ForbiddenError({
        message: "Only the account that received this payment can reverse it.",
      });
    }
    if (original.transaction_type !== "transfer" || original.status !== "settled") {
      throw new ConflictError({
        message: `Can't reverse a ${original.transaction_type} that is ${original.status}.`,
      });
    }

    const refund = await postTransaction(client, {
      transactionType: "refund",
      senderAccountId: original.receiver_account_id,
      receiverAccountId: original.sender_account_id,
      amountMinor: original.amount_minor,
      currencyCode: original.currency_code,
      description: `Reversal of ${original.transaction_id}`,
      idempotencyKey,
      reversesTransactionId: original.transaction_id,
    });

    await client.query(
      `UPDATE transactions SET status = 'reversed' WHERE transaction_id = $1`,
      [original.transaction_id],
    );

    return refund;
  }, isSameReversal);

  if (replayed) res.set("Idempotent-Replayed", "true");
  return res.status(201).json({
    reversal_transaction_id: reversal.transaction_id,
    original_transaction_id: reversal.reverses_transaction_id,
    status: reversal.status,
  });
}

// ---------------------------------------------------------------------------
// History

const isoDate = z.iso.date("Use the format YYYY-MM-DD.");

const historyQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  after: z.string().optional(),
  status: z.enum(["pending", "settled", "failed", "reversed"]).optional(),
  from_date: isoDate.optional(),
  to_date: isoDate.optional(),
});

function parseQuery(schema, query) {
  const validation = schema.safeParse(query);
  if (!validation.success) {
    throw new ValidationError({ details: validationDetails(validation.error) });
  }
  return validation.data;
}

// Cursors are opaque to clients: base64url of the last row's position.
function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ t: row.cursor_ts, id: row.entry_id })).toString("base64url");
}

function decodeCursor(cursor) {
  try {
    const { t, id } = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof t === "string" && isUuid(id) && !Number.isNaN(Date.parse(t))) return { t, id };
  } catch {
    // fall through
  }
  throw new BadRequestError({ message: "Invalid pagination cursor." });
}

// GET /v1/accounts/:accountId/transactions
// Reads the account's own ledger entries, so direction and running balance
// come straight from the ledger; counterparty is derived for display.
export async function listAccountTransactions(req, res) {
  const account = await findOwnAccount(pool, req.user.sub, req.params.accountId);
  const q = parseQuery(historyQuerySchema, req.query);
  const cursor = q.after ? decodeCursor(q.after) : null;

  const result = await pool.query(
    `SELECT t.transaction_id,
            t.transaction_type,
            lower(le.direction::text) AS direction,
            c.account_id AS counterparty_account_id,
            c.account_number AS counterparty_account_number,
            le.amount_minor,
            t.currency_code,
            t.status,
            t.description,
            le.running_balance_after_minor,
            t.created_at,
            le.entry_id,
            le.created_at::text AS cursor_ts
     FROM ledger_entries le
     JOIN transactions t ON t.transaction_id = le.transaction_id
     LEFT JOIN account c ON c.account_id =
          CASE WHEN le.direction = 'DEBIT' THEN t.receiver_account_id ELSE t.sender_account_id END
     WHERE le.account_id = $1
       AND ($2::timestamptz IS NULL OR (le.created_at, le.entry_id) < ($2::timestamptz, $3::uuid))
       AND ($4::transaction_status_enum IS NULL OR t.status = $4::transaction_status_enum)
       AND ($5::date IS NULL OR le.created_at >= ($5::date)::timestamp AT TIME ZONE 'UTC')
       AND ($6::date IS NULL OR le.created_at < ($6::date + 1)::timestamp AT TIME ZONE 'UTC')
     ORDER BY le.created_at DESC, le.entry_id DESC
     LIMIT $7`,
    [
      account.account_id,
      cursor?.t ?? null,
      cursor?.id ?? null,
      q.status ?? null,
      q.from_date ?? null,
      q.to_date ?? null,
      q.limit + 1,
    ],
  );

  const hasMore = result.rows.length > q.limit;
  const page = result.rows.slice(0, q.limit);
  const nextCursor = hasMore ? encodeCursor(page[page.length - 1]) : null;

  return res.status(200).json({
    data: page.map(({ entry_id, cursor_ts, ...row }) => row),
    next_cursor: nextCursor,
    has_more: hasMore,
  });
}

// GET /v1/accounts/:accountId/balance-history
// Closing balance per day/week/month, with quiet periods carried forward, so
// a chart doesn't have to replay every transaction (API doc 4.5).
const balanceHistorySchema = z.strictObject({
  interval: z.enum(["day", "week", "month"]).default("day"),
  from_date: isoDate.optional(),
  to_date: isoDate.optional(),
});

const DEFAULT_SPAN_DAYS = { day: 29, week: 7 * 11, month: 365 };
const MAX_BUCKETS = 366;

export async function getBalanceHistory(req, res) {
  const account = await findOwnAccount(pool, req.user.sub, req.params.accountId);
  const q = parseQuery(balanceHistorySchema, req.query);

  const toDate = q.to_date ?? new Date().toISOString().slice(0, 10);
  const fromDate =
    q.from_date ??
    new Date(Date.parse(toDate) - DEFAULT_SPAN_DAYS[q.interval] * 86_400_000)
      .toISOString()
      .slice(0, 10);
  if (fromDate > toDate) {
    throw new ValidationError({ details: { from_date: ["Must be on or before to_date."] } });
  }

  const result = await pool.query(
    `WITH buckets AS (
       SELECT generate_series(
                date_trunc($2, ($3::date)::timestamp),
                date_trunc($2, ($4::date)::timestamp),
                ('1 ' || $2)::interval
              ) AS bucket_start
     )
     SELECT to_char(b.bucket_start, 'YYYY-MM-DD') AS period_start,
            COALESCE((
              SELECT le.running_balance_after_minor
              FROM ledger_entries le
              WHERE le.account_id = $1
                AND le.created_at < (b.bucket_start + ('1 ' || $2)::interval) AT TIME ZONE 'UTC'
              ORDER BY le.created_at DESC, le.entry_id DESC
              LIMIT 1
            ), 0) AS closing_balance_minor
     FROM buckets b
     ORDER BY b.bucket_start
     LIMIT ${MAX_BUCKETS + 1}`,
    [account.account_id, q.interval, fromDate, toDate],
  );

  if (result.rows.length > MAX_BUCKETS) {
    throw new ValidationError({
      details: { from_date: [`That range has more than ${MAX_BUCKETS} ${q.interval}s. Narrow it or use a larger interval.`] },
    });
  }

  return res.status(200).json({
    account_id: account.account_id,
    currency_code: account.currency_code,
    interval: q.interval,
    data: result.rows,
  });
}
