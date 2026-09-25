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
