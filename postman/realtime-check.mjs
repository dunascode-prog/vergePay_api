// End-to-end check of live updates over the WebSocket (/v1/ws), which
// Newman can't open. Creates two fresh customers, connects their sockets
// and checks what arrives when money moves.
//
//   npm run test:realtime                      (API on http://localhost:8000)
//   API_URL=http://localhost:8001 npm run test:realtime
//
// Needs the API running with the dev routes (any non-production start);
// set ORIGIN if CORS_ORIGIN isn't http://localhost:3000.
import WebSocket from "ws";

const API = (process.env.API_URL ?? "http://localhost:8000").replace(/\/$/, "");
const ORIGIN = process.env.ORIGIN ?? "http://localhost:3000";
const WS_URL = API.replace(/^http/, "ws") + "/v1/ws";
const PASSWORD = "VergePay#Test2026";

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${!ok && detail ? ` (${detail})` : ""}`);
}

// A customer with their own cookie jar.
function client() {
  const jar = new Map();
  const call = async (method, path, body, headers = {}) => {
    const response = await fetch(API + path, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const index = pair.indexOf("=");
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { jar, call, cookie: () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ") };
}

async function customer(role, firstName, lastName) {
  const c = client();
  const username = `${role}_${Date.now()}`;
  const email = `${username}@vergepay.dev`;
  await c.call("POST", "/v1/auth/signup", { username, email, password: PASSWORD, confirmPassword: PASSWORD });
  await c.call("POST", "/v1/auth/signin", { email, password: PASSWORD });
  await c.call("PATCH", "/v1/users/me", { first_name: firstName, last_name: lastName });
  await c.call("POST", "/v1/dev/kyc/verify");
  const account = await c.call(
    "POST",
    "/v1/accounts",
    { account_type: "current", currency_code: "NGN", purpose: "personal" },
    { "Idempotency-Key": crypto.randomUUID() },
  );
  if (account.status !== 201) throw new Error(`${role}: couldn't open a wallet (${account.status})`);
  return { ...c, account: account.body };
}

// Opens a socket and records everything it receives.
function connect({ cookie, origin = ORIGIN, url = WS_URL } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  const ws = new WebSocket(url, { headers });
  const messages = [];
  const closed = new Promise((resolve) => ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  const refused = new Promise((resolve) => ws.on("unexpected-response", (_req, res) => resolve(res.statusCode)));
  ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  ws.on("error", () => {});
  const waitFor = (predicate, ms = 5000) =>
    new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const found = messages.find(predicate);
        if (found || Date.now() - started > ms) return resolve(found ?? null);
        setTimeout(tick, 25);
      };
      tick();
    });
  return { ws, messages, closed, refused, waitFor };
}

const within = (promise, ms) => Promise.race([promise, new Promise((r) => setTimeout(() => r("timeout"), ms))]);

console.log(`Live updates against ${API}\n`);

// --- refusals -------------------------------------------------------------
console.log("Who may connect");
const anonymous = connect();
check("no session: closed with 4401", (await within(anonymous.closed, 5000))?.code === 4401);
const forged = connect({ cookie: "access_token=not-a-token" });
check("forged token: closed with 4403", (await within(forged.closed, 5000))?.code === 4403);
const crossSite = connect({ origin: "https://evil.example" });
check("another site's origin: refused with HTTP 403", (await within(crossSite.refused, 5000)) === 403);
const wrongPath = connect({ url: WS_URL + "x" });
check("another path: refused with HTTP 404", (await within(wrongPath.refused, 5000)) === 404);

// --- delivery -------------------------------------------------------------
console.log("\nMoney moving");
const ada = await customer("wsada", "Ada", "Sender");
const bola = await customer("wsbola", "Bola", "Receiver");
await ada.call("POST", "/v1/dev/accounts/" + ada.account.account_id + "/fund", { amount_minor: 1000000 }, { "Idempotency-Key": crypto.randomUUID() });

const adaSocket = connect({ cookie: ada.cookie() });
const bolaSocket = connect({ cookie: bola.cookie() });
const bolaTab2 = connect({ cookie: bola.cookie() });
check("signed in: the socket says ready", Boolean(await adaSocket.waitFor((m) => m.type === "ready")));
await bolaSocket.waitFor((m) => m.type === "ready");
await bolaTab2.waitFor((m) => m.type === "ready");

const transfer = await ada.call(
  "POST",
  "/v1/transactions",
  { sender_account_id: ada.account.account_id, receiver_account_number: bola.account.account_number, amount_minor: 250000, currency_code: "NGN", description: "Website" },
  { "Idempotency-Key": crypto.randomUUID() },
);
check("Ada sends Bola ₦2,500", transfer.status === 201, `status ${transfer.status}`);
const respondedAt = Date.now();

const changed = await bolaSocket.waitFor((m) => m.type === "accounts.changed");
check("Bola's dashboard is told to refresh", changed?.account_ids?.includes(bola.account.account_id) && changed.transaction_id === transfer.body.transaction_id);
const received = await bolaSocket.waitFor((m) => m.type === "notification.created");
check(`Bola gets the alert live (${Math.max(0, Date.now() - respondedAt)} ms after the transfer returned)`, received?.notification?.title === "Ada Sender sent you ₦2,500.00", received?.notification?.title);
check("the balance update arrives before the alert", bolaSocket.messages.indexOf(changed) < bolaSocket.messages.indexOf(received));
check("Bola's second tab gets it too", Boolean(await bolaTab2.waitFor((m) => m.type === "notification.created")));
const debit = await adaSocket.waitFor((m) => m.type === "notification.created" && m.notification.kind === "money_sent");
check("Ada gets her debit alert", debit?.notification?.title === "You sent ₦2,500.00 to Bola Receiver", debit?.notification?.title);

console.log("\nIsolation and rollbacks");
const bolaCount = bolaSocket.messages.length;
const tooMuch = await ada.call(
  "POST",
  "/v1/transactions",
  { sender_account_id: ada.account.account_id, receiver_account_number: bola.account.account_number, amount_minor: 99999999, currency_code: "NGN" },
  { "Idempotency-Key": crypto.randomUUID() },
);
check("a transfer Ada can't afford is refused", tooMuch.status >= 400, `status ${tooMuch.status}`);
await new Promise((r) => setTimeout(r, 1500));
check("a rolled-back transfer sends nothing", bolaSocket.messages.length === bolaCount);

const read = await bola.call("POST", `/v1/notifications/${received.notification.notification_id}/read`);
check("Bola reads the alert", read.status === 200 && read.body.unread_count === 0);
check("his other tab clears its badge", Boolean(await bolaTab2.waitFor((m) => m.type === "notifications.read")));
await new Promise((r) => setTimeout(r, 500));
check("Ada never sees Bola's events", !adaSocket.messages.some((m) => m.type === "notifications.read"));

console.log("\nSigning out");
await bola.call("POST", "/v1/auth/logout");
const afterLogout = connect({ cookie: bola.cookie() });
check("after sign-out a new socket is refused (4401)", (await within(afterLogout.closed, 5000))?.code === 4401);

for (const s of [adaSocket, bolaSocket, bolaTab2]) s.ws.close();
console.log(`\n${failed === 0 ? "All" : `${failed} of`} ${passed + failed} checks ${failed === 0 ? "passed" : "FAILED"}.`);
process.exit(failed === 0 ? 0 : 1);
