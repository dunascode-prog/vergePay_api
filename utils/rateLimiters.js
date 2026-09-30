import rateLimit from "express-rate-limit";
import { TooManyRequestsError } from "./errorStr.js";
import env from "../env.js";

const {
  maxFailedLoginAttemptsSignUp,
  lockoutDurationMinutesSignUp,
  maxFailedLoginAttemptsSignIn,
  lockoutDurationMinutesSignIn,
} = env.security;
export const signupLimiter = rateLimit({
  windowMs: lockoutDurationMinutesSignUp * 60 * 1000,
  max: maxFailedLoginAttemptsSignUp,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next) => {
    next(
      new TooManyRequestsError({
        message: "Too many registration attempts. Please try again later.",
      }),
    );
  },
});
export const signinLimiter = rateLimit({
  windowMs: lockoutDurationMinutesSignIn * 60 * 1000,
  max: maxFailedLoginAttemptsSignIn,
  // only failed logins count toward the lockout
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next) => {
    next(
      new TooManyRequestsError({
        message: "Too many sign-in attempts. Please try again later.",
      }),
    );
  },
});

// 2FA codes: 5 wrong guesses per user per 15 minutes. A 6-digit code has a
// million values, so this keeps guessing hopeless. Runs after the session
// check so req.user is set.
export const twoFactorLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => req.user.sub,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next) => {
    next(
      new TooManyRequestsError({
        message: "Too many two-factor attempts. Please try again later.",
      }),
    );
  },
});

// Money-moving endpoints: per signed-in user, not per IP (API doc 14.2). The
// limit is generous; it exists to contain a runaway client retry loop.
// Must run after verifyAccessToken so req.user is set.
export const moneyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  // back-office callers (utils/internalAuth.js) share one bucket
  keyGenerator: (req) => req.user?.sub ?? "internal",
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next) => {
    next(
      new TooManyRequestsError({
        message: "Too many money-movement requests. Please slow down.",
      }),
    );
  },
});

// Account-name lookups: enough for anyone sending money, too few to harvest
// names by walking through account numbers. Per signed-in user.
export const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.user.sub,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next) => {
    next(
      new TooManyRequestsError({
        message: "Too many account lookups. Please try again in a few minutes.",
      }),
    );
  },
});
