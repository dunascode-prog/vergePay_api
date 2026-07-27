import jwt from "jsonwebtoken";
import env from "../env.js";
import { TokenExpiredError, UnauthorizedError } from "./errorStr.js";
export function createAccessToken(payload, accessSecret, accessExpiry) {
  const token = jwt.sign(payload, accessSecret, {
    expiresIn: accessExpiry,
    issuer: "VergePay",
    audience: "vergepay-api",
  });
  return token;
}

export function createRefreshToken(payload, refreshSecret, refreshExpiry) {
  const token = jwt.sign(payload, refreshSecret, {
    expiresIn: refreshExpiry,
    issuer: "VergePay",
    audience: "vergepay-api",
  });
  return token;
}

export function verifyAccessToken(req, res, next) {
  const token = req.cookies["access_token"];

  if (!token) {
    throw new UnauthorizedError();
  }

  try {
    const payload = jwt.verify(token, env.jwtdet.accessSecret);
    req.user = payload;
    next();
  } catch (err) {
    throw new TokenExpiredError();
  }
}
