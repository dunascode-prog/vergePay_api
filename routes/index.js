import authRouter from "./authRoutes.js";
import userRouter from "./userRoutes.js";
import testRoute from "./testRoute.js";

export default function registerRoutes(app) {
  app.use("/v1/auth", authRouter);
  app.use("/v1/users", userRouter);
  app.use("/v1/dashboard", testRoute);
}
//place idempotency on the exact routes that need it, not globally
