import z from "zod";
import { pool } from "../db/connectDB.js";
import { withTransaction } from "../db/withTransaction.js";
import { generateAccountNumber } from "../utils/accountNumber.js";
import { writeAudit } from "../utils/audit.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../utils/errorStr.js";
import { isUuid, validationDetails } from "../utils/validation.js";

const ACCOUNT_COLUMNS = `
    account_id,
    account_type,
    account_number,
    currency_code,
    balance_minor,
    income_minor,
    total_savings_minor,
    account_status,
    created_at,
    updated_at`;

// loan_holding accounts are opened by the loan system, never by a user.
const USER_OPENABLE_TYPES = ["current", "savings", "investment_wallet"];

const openAccountSchema = z.strictObject({
  account_type: z.enum(USER_OPENABLE_TYPES),
  currency_code: z.string().trim().toUpperCase().length(3),
});

const minorAmount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

// balance_minor is deliberately not editable: it only changes when a
// transaction is posted (API doc 4.4).
const updateAccountSchema = z
  .strictObject({
    income_minor: minorAmount.nullable(),
    total_savings_minor: minorAmount.nullable(),
  })
  .partial();

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

// An account the caller doesn't own is reported as not found, never as
// forbidden, so account ids can't be probed (API doc 4.2).
function notFound() {
  return new NotFoundError({ message: "Account not found." });
}

// Loads one of the caller's accounts, optionally locking the row so a
// concurrent status change or transfer has to wait for this one.
async function findOwnAccount(db, userId, accountId, { lock = false } = {}) {
  if (!isUuid(accountId)) throw notFound();
  const result = await db.query(
    `SELECT ${ACCOUNT_COLUMNS} FROM account
     WHERE account_id = $1 AND user_id = $2
     ${lock ? "FOR UPDATE" : ""}`,
    [accountId, userId],
  );
  if (result.rowCount === 0) throw notFound();
  return result.rows[0];
}

export async function listAccounts(req, res) {
  const result = await pool.query(
    `SELECT ${ACCOUNT_COLUMNS} FROM account
     WHERE user_id = $1
     ORDER BY created_at`,
    [req.user.sub],
  );
  return res.status(200).json({ data: result.rows });
}

export async function getAccount(req, res) {
  const account = await findOwnAccount(pool, req.user.sub, req.params.accountId);
  return res.status(200).json(account);
}

export async function openAccount(req, res) {
  const { account_type, currency_code } = parseBody(openAccountSchema, req.body);

  const currency = await pool.query(`SELECT 1 FROM currencies WHERE code = $1`, [
    currency_code,
  ]);
  if (currency.rowCount === 0) {
    throw new ValidationError({
      details: { currency_code: ["This currency is not supported."] },
    });
  }

  // Account numbers are random, so a collision is possible but rare; retry
  // with a fresh number a few times before giving up.
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const account = await withTransaction(async (client) => {
        const result = await client.query(
          `INSERT INTO account (user_id, account_type, account_number, currency_code)
           VALUES ($1, $2, $3, $4)
           RETURNING ${ACCOUNT_COLUMNS}`,
          [req.user.sub, account_type, generateAccountNumber(), currency_code],
        );
        const created = result.rows[0];
        await writeAudit(client, {
          actorId: req.user.sub,
          entityType: "account",
          entityId: created.account_id,
          action: "create",
          after: created,
        });
        return created;
      });
      return res.status(201).json(account);
    } catch (err) {
      const numberTaken =
        err.code === "23505" && err.constraint === "account_account_number_key";
      if (!numberTaken || attempt === 5) throw err;
    }
  }
}

export async function updateAccount(req, res) {
  const updates = parseBody(updateAccountSchema, req.body);
  const fields = Object.keys(updates);

  const account = await withTransaction(async (client) => {
    const before = await findOwnAccount(client, req.user.sub, req.params.accountId, {
      lock: true,
    });
    if (before.account_status === "closed") {
      throw new ConflictError({ message: "A closed account can't be changed." });
    }

    // Column names come only from the schema's whitelist.
    const setClause = fields
      .map((field, index) => `${field} = $${index + 2}`)
      .join(", ");
    const result = await client.query(
      `UPDATE account SET ${setClause}, updated_at = NOW()
       WHERE account_id = $1
       RETURNING ${ACCOUNT_COLUMNS}`,
      [before.account_id, ...fields.map((field) => updates[field])],
    );
    const after = result.rows[0];
    await writeAudit(client, {
      actorId: req.user.sub,
      entityType: "account",
      entityId: after.account_id,
      action: "update",
      before,
      after,
    });
    return after;
  });

  return res.status(200).json(account);
}

// Legal status transitions. Anything not listed is rejected with 409, so a
// closed account can never be reopened (API doc 4.5).
const TRANSITIONS = {
  freeze: { from: ["active"], to: "frozen" },
  unfreeze: { from: ["frozen"], to: "active" },
  close: { from: ["active", "frozen"], to: "closed" },
};

function changeStatus(action) {
  const { from, to } = TRANSITIONS[action];

  return async function (req, res) {
    const account = await withTransaction(async (client) => {
      const before = await findOwnAccount(
        client,
        req.user.sub,
        req.params.accountId,
        { lock: true },
      );

      if (!from.includes(before.account_status)) {
        throw new ConflictError({
          message: `Can't ${action} an account that is ${before.account_status}.`,
        });
      }
      if (action === "close" && before.balance_minor !== 0) {
        throw new ConflictError({
          message:
            "Can't close an account with a non-zero balance. Move the funds out first.",
        });
      }
      // The account a loan is paid into stays open for the life of the loan.
      if (action === "close") {
        const loans = await client.query(
          `SELECT 1 FROM loans
           WHERE account_id = $1 AND loan_status IN ('approved', 'active')
           LIMIT 1`,
          [before.account_id],
        );
        if (loans.rowCount > 0) {
          throw new ConflictError({
            message: "Can't close an account that has a loan in progress.",
          });
        }
        // Open invoices are paid into the issuing account, so it has to stay
        // open until they're paid or cancelled.
        const invoices = await client.query(
          `SELECT 1 FROM invoices
           WHERE issuer_account_id = $1 AND invoice_status = 'open'
           LIMIT 1`,
          [before.account_id],
        );
        if (invoices.rowCount > 0) {
          throw new ConflictError({
            message: "Can't close an account with open invoices. Cancel them first.",
          });
        }
      }

      const result = await client.query(
        `UPDATE account SET account_status = $2, updated_at = NOW()
         WHERE account_id = $1
         RETURNING ${ACCOUNT_COLUMNS}`,
        [before.account_id, to],
      );
      const after = result.rows[0];
      await writeAudit(client, {
        actorId: req.user.sub,
        entityType: "account",
        entityId: after.account_id,
        action: "status_change",
        before: { account_status: before.account_status },
        after: { account_status: after.account_status },
      });
      return after;
    });

    return res.status(200).json(account);
  };
}

export const freezeAccount = changeStatus("freeze");
export const unfreezeAccount = changeStatus("unfreeze");
export const closeAccount = changeStatus("close");
