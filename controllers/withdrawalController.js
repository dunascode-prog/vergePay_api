import crypto from "crypto";
import z from "zod";
import { pool } from "../db/connectDB.js";
import { withTransaction } from "../db/withTransaction.js";
import env from "../env.js";
import * as flutterwave from "../services/flutterwave.js";
import { postTransaction } from "../services/ledger.js";
import { formatMoney } from "../services/notifications.js";
import {
  loadWithdrawal,
  publicWithdrawal,
  quoteFee,
  submitWithdrawal,
  syncWithdrawal,
  systemAccountId,
} from "../services/payouts.js";
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

// Withdrawals to Nigerian bank accounts (services/payouts.js moves the money).
//
//   GET  /v1/banks                          banks to pick from
//   GET  /v1/bank-accounts/resolve          name enquiry, before saving
//   POST /v1/bank-accounts                  save one (name checked again here)
//   GET  /v1/withdrawals/quote              the fee and what's left of today's limit
//   POST /v1/withdrawals                    withdraw; the wallet is debited at once
//
// NGN wallets only, by a KYC-verified customer, to any bank account (the
// holder's name is shown, not required to match), up to the daily limit.

const MAX_BANK_ACCOUNTS = 10;
const CURRENCY = "NGN";
const BANK_LIST_TTL_MS = 24 * 60 * 60 * 1000;

const accountNumber = z.string().trim().regex(/^\d{10}$/, "Enter the 10-digit account number.");
const bankCode = z.string().trim().min(2).max(20);
const amountMinor = z.number().int().positive().max(1_000_000_000_000);

const resolveSchema = z.strictObject({ bank_code: bankCode, account_number: accountNumber });
const quoteSchema = z.strictObject({ amount_minor: z.coerce.number().int().positive().max(1_000_000_000_000) });
const withdrawalSchema = z.strictObject({
  account_id: z.uuid(),
  bank_account_id: z.uuid(),
  amount_minor: amountMinor,
  narration: z.string().trim().min(1).max(100).optional(),
});

function parse(schema, body) {
  if (!body || Object.keys(body).length === 0) throw new BadRequestError({ message: "Request body is empty." });
  const validation = schema.safeParse(body);
  if (!validation.success) throw new ValidationError({ details: validationDetails(validation.error) });
  return validation.data;
}

function parseQuery(schema, query) {
  const validation = schema.safeParse(query);
  if (!validation.success) throw new ValidationError({ details: validationDetails(validation.error) });
  return validation.data;
}

async function requireVerifiedKyc(db, userId) {
  const result = await db.query(`SELECT kyc_status FROM users WHERE user_id = $1`, [userId]);
  if (result.rows[0]?.kyc_status !== "verified") throw new KycRequiredError();
}

// ---------------------------------------------------------------------------
// Banks and name enquiry

let bankCache = null;

async function banks() {
  if (bankCache && bankCache.at > Date.now() - BANK_LIST_TTL_MS) return bankCache.list;
  const list = (await flutterwave.listBanks("NG"))
    .map((b) => ({ code: String(b.code), name: b.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  bankCache = { at: Date.now(), list };
  return list;
}

async function bankByCode(code) {
  const bank = (await banks()).find((b) => b.code === code);
  if (!bank) throw new ValidationError({ details: { bank_code: ["Pick a bank from the list."] } });
  return bank;
}

// The holder's name, from Flutterwave's name enquiry.
async function holderName(bank, number) {
  try {
    const found = await flutterwave.resolveAccount({ accountNumber: number, bankCode: bank.code });
    if (!found?.account_name) throw new Error("no name");
    return found.account_name;
  } catch (err) {
    if (err instanceof flutterwave.ProcessorError || err.message === "no name") {
      throw new ValidationError({ details: { account_number: [`No ${bank.name} account has this number.`] } });
    }
    throw err;
  }
}

// GET /v1/banks
export async function listBanks(req, res) {
  return res.status(200).json({ data: await banks() });
}

// GET /v1/bank-accounts/resolve?bank_code=&account_number=  (KYC, rate limited)
export async function resolveBankAccount(req, res) {
  const query = parseQuery(resolveSchema, req.query);
  await requireVerifiedKyc(pool, req.user.sub);
  const bank = await bankByCode(query.bank_code);
  const name = await holderName(bank, query.account_number);
  return res.status(200).json({
    bank_code: bank.code,
    bank_name: bank.name,
    account_number: query.account_number,
    account_name: name,
  });
}

// ---------------------------------------------------------------------------
// Saved bank accounts

const BANK_ACCOUNT_COLUMNS = `bank_account_id, bank_code, bank_name, account_number, account_name, currency_code, created_at`;

// POST /v1/bank-accounts  { bank_code, account_number }
export async function saveBankAccount(req, res) {
  const body = parse(resolveSchema, req.body);
  const userId = req.user.sub;
  await requireVerifiedKyc(pool, userId);
  const bank = await bankByCode(body.bank_code);
  const name = await holderName(bank, body.account_number);

  const saved = await withTransaction(async (client) => {
    await client.query(`SELECT 1 FROM users WHERE user_id = $1 FOR UPDATE`, [userId]);
    const count = await client.query(
      `SELECT count(*)::int AS n FROM bank_accounts WHERE user_id = $1 AND removed_at IS NULL`,
      [userId],
    );
    if (count.rows[0].n >= MAX_BANK_ACCOUNTS) {
      throw new ConflictError({ message: `You can save up to ${MAX_BANK_ACCOUNTS} bank accounts. Remove one first.` });
    }
    const duplicate = await client.query(
      `SELECT 1 FROM bank_accounts WHERE user_id = $1 AND bank_code = $2 AND account_number = $3 AND removed_at IS NULL`,
      [userId, bank.code, body.account_number],
    );
    if (duplicate.rowCount) {
      throw new ConflictError({ message: "You've already saved this bank account.", field: "account_number" });
    }
    const inserted = await client.query(
      `INSERT INTO bank_accounts (user_id, bank_code, bank_name, account_number, account_name, currency_code)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${BANK_ACCOUNT_COLUMNS}`,
      [userId, bank.code, bank.name, body.account_number, name, CURRENCY],
    );
    const row = inserted.rows[0];
    await writeAudit(client, { actorId: userId, entityType: "bank_account", entityId: row.bank_account_id, action: "create", after: row });
    return row;
  });
  return res.status(201).json(saved);
}

// GET /v1/bank-accounts
export async function listBankAccounts(req, res) {
  const result = await pool.query(
    `SELECT ${BANK_ACCOUNT_COLUMNS} FROM bank_accounts WHERE user_id = $1 AND removed_at IS NULL ORDER BY created_at`,
    [req.user.sub],
  );
  return res.status(200).json({ data: result.rows });
}

// DELETE /v1/bank-accounts/:bankAccountId  (past withdrawals keep showing it)
export async function removeBankAccount(req, res) {
  const { bankAccountId } = req.params;
  if (!isUuid(bankAccountId)) throw new NotFoundError({ message: "Bank account not found." });
  const result = await pool.query(
    `UPDATE bank_accounts SET removed_at = NOW()
     WHERE bank_account_id = $1 AND user_id = $2 AND removed_at IS NULL
     RETURNING bank_account_id`,
    [bankAccountId, req.user.sub],
  );
  if (result.rowCount === 0) throw new NotFoundError({ message: "Bank account not found." });
  return res.status(200).json({ bank_account_id: bankAccountId, removed: true });
}

// ---------------------------------------------------------------------------
// Withdrawals

// What the customer has withdrawn today (their timezone), failed ones aside.
async function withdrawnToday(db, userId) {
  const result = await db.query(
    `SELECT COALESCE(sum(w.amount_minor), 0)::bigint AS total
     FROM withdrawals w JOIN users u ON u.user_id = w.user_id
     WHERE w.user_id = $1 AND w.status <> 'failed'
       AND (w.created_at AT TIME ZONE u.timezone)::date = (NOW() AT TIME ZONE u.timezone)::date`,
    [userId],
  );
  return result.rows[0].total;
}

// GET /v1/withdrawals/quote?amount_minor=
// The fee split and today's limit, to show before confirming.
export async function quoteWithdrawal(req, res) {
  const { amount_minor: amount } = parseQuery(quoteSchema, req.query);
  const fee = await quoteFee(amount, CURRENCY);
  const used = await withdrawnToday(pool, req.user.sub);
  return res.status(200).json({
    currency_code: CURRENCY,
    amount_minor: amount,
    fee_minor: fee.customer_fee_minor,
    vergepay_covers_minor: fee.vergepay_fee_minor,
    total_debit_minor: amount + fee.customer_fee_minor,
    min_amount_minor: env.withdrawals.minMinor,
    daily_limit_minor: env.withdrawals.dailyLimitMinor,
    daily_remaining_minor: Math.max(0, env.withdrawals.dailyLimitMinor - used),
  });
}

const isDuplicateKey = (err) => err.code === "23505" && err.constraint === "withdrawals_idempotency_key_key";

async function replayWithdrawal(userId, key, body) {
  const found = await pool.query(`SELECT withdrawal_id FROM withdrawals WHERE idempotency_key = $1`, [key]);
  if (found.rowCount === 0) return null;
  const w = await loadWithdrawal(pool, found.rows[0].withdrawal_id);
  if (w.account_id !== body.account_id || w.bank_account_id !== body.bank_account_id || w.amount_minor !== body.amount_minor) {
    throw new IdempotencyConflictError();
  }
  return w;
}

// POST /v1/withdrawals  { account_id, bank_account_id, amount_minor, narration? }
export async function createWithdrawal(req, res) {
  const body = parse(withdrawalSchema, req.body);
  const userId = req.user.sub;
  const key = `${userId}:${req.idempotencyKey}`;

  const earlier = await replayWithdrawal(userId, key, body);
  if (earlier) {
    res.set("Idempotent-Replayed", "true");
    return res.status(201).json(publicWithdrawal(earlier));
  }

  if (body.amount_minor < env.withdrawals.minMinor) {
    throw new ValidationError({ details: { amount_minor: [`The smallest withdrawal is ${formatMoney(env.withdrawals.minMinor, CURRENCY)}.`] } });
  }
  // Flutterwave's fee, asked before any money moves (no DB lock held while waiting)
  const fee = await quoteFee(body.amount_minor, CURRENCY);

  let withdrawalId;
  try {
    withdrawalId = await withTransaction(async (client) => {
      await requireVerifiedKyc(client, userId);
      // one withdrawal at a time per customer, so two can't both fit under the limit
      await client.query(`SELECT 1 FROM users WHERE user_id = $1 FOR UPDATE`, [userId]);

      const wallet = await client.query(
        `SELECT account_id, currency_code, account_status, balance_minor FROM account
         WHERE account_id = $1 AND user_id = $2 AND NOT is_system AND account_type = 'current'
         FOR UPDATE`,
        [body.account_id, userId],
      );
      const from = wallet.rows[0];
      if (!from) throw new ValidationError({ details: { account_id: ["Not one of your wallets."] } });
      if (from.currency_code !== CURRENCY) {
        throw new ValidationError({ details: { account_id: ["Only NGN wallets can withdraw to a bank account for now."] } });
      }
      if (from.account_status !== "active") {
        throw new ConflictError({ message: `This wallet is ${from.account_status} and can't send money.` });
      }

      const bank = await client.query(
        `SELECT bank_account_id, bank_name, account_number FROM bank_accounts
         WHERE bank_account_id = $1 AND user_id = $2 AND removed_at IS NULL`,
        [body.bank_account_id, userId],
      );
      const to = bank.rows[0];
      if (!to) throw new ValidationError({ details: { bank_account_id: ["Not one of your saved bank accounts."] } });

      const used = await withdrawnToday(client, userId);
      if (used + body.amount_minor > env.withdrawals.dailyLimitMinor) {
        const left = Math.max(0, env.withdrawals.dailyLimitMinor - used);
        throw new ValidationError({
          message: "Over today's withdrawal limit.",
          details: {
            amount_minor: [
              `You can withdraw ${formatMoney(env.withdrawals.dailyLimitMinor, CURRENCY)} a day; ${formatMoney(left, CURRENCY)} is left today.`,
            ],
          },
        });
      }
      const total = body.amount_minor + fee.customer_fee_minor;
      if (from.balance_minor < total) {
        throw new InsufficientFundsError({
          message: `This withdrawal needs ${formatMoney(total, CURRENCY)} (with the ${formatMoney(fee.customer_fee_minor, CURRENCY)} fee), but the wallet holds ${formatMoney(from.balance_minor, CURRENCY)}.`,
        });
      }

      const id = crypto.randomUUID();
      const reference = `VP-WD-${id.replace(/-/g, "")}`;
      const destination = `${to.bank_name} · ${to.account_number}`;
      const withdrawal = await postTransaction(client, {
        transactionType: "withdrawal",
        senderAccountId: from.account_id,
        receiverAccountId: await systemAccountId(client, "SYS-PAYOUT", CURRENCY),
        amountMinor: body.amount_minor,
        currencyCode: CURRENCY,
        description: `To ${destination}`,
        idempotencyKey: `withdrawal:${id}`,
      });
      const feeTxn =
        fee.customer_fee_minor > 0
          ? await postTransaction(client, {
              transactionType: "fee",
              senderAccountId: from.account_id,
              receiverAccountId: await systemAccountId(client, "SYS-FEES", CURRENCY),
              amountMinor: fee.customer_fee_minor,
              currencyCode: CURRENCY,
              description: `Withdrawal fee (to ${destination})`,
              idempotencyKey: `withdrawal-fee:${id}`,
            })
          : null;

      await client.query(
        `INSERT INTO withdrawals
            (withdrawal_id, user_id, account_id, bank_account_id, currency_code, amount_minor,
             processor_fee_minor, customer_fee_minor, narration, reference, idempotency_key,
             transaction_id, fee_transaction_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          id, userId, from.account_id, to.bank_account_id, CURRENCY, body.amount_minor,
          fee.processor_fee_minor, fee.customer_fee_minor, body.narration ?? null, reference, key,
          withdrawal.transaction_id, feeTxn?.transaction_id ?? null,
        ],
      );
      await writeAudit(client, {
        actorId: userId,
        entityType: "withdrawal",
        entityId: id,
        action: "create",
        after: { account_id: from.account_id, bank_account_id: to.bank_account_id, amount_minor: body.amount_minor, fee },
      });
      return id;
    });
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    const raced = await replayWithdrawal(userId, key, body);
    if (!raced) throw err;
    res.set("Idempotent-Replayed", "true");
    return res.status(201).json(publicWithdrawal(raced));
  }

  // The money is held; now ask Flutterwave to send it. Whatever happens here
  // is recorded on the withdrawal (sent, refused and refunded, or retried later).
  await submitWithdrawal(withdrawalId);
  return res.status(201).json(publicWithdrawal(await loadWithdrawal(pool, withdrawalId)));
}

async function findOwnWithdrawal(userId, withdrawalId) {
  if (!isUuid(withdrawalId)) throw new NotFoundError({ message: "Withdrawal not found." });
  const w = await loadWithdrawal(pool, withdrawalId);
  if (!w || w.user_id !== userId) throw new NotFoundError({ message: "Withdrawal not found." });
  return w;
}

// GET /v1/withdrawals  (newest first, the latest 50)
export async function listWithdrawals(req, res) {
  const ids = await pool.query(
    `SELECT withdrawal_id FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [req.user.sub],
  );
  const data = [];
  for (const { withdrawal_id: id } of ids.rows) data.push(publicWithdrawal(await loadWithdrawal(pool, id)));
  return res.status(200).json({ data });
}

// GET /v1/withdrawals/:withdrawalId
export async function getWithdrawal(req, res) {
  return res.status(200).json(publicWithdrawal(await findOwnWithdrawal(req.user.sub, req.params.withdrawalId)));
}

// POST /v1/withdrawals/:withdrawalId/sync  (asks Flutterwave how it went)
export async function syncOwnWithdrawal(req, res) {
  const w = await findOwnWithdrawal(req.user.sub, req.params.withdrawalId);
  await syncWithdrawal(w.withdrawal_id);
  return res.status(200).json(publicWithdrawal(await loadWithdrawal(pool, w.withdrawal_id)));
}
