import crypto from "crypto";
import { pool } from "../db/connectDB.js";
import env from "../env.js";
import { createAccessToken, createRefreshToken } from "./jwt.js";

const cookieOptions = {
  httpOnly: true,
  secure: env.nodeEnv === "production",
  // Lax, not Strict: the browser must still send the session when a payment
  // page (Flutterwave checkout) sends the customer back to us. Lax still
  // withholds cookies from cross-site POST/PATCH/DELETE, and every GET is a read.
  sameSite: "lax",
};

export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Issues a new access/refresh token pair, stores the refresh token's hash and
// sets both cookies. Cookie and DB expiry follow the JWT expiry from env.
//
// Two-factor state rides in the access token (API doc 2.2, 2.4):
//   twoFactorPending   password accepted, 2FA code not yet verified; the
//                      token only works on POST /v1/auth/2fa/verify, and
//                      the refresh row remembers it so a refresh can't
//                      upgrade the session
//   twoFactorAt        when a 2FA code was last verified (epoch seconds);
//                      "User + 2FA" actions need this to be recent
export async function issueSession(
  res,
  user,
  { twoFactorPending = false, twoFactorAt = null } = {},
) {
  const { accessSecret, refreshSecret, accessExpiry, refreshExpiry } =
    env.jwtdet;
  const payload = { sub: user.user_id, email: user.email };
  const accessClaims = {
    ...payload,
    ...(twoFactorPending && { tfa: "pending" }),
    ...(twoFactorAt && { tfa_at: twoFactorAt }),
  };
  const accessToken = createAccessToken(accessClaims, accessSecret, accessExpiry);
  const refreshToken = createRefreshToken(payload, refreshSecret, refreshExpiry);

  await pool.query(
    `
    INSERT INTO refresh_tokens (
        user_id,
        token_hash,
        expires_at,
        two_factor_pending
    )
    VALUES ($1, $2, $3, $4)
    `,
    [
      user.user_id,
      hashToken(refreshToken),
      new Date(Date.now() + env.jwtdet.refreshExpiryMs),
      twoFactorPending,
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
