import express from "express";
import {
  createWithdrawal,
  getWithdrawal,
  listBankAccounts,
  listBanks,
  listWithdrawals,
  quoteWithdrawal,
  removeBankAccount,
  resolveBankAccount,
  saveBankAccount,
  syncOwnWithdrawal,
} from "../controllers/withdrawalController.js";
import { idempotency } from "../utils/idempotency.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { lookupLimiter, moneyLimiter } from "../utils/rateLimiters.js";

// Withdrawals to bank accounts: the bank list, saved bank accounts (with a
// name enquiry), and withdrawals, which move money and take an Idempotency-Key.
export const bankRouter = express.Router();
bankRouter.use(verifyAccessToken);
bankRouter.get("/", listBanks);

export const bankAccountRouter = express.Router();
bankAccountRouter.use(verifyAccessToken);
// before /:id, so "resolve" isn't read as an id
bankAccountRouter.get("/resolve", lookupLimiter, resolveBankAccount);
bankAccountRouter.get("/", listBankAccounts);
bankAccountRouter.post("/", lookupLimiter, saveBankAccount);
bankAccountRouter.delete("/:bankAccountId", removeBankAccount);

export const withdrawalRouter = express.Router();
withdrawalRouter.use(verifyAccessToken);
withdrawalRouter.get("/quote", quoteWithdrawal);
withdrawalRouter.post("/", moneyLimiter, idempotency, createWithdrawal);
withdrawalRouter.get("/", listWithdrawals);
withdrawalRouter.get("/:withdrawalId", getWithdrawal);
withdrawalRouter.post("/:withdrawalId/sync", syncOwnWithdrawal);
