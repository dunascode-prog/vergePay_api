import z from "zod";
import { pool } from "../db/connectDB.js";
import * as flutterwave from "../services/flutterwave.js";
import { writeAudit } from "../utils/audit.js";
import {
  BadRequestError,
  ConflictError,
  KycRequiredError,
  NotFoundError,
  ValidationError,
} from "../utils/errorStr.js";
import { isUuid, validationDetails } from "../utils/validation.js";

// Bank-transfer funding: each NGN VergePay account can get one permanent
// bank account number from Flutterwave's partner bank. Money transferred
// into it from any Nigerian bank arrives as a charge.completed webhook and
// is credited as a bank_deposit (services/processorPayments.js).
//
// Flutterwave requires the holder's BVN for a permanent number. It is passed
// straight through and never stored or logged.

const createSchema = z.strictObject({
  bvn: z.string().trim().regex(/^\d{11}$/, "A BVN is 11 digits."),
});

const VIRTUAL_ACCOUNT_COLUMNS = `
    virtual_account_id, account_id, account_number, bank_name, created_at`;

async function findOwnAccount(userId, accountId) {
  if (!isUuid(accountId)) throw new NotFoundError({ message: "Account not found." });
  const result = await pool.query(
    `SELECT a.account_id, a.account_type, a.account_status, a.currency_code,
            u.email, u.first_name, u.last_name, u.kyc_status
     FROM account a JOIN users u ON u.user_id = a.user_id
     WHERE a.account_id = $1 AND a.user_id = $2 AND NOT a.is_system`,
    [accountId, userId],
  );
  if (result.rowCount === 0) throw new NotFoundError({ message: "Account not found." });
  return result.rows[0];
}

// GET /v1/accounts/:accountId/virtual-account
export async function getVirtualAccount(req, res) {
  const account = await findOwnAccount(req.user.sub, req.params.accountId);
  const result = await pool.query(
    `SELECT ${VIRTUAL_ACCOUNT_COLUMNS} FROM virtual_accounts WHERE account_id = $1`,
    [account.account_id],
  );
  if (result.rowCount === 0) {
    throw new NotFoundError({ message: "This account has no bank-transfer account number yet." });
  }
  return res.status(200).json(result.rows[0]);
}

// POST /v1/accounts/:accountId/virtual-account  { bvn }
// Returns 201 with the new number, or 200 with the existing one.
export async function createVirtualAccount(req, res) {
  if (!req.body || Object.keys(req.body).length === 0) {
    throw new BadRequestError({ message: "Request body is empty." });
  }
  const validation = createSchema.safeParse(req.body);
  if (!validation.success) {
    throw new ValidationError({ details: validationDetails(validation.error) });
  }
  const account = await findOwnAccount(req.user.sub, req.params.accountId);

  const existing = await pool.query(
    `SELECT ${VIRTUAL_ACCOUNT_COLUMNS} FROM virtual_accounts WHERE account_id = $1`,
    [account.account_id],
  );
  if (existing.rows[0]) return res.status(200).json(existing.rows[0]);

  if (account.kyc_status !== "verified") throw new KycRequiredError();
  if (!["current", "savings"].includes(account.account_type)) {
    throw new ValidationError({ details: { account_id: ["Only current and savings accounts can receive bank transfers."] } });
  }
  if (account.account_status !== "active") {
    throw new ConflictError({ message: `The account is ${account.account_status}.` });
  }
  if (account.currency_code !== "NGN") {
    throw new ValidationError({ details: { account_id: ["Bank-transfer account numbers are for NGN accounts."] } });
  }
  if (!account.first_name || !account.last_name) {
    throw new ValidationError({
      details: { first_name: ["Add your first and last name to your profile first (PATCH /v1/users/me)."] },
    });
  }

  // One reference per VergePay account, so deposits map straight back to it.
  const txRef = `va-${account.account_id}`;
  const created = await flutterwave.createStaticVirtualAccount({
    email: account.email,
    bvn: validation.data.bvn,
    txRef,
    firstName: account.first_name,
    lastName: account.last_name,
    narration: `${account.first_name} ${account.last_name}`,
  });

  let saved;
  try {
    saved = await pool.query(
      `INSERT INTO virtual_accounts (account_id, account_number, bank_name, processor_tx_ref, processor_order_ref)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${VIRTUAL_ACCOUNT_COLUMNS}`,
      [account.account_id, created.account_number, created.bank_name, txRef, created.order_ref ?? null],
    );
  } catch (err) {
    // Two requests raced; the other one saved it first.
    if (err.code !== "23505") throw err;
    const winner = await pool.query(
      `SELECT ${VIRTUAL_ACCOUNT_COLUMNS} FROM virtual_accounts WHERE account_id = $1`,
      [account.account_id],
    );
    return res.status(200).json(winner.rows[0]);
  }

  await writeAudit(pool, {
    actorId: req.user.sub,
    entityType: "virtual_account",
    entityId: saved.rows[0].virtual_account_id,
    action: "create",
    after: { account_id: account.account_id, account_number: created.account_number, bank_name: created.bank_name },
  });
  return res.status(201).json(saved.rows[0]);
}
