import express from "express";
import {
  backdateInvoice,
  backdateRecurringPlan,
  runRecurringBilling,
  checkInvariants,
  expireOauthState,
  forgetIdempotencyKey,
  runBrokerageScheduler,
  fundOwnAccount,
  resetTestUser,
  verifyOwnKyc,
  decideOwnLoanApplication,
  backdateLoan,
} from "../controllers/devController.js";
import { idempotency } from "../utils/idempotency.js";
import { verifyAccessToken, verifyAccessTokenAllowPending } from "../utils/jwt.js";

// Mounted only outside production (routes/index.js).
const devRouter = express.Router();

devRouter.post("/kyc/verify", verifyAccessToken, verifyOwnKyc);
devRouter.post("/accounts/:accountId/fund", verifyAccessToken, idempotency, fundOwnAccount);

// Test-suite helpers (postman/). The reset also accepts a session still
// waiting for its 2FA code, so a run that stopped halfway can recover.
devRouter.post("/test-user/reset", verifyAccessTokenAllowPending, resetTestUser);
devRouter.delete("/idempotency-keys/:key", verifyAccessToken, forgetIdempotencyKey);
devRouter.post("/invoices/:invoiceId/backdate", verifyAccessToken, backdateInvoice);
devRouter.post("/recurring-plans/:planId/backdate", verifyAccessToken, backdateRecurringPlan);
devRouter.post("/recurring/run", verifyAccessToken, runRecurringBilling);
devRouter.get("/invariants", verifyAccessToken, checkInvariants);
devRouter.post("/oauth-states/expire", verifyAccessToken, expireOauthState);
devRouter.post("/brokerage/run-scheduler", verifyAccessToken, runBrokerageScheduler);
devRouter.post("/loans/applications/:applicationId/decide", verifyAccessToken, decideOwnLoanApplication);
devRouter.post("/loans/:loanId/backdate", verifyAccessToken, backdateLoan);

export default devRouter;
