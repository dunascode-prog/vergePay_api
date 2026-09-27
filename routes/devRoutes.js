import express from "express";
import { fundOwnAccount, verifyOwnKyc } from "../controllers/devController.js";
import { idempotency } from "../utils/idempotency.js";
import { verifyAccessToken } from "../utils/jwt.js";

// Mounted only outside production (routes/index.js).
const devRouter = express.Router();

devRouter.use(verifyAccessToken);

devRouter.post("/kyc/verify", verifyOwnKyc);
devRouter.post("/accounts/:accountId/fund", idempotency, fundOwnAccount);

export default devRouter;
