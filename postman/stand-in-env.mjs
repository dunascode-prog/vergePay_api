// Environment for running the API and the worker against the local
// stand-ins (Flutterwave on :9999, Alpaca on :9998) instead of the real
// providers. Variables set here win over .env (dotenv never overrides
// them), so the real keys in .env are left alone.
//
// REDIS_URL is NOT overridden: the queue uses the Redis in .env (e.g.
// Upstash), or whatever REDIS_URL is set in the shell.

// The suite signs up about a dozen fresh users per run (each customer may
// hold only one personal and one business wallet), well past the default of
// 5 sign-ups per 15 minutes per IP. Test runs only; .env keeps the real limit.
process.env.MAX_FAILED_LOGIN_ATTEMPTS_SIGNUP = "500";

// Flutterwave
process.env.FLW_BASE_URL = `http://localhost:${process.env.FLW_STAND_IN_PORT || 9999}`;
process.env.FLW_SECRET_KEY = "FLWSECK_TEST-stand-in-X";
// must match the collection's flwSecretHash variable
process.env.FLW_SECRET_HASH = "stand-in-secret-hash";
// saved-card charges need a public https redirect (Flutterwave refuses localhost)
process.env.FLW_REDIRECT_URL = "https://example.com/vergepay/payments/complete";

// Alpaca
const alpaca = `http://localhost:${process.env.ALPACA_STAND_IN_PORT || 9998}`;
process.env.ALPACA_CLIENT_ID = "stand-in-client";
process.env.ALPACA_CLIENT_SECRET = "stand-in-secret";
process.env.ALPACA_OAUTH_URL = alpaca;
process.env.ALPACA_API_URL = alpaca;
process.env.ALPACA_TRADING_URL = alpaca;
process.env.ALPACA_REDIRECT_URI = `http://localhost:${process.env.PORT || 8000}/v1/brokerage-links/oauth/callback`;
// the suite tests the OAuth flow, so the shared test account is always off
// here, whatever .env says (unless a test run sets it explicitly)
process.env.ALPACA_SHARED_ACCOUNT = process.env.ALPACA_SHARED_ACCOUNT_STAND_IN ?? "false";
// where the browser lands after the Alpaca step: the UI (override to test a UI on another port)
process.env.BROKERAGE_RETURN_URL =
  process.env.BROKERAGE_RETURN_URL_STAND_IN ?? "http://localhost:3000/dashboard/investments/linked";
// quick retries so the suite can watch the backoff, and no scheduled
// re-syncs getting in the way of a run
process.env.BROKERAGE_RETRY_DELAY_MS = "300";
process.env.BROKERAGE_SYNC_INTERVAL_MS = String(60 * 60 * 1000);
