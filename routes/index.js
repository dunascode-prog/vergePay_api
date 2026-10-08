import authRouter from "./authRoutes.js";
import userRouter from "./userRoutes.js";
import kycRouter from "./kycRoutes.js";
import accountRouter from "./accountRoutes.js";
import transactionRouter from "./transactionRoutes.js";
import loanRouter from "./loanRoutes.js";
import adminRouter from "./adminRoutes.js";
import invoiceRouter from "./invoiceRoutes.js";
import clientRouter from "./clientRoutes.js";
import recurringPlanRouter from "./recurringPlanRoutes.js";
import goalRouter from "./goalRoutes.js";
import { payeeRouter, payrollRouter } from "./payrollRoutes.js";
import { bankAccountRouter, bankRouter, withdrawalRouter } from "./withdrawalRoutes.js";
import payLinkRouter from "./payLinkRoutes.js";
import cardRouter from "./cardRoutes.js";
import webhookRouter from "./webhookRoutes.js";
import { brokerageRouter, holdingRouter } from "./brokerageRoutes.js";
import notificationRouter from "./notificationRoutes.js";
import { assistantRouter, recommendationRouter } from "./assistantRoutes.js";
import devRouter from "./devRoutes.js";
import testRoute from "./testRoute.js";
import env from "../env.js";

export default function registerRoutes(app) {
  app.use("/v1/auth", authRouter);
  app.use("/v1/users", userRouter);
  app.use("/v1/kyc", kycRouter);
  app.use("/v1/accounts", accountRouter);
  app.use("/v1/transactions", transactionRouter);
  app.use("/v1/loans", loanRouter);
  app.use("/v1/invoices", invoiceRouter);
  app.use("/v1/clients", clientRouter);
  app.use("/v1/recurring-plans", recurringPlanRouter);
  app.use("/v1/goals", goalRouter);
  app.use("/v1/assistant", assistantRouter);
  app.use("/v1/recommendations", recommendationRouter);
  app.use("/v1/payees", payeeRouter);
  app.use("/v1/payroll", payrollRouter);
  app.use("/v1/banks", bankRouter);
  app.use("/v1/bank-accounts", bankAccountRouter);
  app.use("/v1/withdrawals", withdrawalRouter);
  // public: invoice pay links
  app.use("/v1/pay", payLinkRouter);
  app.use("/v1/cards", cardRouter);
  app.use("/v1/webhooks", webhookRouter);
  app.use("/v1/brokerage-links", brokerageRouter);
  app.use("/v1/holdings", holdingRouter);
  app.use("/v1/notifications", notificationRouter);
  app.use("/v1/admin", adminRouter);
  // test helpers (top-ups, KYC bypass) must never exist in production
  if (env.nodeEnv !== "production") {
    app.use("/v1/dev", devRouter);
  }
  app.use("/v1/dashboard", testRoute);
}
//place idempotency on the exact routes that need it, not globally
