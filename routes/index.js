import authRouter from "./authRoutes.js";
import userRouter from "./userRoutes.js";
import accountRouter from "./accountRoutes.js";
import transactionRouter from "./transactionRoutes.js";
import loanRouter from "./loanRoutes.js";
import adminRouter from "./adminRoutes.js";
import invoiceRouter from "./invoiceRoutes.js";
import cardRouter from "./cardRoutes.js";
import webhookRouter from "./webhookRoutes.js";
import { brokerageRouter, holdingRouter } from "./brokerageRoutes.js";
import devRouter from "./devRoutes.js";
import testRoute from "./testRoute.js";
import env from "../env.js";

export default function registerRoutes(app) {
  app.use("/v1/auth", authRouter);
  app.use("/v1/users", userRouter);
  app.use("/v1/accounts", accountRouter);
  app.use("/v1/transactions", transactionRouter);
  app.use("/v1/loans", loanRouter);
  app.use("/v1/invoices", invoiceRouter);
  app.use("/v1/cards", cardRouter);
  app.use("/v1/webhooks", webhookRouter);
  app.use("/v1/brokerage-links", brokerageRouter);
  app.use("/v1/holdings", holdingRouter);
  app.use("/v1/admin", adminRouter);
  // test helpers (top-ups, KYC bypass) must never exist in production
  if (env.nodeEnv !== "production") {
    app.use("/v1/dev", devRouter);
  }
  app.use("/v1/dashboard", testRoute);
}
//place idempotency on the exact routes that need it, not globally
