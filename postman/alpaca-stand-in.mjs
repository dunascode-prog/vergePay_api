// A local stand-in for the Alpaca endpoints the API calls (OAuth + Trading
// API), with the shapes from Alpaca's docs. Lets the suite test the
// brokerage flow on demand: approval or denial, holdings changing, rate
// limits and outages (to see the worker retry), and revoked tokens.
//
//   npm run alpaca:stand-in        (listens on :9998)
//
// Test-only controls, called by the Postman collection:
//   POST /_test/next-authorize   { decision: "approve" | "deny", account_number }
//   POST /_test/positions        { account_number, positions: [{ symbol, qty, avg_entry_price, current_price, asset_class? }] }
//   POST /_test/fail-next        { account_number, statuses: [429, 503, ...] }   next positions calls fail
//   POST /_test/revoke           { account_number }                               its tokens now get 401
//   GET  /_test/calls?account_number=...                                          how many positions calls it has had
import crypto from "crypto";
import http from "http";

export const STAND_IN_CLIENT_ID = "stand-in-client";
export const STAND_IN_CLIENT_SECRET = "stand-in-secret";
const PORT = Number(process.env.ALPACA_STAND_IN_PORT) || 9998;

const ASSETS = {
  AAPL: { name: "Apple Inc. Common Stock", class: "us_equity", exchange: "NASDAQ" },
  MSFT: { name: "Microsoft Corporation Common Stock", class: "us_equity", exchange: "NASDAQ" },
  VOO: { name: "Vanguard S&P 500 ETF", class: "us_equity", exchange: "ARCA" },
  BTCUSD: { name: "Bitcoin / US Dollar", class: "crypto", exchange: "CRYPTO" },
};

let nextAuthorize = { decision: "approve", account_number: "PA3STANDIN01" };
const codes = new Map(); // code -> { account_number, redirect_uri, used }
const tokens = new Map(); // token -> account_number
const revoked = new Set(); // account numbers whose tokens are refused
const positions = new Map(); // account_number -> positions
const failures = new Map(); // account_number -> statuses to answer next
const calls = new Map(); // account_number -> positions calls

const send = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

function position(p) {
  const qty = String(p.qty);
  const avg = String(p.avg_entry_price);
  const price = String(p.current_price ?? p.avg_entry_price);
  const value = (Number(qty) * Number(price)).toFixed(2);
  const cost = (Number(qty) * Number(avg)).toFixed(2);
  const asset = ASSETS[p.symbol] ?? { class: "us_equity", exchange: "NYSE" };
  return {
    asset_id: crypto.createHash("md5").update(p.symbol).digest("hex"),
    symbol: p.symbol,
    exchange: asset.exchange,
    asset_class: p.asset_class ?? asset.class,
    qty,
    qty_available: qty,
    side: "long",
    avg_entry_price: avg,
    cost_basis: cost,
    current_price: price,
    market_value: value,
    unrealized_pl: (Number(value) - Number(cost)).toFixed(2),
  };
}

// The platform's own account keys (APCA-API-KEY-ID / APCA-API-SECRET-KEY),
// used by the testing-only shared account (ALPACA_SHARED_ACCOUNT=true).
export const STAND_IN_KEY_ID = "PKSTANDIN";
export const STAND_IN_KEY_SECRET = "stand-in-key-secret";
const SHARED_ACCOUNT = "PA3SHARED0001";

function bearer(req) {
  if (req.headers["apca-api-key-id"] !== undefined) {
    const ok = req.headers["apca-api-key-id"] === STAND_IN_KEY_ID && req.headers["apca-api-secret-key"] === STAND_IN_KEY_SECRET;
    return ok && !revoked.has(SHARED_ACCOUNT) ? SHARED_ACCOUNT : null;
  }
  const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const account = tokens.get(token);
  return account && !revoked.has(account) ? account : null;
}

http
  .createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const json = () => {
      try {
        return raw ? JSON.parse(raw) : {};
      } catch {
        return {};
      }
    };

    // ---- test controls
    if (path === "/_test/next-authorize") {
      nextAuthorize = { ...nextAuthorize, ...json() };
      return send(res, 200, nextAuthorize);
    }
    if (path === "/_test/positions") {
      const body = json();
      positions.set(body.account_number, body.positions ?? []);
      return send(res, 200, { account_number: body.account_number, count: (body.positions ?? []).length });
    }
    if (path === "/_test/fail-next") {
      const body = json();
      failures.set(body.account_number, [...(body.statuses ?? [])]);
      return send(res, 200, body);
    }
    if (path === "/_test/revoke") {
      revoked.add(json().account_number);
      return send(res, 200, { revoked: true });
    }
    if (path === "/_test/calls") {
      return send(res, 200, { positions_calls: calls.get(url.searchParams.get("account_number")) ?? 0 });
    }

    // ---- OAuth: the user "logs in and approves" instantly
    if (req.method === "GET" && path === "/oauth/authorize") {
      const redirect = new URL(url.searchParams.get("redirect_uri"));
      redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
      if (url.searchParams.get("client_id") !== STAND_IN_CLIENT_ID) {
        return send(res, 400, { message: "unknown client_id" });
      }
      if (nextAuthorize.decision === "deny") {
        redirect.searchParams.set("error", "access_denied");
      } else {
        const code = crypto.randomBytes(16).toString("hex");
        codes.set(code, { account_number: nextAuthorize.account_number, redirect_uri: url.searchParams.get("redirect_uri"), used: false });
        redirect.searchParams.set("code", code);
      }
      res.writeHead(302, { Location: redirect.toString() });
      return res.end();
    }
    if (req.method === "POST" && path === "/oauth/token") {
      const form = new URLSearchParams(raw);
      const entry = codes.get(form.get("code"));
      if (form.get("client_id") !== STAND_IN_CLIENT_ID || form.get("client_secret") !== STAND_IN_CLIENT_SECRET) {
        return send(res, 401, { message: "invalid client credentials" });
      }
      if (form.get("grant_type") !== "authorization_code" || !entry || entry.used || entry.redirect_uri !== form.get("redirect_uri")) {
        return send(res, 400, { message: "invalid_grant" });
      }
      entry.used = true;
      revoked.delete(entry.account_number);
      const token = crypto.randomBytes(24).toString("hex");
      tokens.set(token, entry.account_number);
      return send(res, 200, { access_token: token, token_type: "bearer", scope: "account:write trading" });
    }

    // ---- Trading API
    // every positions call is counted, refused ones too, so a test can see
    // exactly how many attempts the worker made
    const caller = req.headers["apca-api-key-id"] !== undefined
      ? SHARED_ACCOUNT
      : tokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    if (path === "/v2/positions" && caller) calls.set(caller, (calls.get(caller) ?? 0) + 1);
    const account = bearer(req);
    if (!account) return send(res, 401, { code: 40110000, message: "access key verification failed" });

    if (req.method === "GET" && path === "/v2/account") {
      return send(res, 200, { id: crypto.createHash("md5").update(account).digest("hex"), account_number: account, status: "ACTIVE", currency: "USD" });
    }
    if (req.method === "GET" && path === "/v2/positions") {
      const queue = failures.get(account) ?? [];
      if (queue.length) {
        const status = queue.shift();
        return send(res, status, { message: status === 429 ? "rate limit exceeded" : "internal server error" });
      }
      return send(res, 200, (positions.get(account) ?? []).map(position));
    }
    const assetMatch = /^\/v2\/assets\/([^/]+)$/.exec(path);
    if (req.method === "GET" && assetMatch) {
      const symbol = decodeURIComponent(assetMatch[1]);
      const asset = ASSETS[symbol] ?? { name: `${symbol} Inc.`, class: "us_equity", exchange: "NYSE" };
      return send(res, 200, { id: symbol, symbol, name: asset.name, class: asset.class, exchange: asset.exchange, tradable: true });
    }
    return send(res, 404, { message: `no stand-in for ${req.method} ${path}` });
  })
  .listen(PORT, () => console.log(`Alpaca stand-in listening on http://localhost:${PORT}`));
