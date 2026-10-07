import z from "zod";
import { pool } from "../db/connectDB.js";
import { withTransaction } from "../db/withTransaction.js";
import { writeAudit } from "../utils/audit.js";
import {
  BadRequestError,
  ConflictError,
  KycRequiredError,
  NotFoundError,
  ValidationError,
} from "../utils/errorStr.js";
import { isUuid, validationDetails } from "../utils/validation.js";
import { isGoalAccount } from "../services/goals.js";
import {
  ACCOUNT_COLUMNS,
  findOpenAccount,
  insertAccount,
  lockUserForAccountOpening,
} from "../services/accountOpening.js";

// A customer has at most two wallets: one personal and one business, both
// current accounts. The other account types are opened for them by the
// system: loan_holding by the loan system, investment_wallet when they link
// a brokerage (brokerageController).
const USER_OPENABLE_TYPES = ["current"];
const WALLET_CURRENCIES = ["NGN", "USD"];

// What a wallet is for, so personal and business money show apart. It
// doesn't change how money moves, and it's fixed once the wallet is opened.
const PURPOSES = ["personal", "business"];

const openAccountSchema = z.strictObject({
  account_type: z.enum(USER_OPENABLE_TYPES, {
    error:
      "Only wallets (current accounts) can be opened: one personal and one business. Investment wallets are opened for you when you link a brokerage.",
  }),
  currency_code: z
    .string()
    .trim()
    .toUpperCase()
    .refine((code) => WALLET_CURRENCIES.includes(code), "Wallets can be in NGN or USD."),
  purpose: z.enum(PURPOSES).default("personal"),
});

const listAccountsSchema = z.strictObject({
  purpose: z.enum(PURPOSES).optional(),
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
  const validation = listAccountsSchema.safeParse(req.query);
  if (!validation.success) {
    throw new ValidationError({ details: validationDetails(validation.error) });
  }
  const result = await pool.query(
    `SELECT ${ACCOUNT_COLUMNS} FROM account
     WHERE user_id = $1
       AND ($2::account_purpose_enum IS NULL OR purpose = $2::account_purpose_enum)
     ORDER BY created_at`,
    [req.user.sub, validation.data.purpose ?? null],
  );
  return res.status(200).json({ data: result.rows });
}

const lookupSchema = z.strictObject({
  account_number: z.string().trim().regex(/^\d{10}$/, "Enter a 10-digit account number."),
});

// GET /v1/accounts/lookup?account_number=   (User, KYC-verified, rate limited)
// "Name enquiry": who holds a wallet, so a sender can check before paying.
// Only open wallets are found, never system or loan accounts, and only
// verified customers can ask, which with the rate limit keeps it from being
// a way to collect names.
export async function lookupAccountName(req, res) {
  const validation = lookupSchema.safeParse(req.query);
  if (!validation.success) {
    throw new ValidationError({ details: validationDetails(validation.error) });
  }
  const me = await pool.query(`SELECT kyc_status FROM users WHERE user_id = $1`, [req.user.sub]);
  if (me.rows[0]?.kyc_status !== "verified") throw new KycRequiredError();

  const result = await pool.query(
    `SELECT a.account_number, a.currency_code, a.user_id,
            COALESCE(NULLIF(concat_ws(' ', u.first_name, u.last_name), ''), u.username) AS account_name
     FROM account a
     JOIN users u ON u.user_id = a.user_id
     WHERE a.account_number = $1
       AND NOT a.is_system
       AND a.account_type = 'current'
       AND a.account_status <> 'closed'`,
    [validation.data.account_number],
  );
  const found = result.rows[0];
  if (!found) throw new NotFoundError({ message: "No VergePay wallet has that account number." });
  return res.status(200).json({
    account_number: found.account_number,
    account_name: found.account_name,
    currency_code: found.currency_code,
    is_own: found.user_id === req.user.sub,
  });
}

export async function getAccount(req, res) {
  const account = await findOwnAccount(pool, req.user.sub, req.params.accountId);
  return res.status(200).json(account);
}

export async function openAccount(req, res) {
  const { account_type, currency_code, purpose } = parseBody(openAccountSchema, req.body);

  const currency = await pool.query(`SELECT 1 FROM currencies WHERE code = $1`, [
    currency_code,
  ]);
  if (currency.rowCount === 0) {
    throw new ValidationError({
      details: { currency_code: ["This currency is not supported."] },
    });
  }

  const account = await withTransaction(async (client) => {
    // One personal and one business wallet per customer. The lock makes the
    // check and the insert atomic, so two quick taps can't open two.
    await lockUserForAccountOpening(client, req.user.sub);
    const existing = await findOpenAccount(client, req.user.sub, account_type, purpose);
    if (existing) {
      throw new ConflictError({
        message: `You already have a ${purpose} wallet (${existing.account_number}).`,
        field: "purpose",
      });
    }
    return insertAccount(client, {
      userId: req.user.sub,
      accountType: account_type,
      currencyCode: currency_code,
      purpose,
    });
  });
  return res.status(201).json(account);
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
      // A goal's account opens and closes with its goal.
      if (await isGoalAccount(client, before.account_id)) {
        throw new ConflictError({
          message: "This account holds a savings goal. Close the goal instead (POST /v1/goals/{goal_id}/close).",
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
        // A card payment still waiting on the processor must land somewhere,
        // and a linked card would keep funding a closed account.
        const cardUse = await client.query(
          `SELECT
             EXISTS (SELECT 1 FROM transactions
                     WHERE receiver_account_id = $1 AND status = 'pending') AS pending_payment,
             EXISTS (SELECT 1 FROM cards
                     WHERE account_id = $1 AND card_status <> 'removed') AS has_cards`,
          [before.account_id],
        );
        if (cardUse.rows[0].pending_payment) {
          throw new ConflictError({
            message: "Can't close an account while a card payment into it is still pending.",
          });
        }
        // a withdrawal on its way can still fail, and its refund lands here
        const payout = await client.query(
          `SELECT 1 FROM withdrawals WHERE account_id = $1 AND status = 'pending' LIMIT 1`,
          [before.account_id],
        );
        if (payout.rowCount > 0) {
          throw new ConflictError({
            message: "Can't close an account while a withdrawal from it is still on its way.",
          });
        }
        if (cardUse.rows[0].has_cards) {
          throw new ConflictError({
            message: "Can't close an account with linked cards. Remove them first.",
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
