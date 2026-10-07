import express from "express";
import {
  createPayee,
  createRun,
  getPayee,
  getRun,
  listPayees,
  listRuns,
  updatePayee,
} from "../controllers/payrollController.js";
import { idempotency } from "../utils/idempotency.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { moneyLimiter } from "../utils/rateLimiters.js";

// Payroll: the people a customer pays (/v1/payees) and paying them
// (/v1/payroll/runs, which moves money and takes an Idempotency-Key).
export const payeeRouter = express.Router();
payeeRouter.use(verifyAccessToken);
payeeRouter.post("/", createPayee);
payeeRouter.get("/", listPayees);
payeeRouter.get("/:payeeId", getPayee);
payeeRouter.patch("/:payeeId", updatePayee);

export const payrollRouter = express.Router();
payrollRouter.use(verifyAccessToken);
payrollRouter.post("/runs", moneyLimiter, idempotency, createRun);
payrollRouter.get("/runs", listRuns);
payrollRouter.get("/runs/:runId", getRun);
