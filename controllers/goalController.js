import z from "zod";
import { pool } from "../db/connectDB.js";
import { withTransaction } from "../db/withTransaction.js";
import { insertAccount, lockUserForAccountOpening } from "../services/accountOpening.js";
import { goalActivity, loadGoal, loadGoals } from "../services/goals.js";
import { postOnce, postTransaction, publicTransaction } from "../services/ledger.js";
import { writeAudit } from "../utils/audit.js";
import {
  BadRequestError,
  ConflictError,
  KycRequiredError,
  NotFoundError,
  ValidationError,
} from "../utils/errorStr.js";
import { isUuid, validationDetails } from "../utils/validation.js";

// Savings goals (db/migrations.db/goals.sql). Each goal holds real money in
// its own savings account:
//
//   contribute   wallet -> goal     (goal_contribution)
//   withdraw     goal -> wallet     (goal_withdrawal)
//   close        moves whatever is left back to a wallet, then closes the
//                goal and its account; final
//
// Money only moves between the goal and the customer's own wallets, in the
// goal's currency. A goal can go past its target: it's a savings pot, not a
// cap.

const MAX_ACTIVE_GOALS = 20;
const GOAL_CURRENCIES = ["NGN", "USD"];

const isoDate = z.iso.date("Use the format YYYY-MM-DD.");
const amountMinor = z.number().int().positive().max(1_000_000_000_000);
const name = z.string().trim().min(1, "Give the goal a name.").max(80);
const category = z.enum(["emergency_fund", "equipment", "investment", "other"]);

const createSchema = z.strictObject({
  name,
  category: category.default("other"),
  target_minor: amountMinor,
  currency_code: z
    .string()
    .trim()
    .toUpperCase()
    .refine((code) => GOAL_CURRENCIES.includes(code), "Goals can be in NGN or USD."),
  target_date: isoDate,
});

const updateSchema = z
  .strictObject({
    name: name.optional(),
    category: category.optional(),
    target_minor: amountMinor.optional(),
    target_date: isoDate.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to change." });

const contributionSchema = z.strictObject({
  from_account_id: z.uuid(),
  amount_minor: amountMinor,
});

const withdrawalSchema = z.strictObject({
  to_account_id: z.uuid(),
  amount_minor: amountMinor,
});

const closeSchema = z.strictObject({
  to_account_id: z.uuid().optional(),
});

const listQuerySchema = z.strictObject({
  status: z.enum(["active", "closed", "all"]).default("active"),
});

function parse(schema, body, { allowEmpty = false } = {}) {
  if (!allowEmpty && (!body || Object.keys(body).length === 0)) {
    throw new BadRequestError({ message: "Request body is empty." });
  }
  const validation = schema.safeParse(body ?? {});
  if (!validation.success) throw new ValidationError({ details: validationDetails(validation.error) });
  return validation.data;
}

const notFound = () => new NotFoundError({ message: "Goal not found." });

async function findOwnGoal(db, userId, goalId) {
  if (!isUuid(goalId)) throw notFound();
  const goal = await loadGoal(db, userId, goalId);
  if (!goal) throw notFound();
  return goal;
}

// Locks the goal row, so two moves on one goal (or a move racing a close)
// run one after the other.
async function lockGoal(client, userId, goalId) {
  const result = await client.query(
    `SELECT goal_id, account_id, name, currency_code, goal_status
     FROM goals WHERE goal_id = $1 AND user_id = $2 FOR UPDATE`,
    [goalId, userId],
  );
  if (result.rowCount === 0) throw notFound();
  return result.rows[0];
}

// Today and the furthest allowed target date, in the customer's timezone.
async function dateBounds(db, userId) {
  const result = await db.query(
    `SELECT (NOW() AT TIME ZONE timezone)::date::text AS today,
            ((NOW() AT TIME ZONE timezone)::date + interval '50 years')::date::text AS latest
     FROM users WHERE user_id = $1`,
    [userId],
  );
  return result.rows[0];
}

function checkTargetDate(targetDate, { today, latest }) {
  if (targetDate < today) {
    throw new ValidationError({ details: { target_date: ["The target date can't be in the past."] } });
  }
  if (targetDate > latest) {
    throw new ValidationError({ details: { target_date: ["The target date must be within 50 years."] } });
  }
}

// One of the caller's wallets, in the goal's currency. Goals move money to
// and from wallets only, never another goal or an investment wallet.
async function checkWallet(client, userId, accountId, goal, field) {
  const result = await client.query(
    `SELECT account_id, currency_code FROM account
     WHERE account_id = $1 AND user_id = $2 AND NOT is_system AND account_type = 'current'`,
    [accountId, userId],
  );
  const wallet = result.rows[0];
  if (!wallet) throw new ValidationError({ details: { [field]: ["Not one of your wallets."] } });
  if (wallet.currency_code !== goal.currency_code) {
    throw new ValidationError({
      details: { [field]: [`This goal saves in ${goal.currency_code}; pick a ${goal.currency_code} wallet.`] },
    });
  }
}

// Money only moves for verified users (API doc 2.1). Withdrawing doesn't
// check: money can only be in a goal if it was verified when it went in,
// and getting it back out shouldn't depend on the status since.
async function requireVerifiedKyc(db, userId) {
  const result = await db.query(`SELECT kyc_status FROM users WHERE user_id = $1`, [userId]);
  if (result.rows[0]?.kyc_status !== "verified") throw new KycRequiredError();
}

// POST /v1/goals  { name, category?, target_minor, currency_code, target_date }
// Opens the goal's savings account with it.
export async function createGoal(req, res) {
  const body = parse(createSchema, req.body);
  const userId = req.user.sub;
  checkTargetDate(body.target_date, await dateBounds(pool, userId));

  const goalId = await withTransaction(async (client) => {
    // counted under the user lock, so quick taps can't pass the limit together
    await lockUserForAccountOpening(client, userId);
    const active = await client.query(
      `SELECT count(*)::int AS n FROM goals WHERE user_id = $1 AND goal_status = 'active'`,
      [userId],
    );
    if (active.rows[0].n >= MAX_ACTIVE_GOALS) {
      throw new ConflictError({ message: `You can have up to ${MAX_ACTIVE_GOALS} goals at once. Close one first.` });
    }

    const account = await insertAccount(client, {
      userId,
      accountType: "savings",
      currencyCode: body.currency_code,
      purpose: "personal",
    });
    const inserted = await client.query(
      `INSERT INTO goals (user_id, account_id, name, category, target_minor, currency_code, target_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING goal_id`,
      [userId, account.account_id, body.name, body.category, body.target_minor, body.currency_code, body.target_date],
    );
    const id = inserted.rows[0].goal_id;
    await writeAudit(client, { actorId: userId, entityType: "goal", entityId: id, action: "create", after: body });
    return id;
  });

  return res.status(201).json(await loadGoal(pool, userId, goalId));
}

// GET /v1/goals?status=active|closed|all  (oldest first)
export async function listGoals(req, res) {
  const validation = listQuerySchema.safeParse(req.query);
  if (!validation.success) throw new ValidationError({ details: validationDetails(validation.error) });
  const { status } = validation.data;
  const data = await loadGoals(
    pool,
    req.user.sub,
    "AND ($2::text = 'all' OR g.goal_status::text = $2)",
    [status],
  );
  return res.status(200).json({ data });
}

// GET /v1/goals/:goalId  (with its contributions and withdrawals)
export async function getGoal(req, res) {
  const goal = await findOwnGoal(pool, req.user.sub, req.params.goalId);
  goal.activity = await goalActivity(pool, goal.account_id);
  return res.status(200).json(goal);
}

// PATCH /v1/goals/:goalId  { name?, category?, target_minor?, target_date? }
export async function updateGoal(req, res) {
  const body = parse(updateSchema, req.body);
  const userId = req.user.sub;
  const current = await findOwnGoal(pool, userId, req.params.goalId);
  if (current.goal_status === "closed") throw new ConflictError({ message: "A closed goal can't be changed." });
  if (body.target_date) checkTargetDate(body.target_date, await dateBounds(pool, userId));

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE goals
       SET name = $2, category = $3, target_minor = $4, target_date = $5, updated_at = NOW()
       WHERE goal_id = $1`,
      [
        current.goal_id,
        body.name ?? current.name,
        body.category ?? current.category,
        body.target_minor ?? current.target_minor,
        body.target_date ?? current.target_date,
      ],
    );
    const pick = ({ name, category, target_minor, target_date }) => ({ name, category, target_minor, target_date });
    await writeAudit(client, {
      actorId: userId,
      entityType: "goal",
      entityId: current.goal_id,
      action: "update",
      before: pick(current),
      after: pick({ ...current, ...body }),
    });
  });

  return res.status(200).json(await loadGoal(pool, userId, current.goal_id));
}

// Contribute and withdraw: one ledger transaction between the goal and a
// wallet, idempotent like a transfer (a retry with the same key gets the
// original answer and moves nothing).
function moveMoney(direction) {
  const contributing = direction === "in";
  const schema = contributing ? contributionSchema : withdrawalSchema;
  const field = contributing ? "from_account_id" : "to_account_id";
  const transactionType = contributing ? "goal_contribution" : "goal_withdrawal";

  return async function (req, res) {
    const body = parse(schema, req.body);
    const userId = req.user.sub;
    const goal = await findOwnGoal(pool, userId, req.params.goalId);
    const walletId = body[field];
    const idempotencyKey = `${userId}:${req.idempotencyKey}`;

    const sender = contributing ? walletId : goal.account_id;
    const receiver = contributing ? goal.account_id : walletId;
    const isSameMove = (existing) =>
      existing.transaction_type === transactionType &&
      existing.sender_account_id === sender &&
      existing.receiver_account_id === receiver &&
      existing.amount_minor === body.amount_minor;

    const { transaction, replayed } = await postOnce(idempotencyKey, async (client) => {
      if (contributing) await requireVerifiedKyc(client, userId);
      const locked = await lockGoal(client, userId, goal.goal_id);
      if (locked.goal_status !== "active") {
        throw new ConflictError({ message: "This goal is closed." });
      }
      await checkWallet(client, userId, walletId, locked, field);

      // postTransaction checks both accounts are active and the sender can
      // afford it (a withdrawal can't take more than the goal holds).
      return postTransaction(client, {
        transactionType,
        senderAccountId: sender,
        receiverAccountId: receiver,
        amountMinor: body.amount_minor,
        currencyCode: locked.currency_code,
        description: locked.name,
        idempotencyKey,
      });
    }, isSameMove);

    if (replayed) res.set("Idempotent-Replayed", "true");
    return res.status(201).json({
      goal: await loadGoal(pool, userId, goal.goal_id),
      transaction: publicTransaction(transaction),
    });
  };
}

// POST /v1/goals/:goalId/contributions  { from_account_id, amount_minor }
export const contributeToGoal = moveMoney("in");

// POST /v1/goals/:goalId/withdrawals  { to_account_id, amount_minor }
export const withdrawFromGoal = moveMoney("out");

// Closes the goal and its account, inside the caller's DB transaction.
async function markClosed(client, userId, goal) {
  await client.query(`UPDATE account SET account_status = 'closed', updated_at = NOW() WHERE account_id = $1`, [
    goal.account_id,
  ]);
  await client.query(
    `UPDATE goals SET goal_status = 'closed', closed_at = NOW(), updated_at = NOW() WHERE goal_id = $1`,
    [goal.goal_id],
  );
  await writeAudit(client, {
    actorId: userId,
    entityType: "goal",
    entityId: goal.goal_id,
    action: "status_change",
    before: { goal_status: "active" },
    after: { goal_status: "closed" },
  });
}

// POST /v1/goals/:goalId/close  { to_account_id? }
// Moves whatever the goal holds back to the wallet named (required when
// there is money in it), then closes the goal and its account. Final.
export async function closeGoal(req, res) {
  const body = parse(closeSchema, req.body, { allowEmpty: true });
  const userId = req.user.sub;
  const goal = await findOwnGoal(pool, userId, req.params.goalId);
  const idempotencyKey = `${userId}:${req.idempotencyKey}`;

  // A retry of a close that already moved the money is answered from the
  // ledger, like any other move.
  const isSameClose = (existing) =>
    existing.transaction_type === "goal_withdrawal" &&
    existing.sender_account_id === goal.account_id &&
    existing.receiver_account_id === body.to_account_id;

  const { transaction, replayed } = await postOnce(idempotencyKey, async (client) => {
    const locked = await lockGoal(client, userId, goal.goal_id);
    if (locked.goal_status !== "active") throw new ConflictError({ message: "This goal is already closed." });

    const balance = await client.query(`SELECT balance_minor FROM account WHERE account_id = $1`, [locked.account_id]);
    const left = balance.rows[0].balance_minor;
    if (left === 0) {
      await markClosed(client, userId, locked);
      return null;
    }
    if (!body.to_account_id) {
      throw new ValidationError({
        details: { to_account_id: ["This goal still holds money. Name the wallet to move it to."] },
      });
    }
    await checkWallet(client, userId, body.to_account_id, locked, "to_account_id");
    const posted = await postTransaction(client, {
      transactionType: "goal_withdrawal",
      senderAccountId: locked.account_id,
      receiverAccountId: body.to_account_id,
      amountMinor: left,
      currencyCode: locked.currency_code,
      description: locked.name,
      idempotencyKey,
    });
    await markClosed(client, userId, locked);
    return posted;
  }, isSameClose);

  if (replayed) res.set("Idempotent-Replayed", "true");
  return res.status(200).json({
    goal: await loadGoal(pool, userId, goal.goal_id),
    transaction: transaction ? publicTransaction(transaction) : null,
  });
}
