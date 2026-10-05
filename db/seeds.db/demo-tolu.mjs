// Demo data for tolu_login (Tolu Adeyemi), so the dashboard, analytics,
// invoices and recurring billing have something real to show.
//
//   npm run seed:demo            (the API must be running: npm run start-dev)
//
// Everything goes through the API, so each transaction is posted by the
// ledger, alerts are written and invoices are numbered like any others.
// Nothing is emailed (send_email: false everywhere; clients use .example
// addresses).
//
// What it adds:
//   - three counterparties (Chidi, Amaka, Bayo), made once and reused
//   - money in and out of Tolu's personal (NGN) and business (USD) wallets
//   - four clients and three one-off invoices: paid, open and overdue
//   - six recurring plans: one with three months of history (two paid),
//     a weekly one that sent its first invoice today, two that start later,
//     one paused and one cancelled
//
// The ledger is append-only, so transactions are dated today; the plan with
// history and the overdue invoice are moved back in time with the dev-only
// backdate helpers instead. Running it again adds another round of
// transactions but refuses to make the plans twice (pass --force to).
//
// Settings (optional): SEED_API_URL (default http://localhost:8000/v1),
// SEED_TOLU_EMAIL, SEED_TOLU_PASSWORD (default: the test suite's Tolu).
import crypto from "crypto";

const API = process.env.SEED_API_URL || "http://localhost:8000/v1";
const TOLU = {
  email: process.env.SEED_TOLU_EMAIL || "tolu.login@vergepay.dev",
  password: process.env.SEED_TOLU_PASSWORD || "Signin#Tolu2026",
};
const PEOPLE_PASSWORD = "VergePay#Seed2026";
const force = process.argv.includes("--force");

// ---- a tiny API client with its own cookie jar

function session(label) {
  const jar = new Map();
  async function call(method, path, body, { key = false, ok = [200, 201, 202] } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (key) headers["Idempotency-Key"] = crypto.randomUUID();
    const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const cookie of res.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(";");
      const at = pair.indexOf("=");
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!ok.includes(res.status)) {
      const message = json?.error?.message ?? text.slice(0, 200);
      const err = new Error(`${label}: ${method} ${path} -> ${res.status} ${message}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }
  return { label, call };
}

const naira = (n) => Math.round(n * 100);
const dollars = naira;
const isoDay = (days = 0) =>
  new Date(Date.now() + days * 86_400_000).toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
const firstOfNextMonth = () => {
  const [y, m] = isoDay().split("-").map(Number);
  return `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`;
};

/** The wallets the dashboard shows: the oldest open current account of each purpose. */
function walletsOf(accounts) {
  const oldest = (purpose) =>
    accounts
      .filter((a) => a.account_type === "current" && a.purpose === purpose && a.account_status === "active")
      .sort((a, b) => a.created_at.localeCompare(b.created_at))[0] ?? null;
  return { personal: oldest("personal"), business: oldest("business") };
}

// ---- counterparties: signed up once, then reused

async function person(username, first, last, wallets) {
  const s = session(first);
  const email = `${username}@vergepay.dev`;
  try {
    await s.call("POST", "/auth/signin", { email, password: PEOPLE_PASSWORD });
  } catch (err) {
    if (err.status !== 401) throw err;
    await s.call("POST", "/auth/signup", { username, email, password: PEOPLE_PASSWORD, confirmPassword: PEOPLE_PASSWORD });
    await s.call("POST", "/auth/signin", { email, password: PEOPLE_PASSWORD });
    await s.call("PATCH", "/users/me", { first_name: first, last_name: last });
  }
  await s.call("POST", "/dev/kyc/verify");
  let accounts = (await s.call("GET", "/accounts")).data;
  for (const [purpose, currency] of wallets) {
    if (!accounts.some((a) => a.account_type === "current" && a.purpose === purpose && a.account_status === "active")) {
      await s.call("POST", "/accounts", { account_type: "current", currency_code: currency, purpose }, { key: true });
    }
  }
  accounts = (await s.call("GET", "/accounts")).data;
  const w = walletsOf(accounts);
  return { ...s, name: `${first} ${last}`, personal: w.personal, business: w.business };
}

async function topUp(who, wallet, amountMinor) {
  await who.call("POST", `/dev/accounts/${wallet.account_id}/fund`, { amount_minor: amountMinor }, { key: true });
}

async function send(from, fromWallet, toWallet, amountMinor, description) {
  await from.call(
    "POST",
    "/transactions",
    { sender_account_id: fromWallet.account_id, receiver_account_number: toWallet.account_number, amount_minor: amountMinor, currency_code: fromWallet.currency_code, description },
    { key: true },
  );
}

async function payLink(payer, wallet, invoice) {
  const token = invoice.pay_url.split("/pay/")[1];
  await payer.call("POST", `/pay/${token}/wallet`, { source_account_id: wallet.account_id }, { key: true });
}

// ---- the seed

const tolu = session("Tolu");
await tolu.call("POST", "/auth/signin", TOLU).catch((err) => {
  if (err.body?.two_factor_required || err.status === 403) {
    throw new Error("Tolu has 2FA on; turn it off first (POST /v1/dev/test-user/reset {two_factor: true} as Tolu).");
  }
  throw err;
});
const me = await tolu.call("GET", "/users/me");
if (me.two_factor_required) throw new Error("Tolu's sign-in asks for a 2FA code; turn 2FA off first.");
console.log(`Seeding ${me.first_name ?? ""} ${me.last_name ?? ""} (${TOLU.email}) against ${API}`);

const existingPlans = (await tolu.call("GET", "/recurring-plans")).data;
const SEEDED = ["Social media management", "Community newsletter", "Website maintenance", "Menu photography", "Domain and hosting", "Brand refresh retainer"];
if (!force && existingPlans.some((p) => SEEDED.includes(p.description))) {
  console.log("Tolu already has the demo plans. Run with --force to add them again.");
  process.exit(0);
}

// recurring billing and money movement need a verified identity
await tolu.call("POST", "/dev/kyc/verify");
const mine = walletsOf((await tolu.call("GET", "/accounts")).data);
if (!mine.personal) throw new Error("Tolu has no personal wallet.");
console.log(`  wallets: personal ${mine.personal.account_number} (${mine.personal.currency_code})` + (mine.business ? `, business ${mine.business.account_number} (${mine.business.currency_code})` : ""));

const chidi = await person("seed_chidi", "Chidi", "Okeke", [["personal", "NGN"]]);
const amaka = await person("seed_amaka", "Amaka", "Eze", [["personal", "NGN"]]);
const bayo = await person("seed_bayo", "Bayo", "Adewale", [["personal", "NGN"], ["business", "USD"]]);
for (const p of [chidi, amaka, bayo]) await topUp(p, p.personal, naira(2_000_000));
if (bayo.business) await topUp(bayo, bayo.business, dollars(5_000));
console.log("  counterparties ready: Chidi Okeke, Amaka Eze, Bayo Adewale");

// money in and out
await topUp(tolu, mine.personal, naira(250_000));
await send(chidi, chidi.personal, mine.personal, naira(85_000), "Logo design, thank you!");
await send(amaka, amaka.personal, mine.personal, naira(42_500), "My half of the Lagos trip");
await send(bayo, bayo.personal, mine.personal, naira(120_000), "Product photos for the launch");
await send(tolu, mine.personal, amaka.personal, naira(15_000), "Lunch at Bukka Hut");
await send(tolu, mine.personal, chidi.personal, naira(60_000), "Rent share, October");
await send(tolu, mine.personal, bayo.personal, naira(8_500), "Data bundle");
await send(tolu, mine.personal, amaka.personal, naira(25_000), "Birthday gift for Ify");
let usdNote = "";
if (mine.business?.currency_code === "USD" && bayo.business) {
  await send(bayo, bayo.business, mine.business, dollars(350), "Consulting call, product roadmap");
  await send(tolu, mine.business, bayo.business, dollars(40), "Figma seat, October");
  usdNote = ", $350 in and $40 out on the business wallet";
}
console.log(`  transactions: a ₦250,000 top-up, 3 payments in, 4 out${usdNote}`);

// clients (reused by name if Tolu already has them)
const clientBook = (await tolu.call("GET", "/clients?include_archived=false")).data;
async function client(name, email) {
  const found = clientBook.find((c) => c.name === name);
  if (found) return found;
  try {
    return await tolu.call("POST", "/clients", email ? { name, email } : { name });
  } catch (err) {
    if (err.status !== 409) throw err;
    return tolu.call("POST", "/clients", { name });
  }
}
const northwind = await client("Northwind Studio", "accounts@northwind.example");
const bloom = await client("Bloom Bakery");
const hub = await client("Lagos Tech Hub", "finance@lagostechhub.example");
const acme = await client("Acme Global", "ap@acme.example");
console.log("  clients: Northwind Studio, Bloom Bakery, Lagos Tech Hub, Acme Global");

// one-off invoices: paid, open, overdue
const invoice = (c, description, amountMinor, dueInDays, wallet = mine.personal) =>
  tolu.call("POST", "/invoices", {
    issuer_account_id: wallet.account_id,
    client_id: c.client_id,
    items: [{ description, quantity: 1, unit_amount_minor: amountMinor }],
    due_date: isoDay(dueInDays),
    send: true,
    send_email: false,
  });
const cakeShoot = await invoice(bloom, "Cake catalogue photoshoot", naira(45_000), 7);
await payLink(amaka, amaka.personal, cakeShoot);
const workshop = await invoice(hub, "Design workshop (2 days)", naira(180_000), 10);
const banner = await invoice(northwind, "Event banner designs", naira(65_000), 7);
await tolu.call("POST", `/dev/invoices/${banner.invoice_id}/backdate`, { days: 5 });
console.log(`  invoices: ${cakeShoot.invoice_number} paid, ${workshop.invoice_number} open, ${banner.invoice_number} 5 days overdue`);

// recurring plans
const plan = (c, description, amountMinor, frequency, startDate, extra = {}) =>
  tolu.call("POST", "/recurring-plans", {
    issuer_account_id: (extra.wallet ?? mine.personal).account_id,
    client_id: c.client_id,
    description,
    amount_minor: amountMinor,
    frequency,
    start_date: startDate,
    days_until_due: extra.terms ?? 14,
    send_email: false,
    ...(extra.notes ? { notes: extra.notes } : {}),
  });

// 1. monthly, started three months ago: catch up its history, two paid
const social = await plan(northwind, "Social media management", naira(75_000), "monthly", isoDay(1), { notes: "Content calendar, posting and monthly report." });
await tolu.call("POST", `/dev/recurring-plans/${social.plan_id}/backdate`, { days: 92 });
await tolu.call("POST", "/dev/recurring/run");
const history = (await tolu.call("GET", `/recurring-plans/${social.plan_id}`)).invoices ?? [];
const oldestFirst = [...history].sort((a, b) => a.recurring_cycle - b.recurring_cycle);
for (const inv of oldestFirst.slice(0, 2)) await payLink(chidi, chidi.personal, inv);

// 2. weekly, starts today: its first invoice goes out now
const newsletter = await plan(hub, "Community newsletter", naira(20_000), "weekly", isoDay(0), { terms: 7 });

// 3. monthly in dollars, from the 1st of next month
const usdWallet = mine.business?.currency_code === "USD" ? mine.business : null;
const maintenance = usdWallet
  ? await plan(acme, "Website maintenance", dollars(250), "monthly", firstOfNextMonth(), { wallet: usdWallet, terms: 30 })
  : await plan(acme, "Website maintenance", naira(150_000), "monthly", firstOfNextMonth(), { terms: 30 });

// 4. quarterly, paused
const menu = await plan(bloom, "Menu photography", naira(90_000), "quarterly", isoDay(3));
await tolu.call("POST", `/recurring-plans/${menu.plan_id}/pause`);

// 5. yearly, starts in three weeks
const hosting = usdWallet
  ? await plan(acme, "Domain and hosting", dollars(120), "yearly", isoDay(21), { wallet: usdWallet, terms: 0 })
  : await plan(acme, "Domain and hosting", naira(85_000), "yearly", isoDay(21), { terms: 0 });

// 6. cancelled
const old = await plan(northwind, "Brand refresh retainer", naira(50_000), "monthly", isoDay(5));
await tolu.call("POST", `/recurring-plans/${old.plan_id}/cancel`);

const plans = (await tolu.call("GET", "/recurring-plans")).data.filter((p) => [social, newsletter, maintenance, menu, hosting, old].some((x) => x.plan_id === p.plan_id));
console.log("  recurring plans:");
for (const p of plans) {
  const amount = `${p.currency_code} ${(p.amount_minor / 100).toLocaleString("en-NG")}`;
  console.log(`    - ${p.description} (${p.client.name}): ${amount} ${p.frequency}, ${p.plan_status}, ${p.invoices_generated} invoice(s), next ${p.next_billing_date ?? "—"}`);
}
console.log(`  of the social media plan's ${history.length} invoices, the oldest ${Math.min(2, history.length)} are paid (by Chidi, from his wallet)`);
console.log("Done.");
