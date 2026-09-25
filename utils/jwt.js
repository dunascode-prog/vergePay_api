import jwt from "jsonwebtoken";
import env from "../env.js";
import { TokenExpiredError, UnauthorizedError } from "./errorStr.js";

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

export function verifyAccessToken(req, res, next) {
  const token = req.cookies["access_token"];

  if (!token) {
    throw new UnauthorizedError();
  }

  let payload;
  try {
    payload = jwt.verify(token, env.jwtdet.accessSecret, jwtOptions);
  } catch (err) {
    throw new TokenExpiredError();
  }
  // next() stays outside the try so errors thrown by later handlers are not
  // mistaken for an expired token
  req.user = payload;
  next();
}
