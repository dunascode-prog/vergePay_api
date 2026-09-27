import express from "express";
import {
  createTransfer,
  getTransaction,
  reverseTransaction,
} from "../controllers/transactionController.js";
import { idempotency } from "../utils/idempotency.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { moneyLimiter } from "../utils/rateLimiters.js";

const transactionRouter = express.Router();

transactionRouter.use(verifyAccessToken);

transactionRouter.post("/", moneyLimiter, idempotency, createTransfer);
transactionRouter.get("/:transactionId", getTransaction);
transactionRouter.post(
  "/:transactionId/reverse",
  moneyLimiter,
  idempotency,
  reverseTransaction,
);

export default transactionRouter;
