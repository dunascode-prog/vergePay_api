import express from "express";
import { refreshToken, signIn, signUp } from "../controllers/authController.js";
import { idempotency } from "../utils/idempotency.js";
import { signinLimiter, signupLimiter } from "../utils/rateLimiters.js";

const authRouter = express.Router();

authRouter.post("/signup", signupLimiter, signUp);
authRouter.post("/signin", signinLimiter, signIn);
authRouter.post("/refresh", refreshToken);

export default authRouter;
