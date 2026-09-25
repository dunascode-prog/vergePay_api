import express from "express";
import {
  closeAccount,
  freezeAccount,
  getAccount,
  listAccounts,
  openAccount,
  unfreezeAccount,
  updateAccount,
} from "../controllers/accountController.js";
import { idempotency } from "../utils/idempotency.js";
import { verifyAccessToken } from "../utils/jwt.js";

const accountRouter = express.Router();

accountRouter.use(verifyAccessToken);

accountRouter.get("/", listAccounts);
accountRouter.post("/", idempotency, openAccount);
accountRouter.get("/:accountId", getAccount);
accountRouter.patch("/:accountId", updateAccount);

// State changes are explicit actions rather than a PATCH of account_status,
// so only legal transitions are possible (API doc 4.5).
accountRouter.post("/:accountId/freeze", freezeAccount);
accountRouter.post("/:accountId/unfreeze", unfreezeAccount);
accountRouter.post("/:accountId/close", closeAccount);

export default accountRouter;
