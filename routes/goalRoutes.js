import express from "express";
import {
  closeGoal,
  contributeToGoal,
  createGoal,
  getGoal,
  listGoals,
  updateGoal,
  withdrawFromGoal,
} from "../controllers/goalController.js";
import { idempotency } from "../utils/idempotency.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { moneyLimiter } from "../utils/rateLimiters.js";

// Savings goals. Anything that moves money takes an Idempotency-Key.
const goalRouter = express.Router();

goalRouter.use(verifyAccessToken);
goalRouter.post("/", createGoal);
goalRouter.get("/", listGoals);
goalRouter.get("/:goalId", getGoal);
goalRouter.patch("/:goalId", updateGoal);
goalRouter.post("/:goalId/contributions", moneyLimiter, idempotency, contributeToGoal);
goalRouter.post("/:goalId/withdrawals", moneyLimiter, idempotency, withdrawFromGoal);
goalRouter.post("/:goalId/close", moneyLimiter, idempotency, closeGoal);

export default goalRouter;
