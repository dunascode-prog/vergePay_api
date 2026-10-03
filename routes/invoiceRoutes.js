import express from "express";
import {
  cancelInvoice,
  createInvoice,
  deleteInvoice,
  getInvoice,
  listInvoices,
  payInvoice,
  refundInvoice,
  remindInvoice,
  sendInvoice,
  updateInvoice,
} from "../controllers/invoiceController.js";
import { idempotency, optionalIdempotency } from "../utils/idempotency.js";
import { requireUserOrInternalCaller } from "../utils/internalAuth.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { moneyLimiter } from "../utils/rateLimiters.js";

const invoiceRouter = express.Router();

invoiceRouter.post("/", verifyAccessToken, optionalIdempotency, createInvoice);
invoiceRouter.get("/", verifyAccessToken, listInvoices);
invoiceRouter.get("/:invoiceId", verifyAccessToken, getInvoice);
// drafts only
invoiceRouter.patch("/:invoiceId", verifyAccessToken, updateInvoice);
invoiceRouter.delete("/:invoiceId", verifyAccessToken, deleteInvoice);
invoiceRouter.post("/:invoiceId/send", verifyAccessToken, sendInvoice);
invoiceRouter.post("/:invoiceId/remind", verifyAccessToken, remindInvoice);
invoiceRouter.post("/:invoiceId/pay", verifyAccessToken, moneyLimiter, idempotency, payInvoice);
// "User or Admin" (API doc 8.2): the issuer, or a back-office caller
invoiceRouter.post("/:invoiceId/cancel", requireUserOrInternalCaller, cancelInvoice);
// the issuer, or a back-office caller settling a dispute
invoiceRouter.post(
  "/:invoiceId/refund",
  requireUserOrInternalCaller,
  moneyLimiter,
  idempotency,
  refundInvoice,
);

export default invoiceRouter;
