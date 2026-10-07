import z from "zod";
import { pool } from "../db/connectDB.js";
import { withTransaction } from "../db/withTransaction.js";
import { postTransaction } from "../services/ledger.js";
import { formatMoney } from "../services/notifications.js";
import { loadPayee, loadPayees, loadRun, loadRuns, payeePayments } from "../services/payroll.js";
import { writeAudit } from "../utils/audit.js";
import {
  BadRequestError,
  ConflictError,
  InsufficientFundsError,
  KycRequiredError,
  NotFoundError,
  ValidationError,
} from "../utils/errorStr.js";
import { IdempotencyConflictError } from "../utils/idempotency.js";
import { isUuid, validationDetails } from "../utils/validation.js";

// Payroll (db/migrations.db/payroll.sql). Payees are other VergePay
// customers' wallets. A pay run pays one or more of them from one of the
// caller's wallets in a single DB transaction: every payment goes through,
// or none does. Each payment is its own ledger transaction (payroll_payment),
// so each payee gets their own credit alert.

const MAX_PAYEES = 200;
const MAX_RUN_ITEMS = 50;

const amountMinor = z.number().int().positive().max(1_000_000_000_000);
const name = z.string().trim().min(1, "Enter a name.").max(120);
const role = z.string().trim().min(1).max(80);
const payType = z.enum(["retainer", "per_project", "hourly"]);
const frequency = z.enum(["monthly", "biweekly", "one_off"]);

const createPayeeSchema = z.strictObject({
  account_number: z.string().trim().regex(/^\d{10}$/, "Enter a 10-digit account number."),
  name: name.optional(),
  role: role.optional(),
  pay_type: payType,
  frequency,
  rate_minor: amountMinor,
});

const updatePayeeSchema = z
  .strictObject({
    name: name.optional(),
    role: role.nullable().optional(),
    pay_type: payType.optional(),
    frequency: frequency.optional(),
    rate_minor: amountMinor.optional(),
    payee_status: z.enum(["active", "inactive"]).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to change." });

const listPayeesSchema = z.strictObject({
  status: z.enum(["active", "inactive", "all"]).default("all"),
});

const runSchema = z
  .strictObject({
    source_account_id: z.uuid(),
    items: z
      .array(z.strictObject({ payee_id: z.uuid(), amount_minor: amountMinor.optional() }))
      .min(1, "Pick at least one payee.")
      .max(MAX_RUN_ITEMS, `A run can pay up to ${MAX_RUN_ITEMS} payees.`),
    note: z.string().trim().min(1).max(120).optional(),
  })
  .refine((b) => new Set(b.items.map((i) => i.payee_id)).size === b.items.length, {
    message: "Each payee can only be paid once in a run.",
    path: ["items"],
  });

function parse(schema, body) {
  if (!body || Object.keys(body).length === 0) throw new BadRequestError({ message: "Request body is empty." });
  const validation = schema.safeParse(body);
  if (!validation.success) throw new ValidationError({ details: validationDetails(validation.error) });
  return validation.data;
}

const payeeNotFound = () => new NotFoundError({ message: "Payee not found." });
const runNotFound = () => new NotFoundError({ message: "Pay run not found." });

async function requireVerifiedKyc(db, userId) {
  const result = await db.query(`SELECT kyc_status FROM users WHERE user_id = $1`, [userId]);
  if (result.rows[0]?.kyc_status !== "verified") throw new KycRequiredError();
}

async function findOwnPayee(userId, payeeId) {
  if (!isUuid(payeeId)) throw payeeNotFound();
  const payee = await loadPayee(pool, userId, payeeId);
  if (!payee) throw payeeNotFound();
  return payee;
}

// ---------------------------------------------------------------------------
// Payees

// POST /v1/payees  { account_number, name?, role?, pay_type, frequency, rate_minor }
// The payee is named by their wallet's account number, like a transfer.
// Adding one shows the wallet holder's name, so it needs a verified
// identity, the same as a name lookup.
export async function createPayee(req, res) {
  const body = parse(createPayeeSchema, req.body);
  const userId = req.user.sub;
  await requireVerifiedKyc(pool, userId);

  const found = await pool.query(
    `SELECT a.account_id, a.user_id, a.currency_code,
            COALESCE(NULLIF(concat_ws(' ', u.first_name, u.last_name), ''), u.username) AS account_name
     FROM account a JOIN users u ON u.user_id = a.user_id
     WHERE a.account_number = $1 AND NOT a.is_system AND a.account_type = 'current' AND a.account_status <> 'closed'`,
    [body.account_number],
  );
  const wallet = found.rows[0];
  if (!wallet) throw new ValidationError({ details: { account_number: ["No VergePay wallet has that account number."] } });
  if (wallet.user_id === userId) {
    throw new ValidationError({ details: { account_number: ["That's your own wallet. Move money between your wallets with a transfer."] } });
  }

  const payeeId = await withTransaction(async (client) => {
    await client.query(`SELECT 1 FROM users WHERE user_id = $1 FOR UPDATE`, [userId]);
    const count = await client.query(`SELECT count(*)::int AS n FROM payees WHERE user_id = $1`, [userId]);
    if (count.rows[0].n >= MAX_PAYEES) {
      throw new ConflictError({ message: `You can have up to ${MAX_PAYEES} payees.` });
    }
    try {
      await client.query("SAVEPOINT add_payee");
      const inserted = await client.query(
        `INSERT INTO payees (user_id, account_id, name, role, pay_type, frequency, rate_minor, currency_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING payee_id`,
        [userId, wallet.account_id, body.name ?? wallet.account_name, body.role ?? null, body.pay_type, body.frequency, body.rate_minor, wallet.currency_code],
      );
      const id = inserted.rows[0].payee_id;
      await writeAudit(client, { actorId: userId, entityType: "payee", entityId: id, action: "create", after: body });
      return id;
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT add_payee");
      if (err.code === "23505" && err.constraint === "uq_payee_wallet") {
        throw new ConflictError({ message: "This wallet is already one of your payees.", field: "account_number" });
      }
      throw err;
    }
  });

  return res.status(201).json(await loadPayee(pool, userId, payeeId));
}

// GET /v1/payees?status=active|inactive|all  (alphabetical)
export async function listPayees(req, res) {
  const validation = listPayeesSchema.safeParse(req.query);
  if (!validation.success) throw new ValidationError({ details: validationDetails(validation.error) });
  const data = await loadPayees(
    pool,
    req.user.sub,
    "AND ($2::text = 'all' OR p.payee_status::text = $2)",
    [validation.data.status],
  );
  return res.status(200).json({ data });
}

// GET /v1/payees/:payeeId  (with their latest payments)
export async function getPayee(req, res) {
  const payee = await findOwnPayee(req.user.sub, req.params.payeeId);
  payee.payments = await payeePayments(pool, payee.payee_id);
  return res.status(200).json(payee);
}

// PATCH /v1/payees/:payeeId  { name?, role?, pay_type?, frequency?, rate_minor?, payee_status? }
// The wallet can't change: someone paid into a different wallet is a new payee.
export async function updatePayee(req, res) {
  const body = parse(updatePayeeSchema, req.body);
  const userId = req.user.sub;
  const current = await findOwnPayee(userId, req.params.payeeId);
  const next = (field) => (field in body ? body[field] : current[field]);

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE payees
       SET name = $2, role = $3, pay_type = $4, frequency = $5, rate_minor = $6, payee_status = $7, updated_at = NOW()
       WHERE payee_id = $1`,
      [current.payee_id, next("name"), next("role"), next("pay_type"), next("frequency"), next("rate_minor"), next("payee_status")],
    );
    const pick = ({ name, role, pay_type, frequency, rate_minor, payee_status }) => ({ name, role, pay_type, frequency, rate_minor, payee_status });
    await writeAudit(client, {
      actorId: userId,
      entityType: "payee",
      entityId: current.payee_id,
      action: "update",
      before: pick(current),
      after: pick({ ...current, ...body }),
    });
  });

  return res.status(200).json(await loadPayee(pool, userId, current.payee_id));
}

// ---------------------------------------------------------------------------
// Pay runs

const isDuplicateRunKey = (err) => err.code === "23505" && err.constraint === "payroll_runs_idempotency_key_key";

// The run already stored under this key, if any. A key reused for a
// different run (another wallet or other payees and amounts) is a 422.
async function replayRun(userId, runKey, body) {
  const found = await pool.query(`SELECT run_id FROM payroll_runs WHERE idempotency_key = $1`, [runKey]);
  if (found.rowCount === 0) return null;
  const run = await loadRun(pool, userId, found.rows[0].run_id);
  const sameItems =
    run.source_account_id === body.source_account_id &&
    run.payments.length === body.items.length &&
    body.items.every((item) =>
      run.payments.some((p) => p.payee_id === item.payee_id && (item.amount_minor === undefined || p.amount_minor === item.amount_minor)),
    );
  if (!sameItems) throw new IdempotencyConflictError();
  return run;
}

// POST /v1/payroll/runs  { source_account_id, items: [{ payee_id, amount_minor? }], note? }
// Pays every item from the wallet, each at its own amount or the payee's
// rate. All or nothing: one payee that can't be paid stops the whole run
// before any money moves.
export async function createRun(req, res) {
  const body = parse(runSchema, req.body);
  const userId = req.user.sub;
  const runKey = `${userId}:${req.idempotencyKey}`;

  // a retry after a lost reply is answered from what was committed
  const earlier = await replayRun(userId, runKey, body);
  if (earlier) {
    res.set("Idempotent-Replayed", "true");
    return res.status(201).json(earlier);
  }

  let runId;
  try {
    runId = await withTransaction(async (client) => {
      await requireVerifiedKyc(client, userId);

      const source = await client.query(
        `SELECT account_id, currency_code FROM account
         WHERE account_id = $1 AND user_id = $2 AND NOT is_system AND account_type = 'current'`,
        [body.source_account_id, userId],
      );
      if (source.rowCount === 0) {
        throw new ValidationError({ details: { source_account_id: ["Not one of your wallets."] } });
      }
      const currency = source.rows[0].currency_code;

      const found = await client.query(
        `SELECT p.payee_id, p.name, p.account_id, p.rate_minor, p.currency_code, p.payee_status, a.account_status
         FROM payees p JOIN account a ON a.account_id = p.account_id
         WHERE p.user_id = $1 AND p.payee_id = ANY($2::uuid[])`,
        [userId, body.items.map((i) => i.payee_id)],
      );
      const byId = new Map(found.rows.map((p) => [p.payee_id, p]));
      const problems = [];
      const payments = body.items.map((item) => {
        const payee = byId.get(item.payee_id);
        if (!payee) problems.push(`Payee ${item.payee_id} not found.`);
        else if (payee.payee_status !== "active") problems.push(`${payee.name} is inactive.`);
        else if (payee.currency_code !== currency) problems.push(`${payee.name} is paid in ${payee.currency_code}, but this wallet holds ${currency}.`);
        else if (payee.account_status === "closed") problems.push(`${payee.name}'s wallet is closed.`);
        return payee ? { payee, amount: item.amount_minor ?? payee.rate_minor } : null;
      });
      if (problems.length) throw new ValidationError({ message: "Some payees can't be paid.", details: { items: problems } });

      // Lock the wallet and every payee's wallet up front, in one order, so
      // two runs paying the same people can't deadlock part-way through.
      const total = payments.reduce((sum, p) => sum + p.amount, 0);
      const locked = await client.query(
        `SELECT account_id, account_status, balance_minor FROM account
         WHERE account_id = ANY($1::uuid[]) ORDER BY account_id FOR UPDATE`,
        [[body.source_account_id, ...payments.map((p) => p.payee.account_id)]],
      );
      const wallet = locked.rows.find((a) => a.account_id === body.source_account_id);
      if (wallet.account_status !== "active") {
        throw new ConflictError({ message: `This wallet is ${wallet.account_status} and can't send money.` });
      }
      if (wallet.balance_minor < total) {
        throw new InsufficientFundsError({
          message: `This run pays ${formatMoney(total, currency)}, but the wallet holds ${formatMoney(wallet.balance_minor, currency)}.`,
        });
      }

      const run = await client.query(
        `INSERT INTO payroll_runs (user_id, source_account_id, currency_code, idempotency_key, total_minor, payment_count, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING run_id`,
        [userId, body.source_account_id, currency, runKey, total, payments.length, body.note ?? null],
      );
      const id = run.rows[0].run_id;

      for (const [index, { payee, amount }] of payments.entries()) {
        const txn = await postTransaction(client, {
          transactionType: "payroll_payment",
          senderAccountId: body.source_account_id,
          receiverAccountId: payee.account_id,
          amountMinor: amount,
          currencyCode: currency,
          description: body.note ? `Payroll · ${body.note}` : "Payroll",
          idempotencyKey: `payroll:${id}:${index}`,
        });
        await client.query(
          `INSERT INTO payroll_payments (run_id, payee_id, transaction_id, amount_minor) VALUES ($1, $2, $3, $4)`,
          [id, payee.payee_id, txn.transaction_id, amount],
        );
      }
      await writeAudit(client, {
        actorId: userId,
        entityType: "payroll_run",
        entityId: id,
        action: "create",
        after: { source_account_id: body.source_account_id, total_minor: total, payments: payments.length },
      });
      return id;
    });
  } catch (err) {
    // two attempts with the same key raced past the replay check together
    if (!isDuplicateRunKey(err)) throw err;
    const raced = await replayRun(userId, runKey, body);
    if (!raced) throw err;
    res.set("Idempotent-Replayed", "true");
    return res.status(201).json(raced);
  }

  return res.status(201).json(await loadRun(pool, userId, runId));
}

// GET /v1/payroll/runs  (newest first, the latest 50)
export async function listRuns(req, res) {
  return res.status(200).json({ data: await loadRuns(pool, req.user.sub) });
}

// GET /v1/payroll/runs/:runId
export async function getRun(req, res) {
  if (!isUuid(req.params.runId)) throw runNotFound();
  const run = await loadRun(pool, req.user.sub, req.params.runId);
  if (!run) throw runNotFound();
  return res.status(200).json(run);
}
