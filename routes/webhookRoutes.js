import express from "express";
import { receivePaymentProcessorWebhook } from "../controllers/webhookController.js";

// Incoming provider webhooks (API doc 10). No session: each request is
// authenticated by its signature inside the handler.
const webhookRouter = express.Router();

webhookRouter.post("/payment-processor", receivePaymentProcessorWebhook);

export default webhookRouter;
