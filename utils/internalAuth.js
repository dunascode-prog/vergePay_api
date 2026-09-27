import crypto from "crypto";
import env from "../env.js";
import { ForbiddenError, UnauthorizedError } from "./errorStr.js";

// Guards "Admin or System" endpoints (API doc 7.2, 11): loan approval,
// disbursement and the underwriting queue. The caller is a back-office
// service, not a signed-in customer, so it authenticates with the shared
// INTERNAL_API_KEY in the X-Internal-Api-Key header rather than a session
// cookie. Staff accounts with their own roles replace this in Stage 7.
function sameSecret(given, expected) {
  // hashing first gives equal-length buffers, which timingSafeEqual needs
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function requireInternalCaller(req, res, next) {
  if (!env.internalApiKey) {
    throw new ForbiddenError({
      message: "Internal endpoints are disabled: INTERNAL_API_KEY is not configured.",
    });
  }
  const given = req.header("X-Internal-Api-Key");
  if (!given || !sameSecret(given, env.internalApiKey)) {
    throw new UnauthorizedError({ message: "A valid internal API key is required." });
  }
  req.internalCaller = true;
  next();
}
