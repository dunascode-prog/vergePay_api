import rateLimit from "express-rate-limit";
import { TooManyRequestsError } from "./errorStr.js";

export const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: "RATE_LIMIT_EXCEEDED",
      message:
        "Too many registration attempts. Please try again in 15 minutes.",
    },
  },
  handler: (req, res, next) => {
    next(
      new TooManyRequestsError({
        message: "Too many registration attempts. Please try again later.",
      }),
    );
  },
});
