import express from "express";
import {
  blockCard,
  chargeCard,
  getCard,
  listCards,
  removeCard,
  startCardLink,
  unblockCard,
  updateCardControls,
} from "../controllers/cardController.js";
import { idempotency } from "../utils/idempotency.js";
import { requireRecentTwoFactor, verifyAccessToken } from "../utils/jwt.js";
import { moneyLimiter } from "../utils/rateLimiters.js";

// Auth levels follow API doc 5 and 12: blocking is deliberately plain User
// (stop a lost card in one tap); adding, unblocking, removing and changing
// controls need a recent 2FA code.
const cardRouter = express.Router();

cardRouter.use(verifyAccessToken);

cardRouter.post("/", requireRecentTwoFactor, idempotency, startCardLink);
cardRouter.get("/", listCards);
cardRouter.get("/:cardId", getCard);
cardRouter.post("/:cardId/block", blockCard);
cardRouter.post("/:cardId/unblock", requireRecentTwoFactor, unblockCard);
cardRouter.delete("/:cardId", requireRecentTwoFactor, removeCard);
cardRouter.patch("/:cardId/controls", requireRecentTwoFactor, updateCardControls);
cardRouter.post("/:cardId/charges", moneyLimiter, idempotency, chargeCard);

export default cardRouter;
