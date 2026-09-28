import express from "express";
import {
  logout,
  refreshToken,
  signIn,
  signUp,
} from "../controllers/authController.js";
import {
  disableTwoFactor,
  enableTwoFactor,
  verifyTwoFactor,
} from "../controllers/twoFactorController.js";
import {
  requireRecentTwoFactor,
  verifyAccessToken,
  verifyAccessTokenAllowPending,
} from "../utils/jwt.js";
import {
  signinLimiter,
  signupLimiter,
  twoFactorLimiter,
} from "../utils/rateLimiters.js";

const authRouter = express.Router();

authRouter.post("/signup", signupLimiter, signUp);
authRouter.post("/signin", signinLimiter, signIn);
authRouter.post("/refresh", refreshToken);
authRouter.post("/logout", logout);

// Two-factor authentication (API doc 2.4). verify also accepts the limited
// session a 2FA user gets from sign-in.
authRouter.post("/2fa/enable", verifyAccessToken, enableTwoFactor);
authRouter.post("/2fa/verify", verifyAccessTokenAllowPending, twoFactorLimiter, verifyTwoFactor);
authRouter.delete("/2fa", verifyAccessToken, requireRecentTwoFactor, disableTwoFactor);

export default authRouter;
