import jwt from "jsonwebtoken";
import env from "../env.js";
import {
  TokenExpiredError,
  TwoFactorRequiredError,
  UnauthorizedError,
} from "./errorStr.js";

const jwtOptions = { issuer: "VergePay", audience: "vergepay-api" };

export function createAccessToken(payload, accessSecret, accessExpiry) {
  const token = jwt.sign(payload, accessSecret, {
    expiresIn: accessExpiry,
    ...jwtOptions,
  });
  return token;
}

export function createRefreshToken(payload, refreshSecret, refreshExpiry) {
  const token = jwt.sign(payload, refreshSecret, {
    expiresIn: refreshExpiry,
    ...jwtOptions,
  });
  return token;
}

export function verifyRefreshToken(token) {
  return jwt.verify(token, env.jwtdet.refreshSecret, jwtOptions);
}

function readAccessToken(req) {
  const token = req.cookies["access_token"];

  if (!token) {
    throw new UnauthorizedError();
  }

  try {
    return jwt.verify(token, env.jwtdet.accessSecret, jwtOptions);
  } catch (err) {
    // Only a genuinely expired token is worth refreshing; a forged,
    // tampered or wrongly-issued token is simply unauthorized.
    if (err instanceof jwt.TokenExpiredError) {
      throw new TokenExpiredError();
    }
    throw new UnauthorizedError({ message: "Invalid access token." });
  }
}

// A full session. A session still waiting for its 2FA code is refused here
// (API doc 2.2), so it can reach nothing but POST /v1/auth/2fa/verify.
export function verifyAccessToken(req, res, next) {
  const payload = readAccessToken(req);
  if (payload.tfa === "pending") {
    throw new TwoFactorRequiredError({
      message: "Enter your two-factor code to finish signing in (POST /v1/auth/2fa/verify).",
    });
  }
  // next() stays outside readAccessToken's try so errors thrown by later
  // handlers are not mistaken for an expired token
  req.user = payload;
  next();
}

// For the 2FA verify endpoint only: accepts a session waiting for its code.
export function verifyAccessTokenAllowPending(req, res, next) {
  req.user = readAccessToken(req);
  next();
}

// A 2FA code verified within this window counts as "recent" for
// "User + 2FA" actions.
export const TWO_FACTOR_FRESH_SECONDS = 5 * 60;

// "User + 2FA" (API doc 1.2): a signed-in user who confirmed a 2FA code in
// the last few minutes. Run after verifyAccessToken.
export function requireRecentTwoFactor(req, res, next) {
  const verifiedAt = req.user?.tfa_at;
  if (!verifiedAt || Date.now() / 1000 - verifiedAt > TWO_FACTOR_FRESH_SECONDS) {
    throw new TwoFactorRequiredError({
      message:
        "This action needs a recent two-factor confirmation. Verify a code with POST /v1/auth/2fa/verify, then retry. If 2FA isn't on yet, set it up with POST /v1/auth/2fa/enable.",
    });
  }
  next();
}
