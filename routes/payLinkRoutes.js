import express from "express";
import { getPayLink, payLinkFromWallet, startCheckout, syncPayLink } from "../controllers/payLinkController.js";
import { idempotency } from "../utils/idempotency.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { moneyLimiter, payLinkCheckoutLimiter, payLinkLimiter } from "../utils/rateLimiters.js";

// Public invoice pay links: /v1/pay/:token. No session, except to pay from
// a VergePay wallet. Rate limited per link.
const payLinkRouter = express.Router();

payLinkRouter.get("/:token", payLinkLimiter, getPayLink);
payLinkRouter.post("/:token/checkout", payLinkCheckoutLimiter, startCheckout);
payLinkRouter.post("/:token/sync", payLinkLimiter, syncPayLink);
payLinkRouter.post("/:token/wallet", verifyAccessToken, moneyLimiter, idempotency, payLinkFromWallet);

export default payLinkRouter;
