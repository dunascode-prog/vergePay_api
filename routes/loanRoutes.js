import express from "express";
import {
  applyForLoan,
  approveLoanApplication,
  disburseLoan,
  getLoan,
  getLoanApplication,
  getLoanSchedule,
  listLoans,
  rejectLoanApplication,
  repayLoan,
} from "../controllers/loanController.js";
import { idempotency, optionalIdempotency } from "../utils/idempotency.js";
import { requireInternalCaller } from "../utils/internalAuth.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { moneyLimiter } from "../utils/rateLimiters.js";

// Borrower routes use the session cookie; the decision and payout routes are
// "Admin or System" and use the internal API key instead (API doc 7.2).
const loanRouter = express.Router();

loanRouter.post("/applications", verifyAccessToken, optionalIdempotency, applyForLoan);
loanRouter.get("/applications/:applicationId", verifyAccessToken, getLoanApplication);
loanRouter.post("/applications/:applicationId/approve", requireInternalCaller, approveLoanApplication);
loanRouter.post("/applications/:applicationId/reject", requireInternalCaller, rejectLoanApplication);

loanRouter.get("/", verifyAccessToken, listLoans);
loanRouter.get("/:loanId", verifyAccessToken, getLoan);
loanRouter.get("/:loanId/schedule", verifyAccessToken, getLoanSchedule);
loanRouter.post("/:loanId/disburse", requireInternalCaller, idempotency, disburseLoan);
loanRouter.post("/:loanId/repayments", verifyAccessToken, moneyLimiter, idempotency, repayLoan);

export default loanRouter;
