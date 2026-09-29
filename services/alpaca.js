import env from "../env.js";
import logger from "../logger.js";
import AppError from "../utils/appError.js";
import { ServiceUnavailableError } from "../utils/errorStr.js";

// Alpaca brokerage client (https://docs.alpaca.markets/us/docs/using-oauth2-and-trading-api):
// OAuth 2.0 authorization-code flow to connect a user's (paper) account,
// then read-only calls for their positions. The base URLs can point at a
// stand-in server for tests (postman/alpaca-stand-in.mjs).
//
// Alpaca doesn't document token expiry or refresh for third-party apps, so
// a token is kept until it's refused (401/403); the link then becomes
// "expired" and the user reconnects.

const TIMEOUT_MS = 20_000;

// The token was refused: retrying won't help, the user has to reconnect.
export class BrokerageAuthError extends AppError {
  constructor(message = "The brokerage no longer accepts this connection. Reconnect it.") {
    super({ message, statusCode: 409, code: "BROKERAGE_RECONNECT_REQUIRED" });
  }
}

// Rate limited, down or unreachable: worth retrying later.
export class BrokerageUnavailableError extends AppError {
  constructor(message = "The brokerage is unavailable right now.") {
    super({ message, statusCode: 503, code: "BROKERAGE_UNAVAILABLE" });
  }
}

export function isConfigured() {
  return Boolean(env.alpaca.clientId && env.alpaca.clientSecret && env.alpaca.redirectUri);
}

function requireConfig() {
  if (!isConfigured()) {
    throw new ServiceUnavailableError({
      message: "Brokerage connections aren't configured on this server (ALPACA_CLIENT_ID, ALPACA_CLIENT_SECRET, ALPACA_REDIRECT_URI).",
    });
  }
}

// Where the user logs in and approves access (step 1 of OAuth).
export function authorizationUrl(state) {
  requireConfig();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.alpaca.clientId,
    redirect_uri: env.alpaca.redirectUri,
    state,
    scope: "account:write trading",
    env: env.alpaca.environment,
  });
  return `${env.alpaca.oauthUrl}/oauth/authorize?${params}`;
}

async function call(url, init) {
  let response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    logger.error({ message: "alpaca request failed", url, error: err.message });
    throw new BrokerageUnavailableError("The brokerage couldn't be reached.");
  }
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { message: text.slice(0, 200) };
  }
  if (response.status === 401 || response.status === 403) throw new BrokerageAuthError();
  if (response.status === 429 || response.status >= 500) {
    throw new BrokerageUnavailableError(`The brokerage answered ${response.status}${json.message ? `: ${json.message}` : ""}.`);
  }
  if (!response.ok) {
    throw new AppError({
      message: json.message || `The brokerage rejected the request (${response.status}).`,
      statusCode: 502,
      code: "BROKERAGE_ERROR",
    });
  }
  return json;
}

// Step 2 of OAuth: swap the one-time code for an access token, server to
// server, with the client secret. Returns the token string.
export async function exchangeCode(code) {
  requireConfig();
  const json = await call(`${env.alpaca.apiUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: env.alpaca.clientId,
      client_secret: env.alpaca.clientSecret,
      redirect_uri: env.alpaca.redirectUri,
    }),
  });
  if (!json.access_token) throw new BrokerageAuthError("The brokerage didn't return an access token.");
  return json.access_token;
}

const get = (token, path) =>
  call(`${env.alpaca.tradingUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });

// { account_number, currency, status, ... }
export const getAccount = (token) => get(token, "/v2/account");

// [{ symbol, asset_class, exchange, qty, avg_entry_price, current_price, market_value, unrealized_pl, ... }]
export const getPositions = (token) => get(token, "/v2/positions");

// { symbol, name, class, exchange, ... }
export const getAsset = (token, symbol) => get(token, `/v2/assets/${encodeURIComponent(symbol)}`);
