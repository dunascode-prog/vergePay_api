import express from "express";
import {
  logout,
  refreshToken,
  signIn,
  signUp,
} from "../controllers/authController.js";
import { signinLimiter, signupLimiter } from "../utils/rateLimiters.js";

const authRouter = express.Router();

authRouter.post("/signup", signupLimiter, signUp);
authRouter.post("/signin", signinLimiter, signIn);
authRouter.post("/refresh", refreshToken);
authRouter.post("/logout", logout);

export default authRouter;
