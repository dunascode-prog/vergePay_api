import express from "express";
import {
  closeAccount,
  freezeAccount,
  getAccount,
  listAccounts,
  lookupAccountName,
  openAccount,
  unfreezeAccount,
  updateAccount,
} from "../controllers/accountController.js";
import {
  getBalanceHistory,
  listAccountTransactions,
} from "../controllers/transactionController.js";
import {
  createVirtualAccount,
  getVirtualAccount,
} from "../controllers/virtualAccountController.js";
import { idempotency } from "../utils/idempotency.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { lookupLimiter } from "../utils/rateLimiters.js";

const accountRouter = express.Router();

accountRouter.use(verifyAccessToken);

accountRouter.get("/", listAccounts);
accountRouter.post("/", idempotency, openAccount);
// before /:accountId, so "lookup" isn't read as an account id
accountRouter.get("/lookup", lookupLimiter, lookupAccountName);
accountRouter.get("/:accountId", getAccount);
accountRouter.patch("/:accountId", updateAccount);
accountRouter.get("/:accountId/transactions", listAccountTransactions);
accountRouter.get("/:accountId/balance-history", getBalanceHistory);

// State changes are explicit actions rather than a PATCH of account_status,
// so only legal transitions are possible (API doc 4.5).
accountRouter.post("/:accountId/freeze", freezeAccount);
accountRouter.post("/:accountId/unfreeze", unfreezeAccount);
accountRouter.post("/:accountId/close", closeAccount);

// a permanent bank account number for funding by bank transfer
accountRouter.get("/:accountId/virtual-account", getVirtualAccount);
accountRouter.post("/:accountId/virtual-account", createVirtualAccount);

export default accountRouter;
