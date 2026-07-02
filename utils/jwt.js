import jwt from "jsonwebtoken";
import {
  accessSecret,
  refreshSecret,
  accessExpiry,
  refreshExpiry,
} from "../env.js";

export function createAccessToken(user) {
  const token = jwt.sign(
    {
      id: user.id,
      password: user.password,
      email: user.email,
    },
    accessSecret,
    { expiresIn: accessExpiry },
  );
  return token;
}

export function refreshToken(user) {
  const token = jwt.sign(
    {
      id: user.id,
      password: user.password,
      email: user.email,
    },
    refreshSecret,
    { expiresIn: refreshExpiry },
  );
}
