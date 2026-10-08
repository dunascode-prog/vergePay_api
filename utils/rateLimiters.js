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

// Public invoice pay links (routes/payLinkRoutes.js), keyed per link: a
// pay page is opened by its client, and requests arrive through the web
// app's proxy, so a per-IP key would put every payer in one bucket.
export const payLinkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  keyGenerator: (req) => `pay:${req.params.token}`,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next) => {
    next(new TooManyRequestsError({ message: "Too many requests for this payment link. Please wait a few minutes." }));
  },
});

// Starting a checkout creates a payment at Flutterwave, so far fewer.
export const payLinkCheckoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => `checkout:${req.params.token}`,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next) => {
    next(new TooManyRequestsError({ message: "Too many payment attempts for this invoice. Please wait a few minutes." }));
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

// Forgot password: asking for codes (each one sends an email) and trying
// them, per IP. A code also stops after 5 wrong tries on its own.
export const passwordForgotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next) => {
    next(new TooManyRequestsError({ message: "Too many password reset requests. Please try again in a few minutes." }));
  },
});

// Changing the email: each request checks the password and sends an email,
// so it is limited per user (the confirm step has its own 5 tries a code).
export const emailChangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.user.sub,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next) => {
    next(new TooManyRequestsError({ message: "Too many email change attempts. Please try again in a few minutes." }));
  },
});

// Profile photo changes: each one stores a file, so a few per user.
export const photoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.user.sub,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next) => {
    next(new TooManyRequestsError({ message: "Too many photo changes. Please try again in a few minutes." }));
  },
});

// "Ask VergePay": each question loads the customer's figures (and may call
// the open model), so a steady chat pace per user, not a flood.
export const assistantLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.user.sub,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next) => {
    next(new TooManyRequestsError({ message: "You've asked a lot of questions in a short time. Please try again in a few minutes." }));
  },
});

export const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next) => {
    next(new TooManyRequestsError({ message: "Too many attempts. Please try again in a few minutes." }));
  },
});
