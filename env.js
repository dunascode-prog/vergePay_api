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
  // Optional open chat model for "Ask VergePay" (services/assistant/llm.js),
  // served by Ollama on a server you run. Off unless OLLAMA_URL is set.
  ai: {
    ollamaUrl: process.env.OLLAMA_URL,
    ollamaApiKey: process.env.OLLAMA_KEY, // only if the server sits behind a key
    model: process.env.OLLAMA_MODEL || "qwen2.5:3b",
    timeoutMs: parseInt(process.env.OLLAMA_TIMEOUT_MS, 10) || 12_000,
  },
  // The assistant's own small model (services/assistant/matcher.js), run in
  // this process: a free sentence-embedding model, downloaded once (~34 MB).
  assistant: {
    embeddingModel: process.env.ASSISTANT_EMBEDDING_MODEL || "Xenova/bge-small-en-v1.5",
    modelCacheDir: process.env.ASSISTANT_MODEL_CACHE || "./.model-cache",
  },
  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:3000",
  // The web app's public address, for links in emails and on invoices
  // (pay links: <APP_URL>/pay/<token>). Defaults to CORS_ORIGIN.
  appUrl: (process.env.APP_URL || process.env.CORS_ORIGIN || "http://localhost:3000").replace(/\/$/, ""),
  // Outgoing email (services/email.js). Any SMTP service works, e.g. Brevo's
  // free plan: SMTP_URL=smtp://<login>:<smtp key>@smtp-relay.brevo.com:587
  // Without SMTP_URL, development uses Ethereal (fake inboxes with a preview
  // link per message) and production marks emails failed.
  // EMAIL_TRANSPORT=json builds messages without sending them (tests).
  email: {
    smtpUrl: process.env.SMTP_URL,
    from: process.env.EMAIL_FROM || "VergePay <no-reply@vergepay.dev>",
    transport: process.env.EMAIL_TRANSPORT || (process.env.SMTP_URL ? "smtp" : "ethereal"),
  },
  // Web app origins allowed to open the live-updates WebSocket
  // (realtime/websocketServer.js), comma-separated. Defaults to CORS_ORIGIN.
  wsAllowedOrigins: (process.env.WS_ALLOWED_ORIGINS || process.env.CORS_ORIGIN || "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
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
  // Recurring billing (services/recurring.js): how often the worker looks
  // for plans that are due. Plans bill by date, so this only sets how soon
  // after midnight (in the customer's timezone) the invoice goes out.
  recurring: {
    intervalMs: parseInt(process.env.RECURRING_BILLING_INTERVAL_MS, 10) || 15 * 60 * 1000,
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
  // Loan repayment rules (services/loanRepayments.js, services/loanJobs.js).
  // Amounts in minor units; 500 bps = 5% of the late installment.
  loans: {
    graceDays: parseInt(process.env.LOAN_GRACE_DAYS, 10) || 3,
    lateFeeBps: parseInt(process.env.LOAN_LATE_FEE_BPS, 10) || 500,
    lateFeeMinMinor: parseInt(process.env.LOAN_LATE_FEE_MIN_MINOR, 10) || 50_000,
    defaultAfterDays: parseInt(process.env.LOAN_DEFAULT_AFTER_DAYS, 10) || 90,
    // the smallest payment, unless what's left is less
    minRepaymentMinor: parseInt(process.env.LOAN_MIN_REPAYMENT_MINOR, 10) || 10_000,
    // at most one "couldn't collect your repayment" alert this often
    autoDebitAlertEveryDays: parseInt(process.env.LOAN_AUTO_DEBIT_ALERT_DAYS, 10) || 3,
    // how often the worker runs auto-debits, late fees and defaults
    jobIntervalMs: parseInt(process.env.LOAN_JOB_INTERVAL_MS, 10) || 60 * 60 * 1000,
  },
  // Withdrawals to bank accounts (services/payouts.js). Amounts in kobo:
  // ₦500,000 a day per customer (Lagos day, failed ones don't count), ₦100
  // at least each time.
  withdrawals: {
    dailyLimitMinor: parseInt(process.env.WITHDRAWAL_DAILY_LIMIT_MINOR, 10) || 50_000_000,
    minMinor: parseInt(process.env.WITHDRAWAL_MIN_MINOR, 10) || 10_000,
    // how often the worker re-checks withdrawals Flutterwave hasn't confirmed
    syncIntervalMs: parseInt(process.env.WITHDRAWAL_SYNC_INTERVAL_MS, 10) || 5 * 60 * 1000,
  },
  // Profile photos (services/profilePhotos.js): the largest upload accepted.
  photos: {
    maxBytes: 2 * 1024 * 1024,
  },
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
