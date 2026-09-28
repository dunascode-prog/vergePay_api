import express from "express";
import {
  backdateInvoice,
  checkInvariants,
  forgetIdempotencyKey,
  fundOwnAccount,
  resetTestUser,
  verifyOwnKyc,
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
devRouter.get("/invariants", verifyAccessToken, checkInvariants);

export default devRouter;
