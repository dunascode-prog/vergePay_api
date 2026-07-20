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
  windowMs: maxFailedLoginAttemptsSignIn * 60 * 1000,
  max: lockoutDurationMinutesSignIn,
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
