import express from "express";
import { listApplicationsForReview } from "../controllers/loanController.js";
import { requireInternalCaller } from "../utils/internalAuth.js";

// Back-office endpoints (API doc 11). Never called by the customer app.
const adminRouter = express.Router();

adminRouter.use(requireInternalCaller);

adminRouter.get("/loans/applications", listApplicationsForReview);

export default adminRouter;
