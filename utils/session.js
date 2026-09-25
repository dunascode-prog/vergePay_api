import crypto from "crypto";
import { pool } from "../db/connectDB.js";
import env from "../env.js";
import { createAccessToken, createRefreshToken } from "./jwt.js";

const cookieOptions = {
  httpOnly: true,
  secure: env.nodeEnv === "production",
  sameSite: "strict",
};

export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Issues a new access/refresh token pair, stores the refresh token's hash and
// sets both cookies. Cookie and DB expiry follow the JWT expiry from env.
export async function issueSession(res, user) {
  const { accessSecret, refreshSecret, accessExpiry, refreshExpiry } =
    env.jwtdet;
  const payload = { sub: user.user_id, email: user.email };
  const accessToken = createAccessToken(payload, accessSecret, accessExpiry);
  const refreshToken = createRefreshToken(payload, refreshSecret, refreshExpiry);

  await pool.query(
    `
    INSERT INTO refresh_tokens (
        user_id,
        token_hash,
        expires_at
    )
    VALUES ($1, $2, $3)
    `,
    [
      user.user_id,
      hashToken(refreshToken),
      new Date(Date.now() + env.jwtdet.refreshExpiryMs),
    ],
  );

  res.cookie("access_token", accessToken, {
    ...cookieOptions,
    maxAge: env.jwtdet.accessExpiryMs,
  });
  res.cookie("refresh_token", refreshToken, {
    ...cookieOptions,
    maxAge: env.jwtdet.refreshExpiryMs,
  });
}

// Revokes the browser's refresh token (if any) and clears both cookies.
export async function endSession(req, res) {
  const refreshToken = req.cookies["refresh_token"];
  if (refreshToken) {
    await pool.query(`DELETE FROM refresh_tokens WHERE token_hash = $1`, [
      hashToken(refreshToken),
    ]);
  }
  res.clearCookie("access_token", cookieOptions);
  res.clearCookie("refresh_token", cookieOptions);
}
