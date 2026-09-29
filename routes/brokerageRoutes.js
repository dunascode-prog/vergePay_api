import express from "express";
import {
  brokerageOauthCallback,
  deleteBrokerageLink,
  getHolding,
  listBrokerageLinks,
  listHoldings,
  startBrokerageLink,
  syncBrokerageLink,
} from "../controllers/brokerageController.js";
import { requireRecentTwoFactor, verifyAccessToken } from "../utils/jwt.js";

// Investments (API doc 9). Connecting and disconnecting are "User + 2FA";
// the OAuth callback is public, protected by its single-use state.
export const brokerageRouter = express.Router();

brokerageRouter.get("/oauth/callback", brokerageOauthCallback);
brokerageRouter.post("/", verifyAccessToken, requireRecentTwoFactor, startBrokerageLink);
brokerageRouter.get("/", verifyAccessToken, listBrokerageLinks);
brokerageRouter.post("/:linkId/sync", verifyAccessToken, syncBrokerageLink);
brokerageRouter.delete("/:linkId", verifyAccessToken, requireRecentTwoFactor, deleteBrokerageLink);

export const holdingRouter = express.Router();

holdingRouter.use(verifyAccessToken);
holdingRouter.get("/", listHoldings);
holdingRouter.get("/:holdingId", getHolding);
