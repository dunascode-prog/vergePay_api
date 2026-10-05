import express from "express";
import {
  cancelPlan,
  createPlan,
  getPlan,
  listPlans,
  pausePlan,
  resumePlan,
  updatePlan,
} from "../controllers/recurringPlanController.js";
import { verifyAccessToken } from "../utils/jwt.js";

// Recurring billing: plans that invoice a client on a schedule.
const recurringPlanRouter = express.Router();

recurringPlanRouter.use(verifyAccessToken);
recurringPlanRouter.post("/", createPlan);
recurringPlanRouter.get("/", listPlans);
recurringPlanRouter.get("/:planId", getPlan);
recurringPlanRouter.patch("/:planId", updatePlan);
recurringPlanRouter.post("/:planId/pause", pausePlan);
recurringPlanRouter.post("/:planId/resume", resumePlan);
recurringPlanRouter.post("/:planId/cancel", cancelPlan);

export default recurringPlanRouter;
