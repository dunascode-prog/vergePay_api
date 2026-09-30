import dotenv from "dotenv";
dotenv.config();

const required = ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "DATABASE_URI"];

for (const key of required) {
  if (!process.env[key] || process.env[key].startsWith("replace_with")) {
    console.error(
      `[config] Missing or placeholder env var: ${key}. Check your .env file.`,
    );
  }
}

// "15m", "3d" etc. -> milliseconds, so cookies and DB expiry match the JWT expiry
function durationToMs(value) {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) {
    throw new Error(`[config] Invalid duration "${value}". Use e.g. 15m or 3d.`);
  }
  const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Number(match[1]) * unitMs[match[2]];
}

const accessExpiry = process.env.JWT_ACCESS_EXPIRY || "15m";
const refreshExpiry = process.env.JWT_REFRESH_EXPIRY || "3d";

const env = {
  port: parseInt(process.env.PORT, 10) || 4000,
  nodeEnv: process.env.NODE_ENV || "development",
  databaseUrl: process.env.DATABASE_URI,
  jwtdet: {
    accessSecret: process.env.JWT_ACCESS_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    accessExpiry,
    refreshExpiry,
    accessExpiryMs: durationToMs(accessExpiry),
    refreshExpiryMs: durationToMs(refreshExpiry),
  },
  security: {
    maxFailedLoginAttemptsSignIn:
      parseInt(process.env.MAX_FAILED_LOGIN_ATTEMPTS_SIGNIN, 10) || 5,
    lockoutDurationMinutesSignIn:
      parseInt(process.env.LOCKOUT_DURATION_MINUTES_SIGNIN, 10) || 15,
    maxFailedLoginAttemptsSignUp:
      parseInt(process.env.MAX_FAILED_LOGIN_ATTEMPTS_SIGNUP, 10) || 5,
    lockoutDurationMinutesSignUp:
      parseInt(process.env.LOCKOUT_DURATION_MINUTES_SIGNUP, 10) || 15,
  },
  ai: {
    apiKey: process.env.OLLAMA_KEY,
    model: process.env.OLLAMA_MODEL || "claude-sonnet-4-6",
  },
  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:3000",
  // 64 hex characters; encrypts third-party tokens in the vault (services/vault.js)
  vaultEncryptionKey: process.env.VAULT_ENCRYPTION_KEY,
  // Redis for the BullMQ job queue (services/queue.js), e.g. a Redis Cloud
  // redis:// URL. Redis Cloud's copy button gives the whole CLI command
  // ("redis-cli -u redis://..."), so that prefix is tolerated.
  redisUrl: process.env.REDIS_URL?.trim().replace(/^redis-cli\s+(?:\S+\s+)*?-u\s+/, ""),
  // Alpaca brokerage (services/alpaca.js). Off until the client id, secret
  // and redirect URI are set.
  alpaca: {
    clientId: process.env.ALPACA_CLIENT_ID,
    clientSecret: process.env.ALPACA_CLIENT_SECRET,
    // must match the app's redirect URI in the Alpaca dashboard
    redirectUri:
      process.env.ALPACA_REDIRECT_URI ||
      `http://localhost:${parseInt(process.env.PORT, 10) || 4000}/v1/brokerage-links/oauth/callback`,
    environment: process.env.ALPACA_ENV || "paper",
    // Testing only: link every user to the platform's own paper account
    // (these keys) instead of their own via OAuth. Never on in production.
    sharedAccount: process.env.ALPACA_SHARED_ACCOUNT === "true" && process.env.NODE_ENV !== "production",
    paperKeyId: process.env.ALPACA_PAPER_KEY_ID,
    paperSecret: process.env.ALPACA_PAPER_SECRET,
    oauthUrl: process.env.ALPACA_OAUTH_URL || "https://app.alpaca.markets",
    apiUrl: process.env.ALPACA_API_URL || "https://api.alpaca.markets",
    tradingUrl:
      process.env.ALPACA_TRADING_URL ||
      ((process.env.ALPACA_ENV || "paper") === "live" ? "https://api.alpaca.markets" : "https://paper-api.alpaca.markets"),
  },
  brokerage: {
    // where the OAuth callback sends the browser afterwards (a UI page)
    returnUrl:
      process.env.BROKERAGE_RETURN_URL ||
      `${process.env.CORS_ORIGIN || "http://localhost:3000"}/dashboard/investments/linked`,
    // how often the scheduler re-syncs every active link
    syncIntervalMs: parseInt(process.env.BROKERAGE_SYNC_INTERVAL_MS, 10) || 15 * 60 * 1000,
    // first retry delay; each retry doubles it
    retryDelayMs: parseInt(process.env.BROKERAGE_RETRY_DELAY_MS, 10) || 5000,
  },
  // Identity verification (services/kyc.js). "sandbox" decides submissions
  // itself, for development and tests; anything else leaves them pending for
  // a real provider's webhook or a back-office review. Never sandbox in production.
  kyc: {
    provider:
      process.env.NODE_ENV === "production"
        ? process.env.KYC_PROVIDER || "manual"
        : process.env.KYC_PROVIDER || "sandbox",
    // how long the sandbox "takes" to decide, so the pending state is real
    sandboxDelayMs: parseInt(process.env.KYC_SANDBOX_DELAY_MS, 10) || 1500,
  },
  // shared secret for back-office callers (utils/internalAuth.js); unset
  // disables those endpoints
  internalApiKey: process.env.INTERNAL_API_KEY,
  // 64 hex characters; encrypts TOTP secrets at rest (utils/secretBox.js)
  twoFactorEncryptionKey: process.env.TWO_FACTOR_ENCRYPTION_KEY,
  // Flutterwave (services/flutterwave.js). Card and bank-transfer funding
  // are off until FLW_SECRET_KEY is set.
  flutterwave: {
    secretKey: process.env.FLW_SECRET_KEY,
    publicKey: process.env.FLW_PUBLIC_KEY,
    // the "secret hash" set in the Flutterwave dashboard's webhook settings
    secretHash: process.env.FLW_SECRET_HASH,
    baseUrl: process.env.FLW_BASE_URL || "https://api.flutterwave.com/v3",
    // where hosted checkout sends the customer afterwards (a UI page)
    redirectUrl:
      process.env.FLW_REDIRECT_URL ||
      `${process.env.CORS_ORIGIN || "http://localhost:3000"}/dashboard/payments/complete`,
  },
};
export default env;
