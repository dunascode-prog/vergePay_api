import authRouter from "./authRoutes.js";
import userRouter from "./userRoutes.js";
import accountRouter from "./accountRoutes.js";
import transactionRouter from "./transactionRoutes.js";
import devRouter from "./devRoutes.js";
import testRoute from "./testRoute.js";
import env from "../env.js";

export default function registerRoutes(app) {
  app.use("/v1/auth", authRouter);
  app.use("/v1/users", userRouter);
  app.use("/v1/accounts", accountRouter);
  app.use("/v1/transactions", transactionRouter);
  // test helpers (top-ups, KYC bypass) must never exist in production
  if (env.nodeEnv !== "production") {
    app.use("/v1/dev", devRouter);
  }
  app.use("/v1/dashboard", testRoute);
}
//place idempotency on the exact routes that need it, not globally
