import authRouter from "./authRoutes.js";
import userRouter from "./userRoutes.js";
import accountRouter from "./accountRoutes.js";
import testRoute from "./testRoute.js";

export default function registerRoutes(app) {
  app.use("/v1/auth", authRouter);
  app.use("/v1/users", userRouter);
  app.use("/v1/accounts", accountRouter);
  app.use("/v1/dashboard", testRoute);
}
//place idempotency on the exact routes that need it, not globally
