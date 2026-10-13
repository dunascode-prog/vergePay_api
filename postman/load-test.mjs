// A read-only load test: N customers at once, each opening the app (sign in,
// then the requests the Home page makes). Nothing is written except the
// sign-ins themselves, and the load-test users on the first run.
//
//   node postman/load-test.mjs                       (against http://localhost:8000)
//   API_URL=https://... LEVELS=10,50 node postman/load-test.mjs
//
// Prints p50 / p95 / p99 latency per request type, throughput and errors.
const API = (process.env.API_URL ?? "http://localhost:8000") + "/v1";
const LEVELS = (process.env.LEVELS ?? "10,25,50,100").split(",").map(Number);
const PASSWORD = "VergePay#Load2026";
const RICH = { email: "tolu.login@vergepay.dev", password: "Signin#Tolu2026" };

const now = () => performance.now();
async function call(method, path, { cookie, body } = {}) {
  const t = now();
  let status = 0;
  let setCookie = [];
  try {
    const res = await fetch(API + path, {
      method,
      headers: { "content-type": "application/json", ...(cookie && { cookie }) },
      body: body && JSON.stringify(body),
    });
    status = res.status;
    setCookie = res.headers.getSetCookie?.() ?? [];
    await res.arrayBuffer();
  } catch {
    status = 0; // network error / refused
  }
  return { ms: now() - t, status, cookie: setCookie.map((c) => c.split(";")[0]).join("; ") };
}

// the requests the Home page makes after sign-in
const SESSION = [
  ["profile", "GET", "/users/me"],
  ["wallets", "GET", "/accounts"],
  ["invoices", "GET", "/invoices?role=issued&limit=50"],
  ["notifications", "GET", "/notifications?limit=20"],
  ["recommendations", "GET", "/recommendations?limit=4"],
];

async function ensureUsers(n) {
  const users = [];
  for (let i = 0; i < n; i++) users.push({ email: `loadtest_${i}@vergepay.dev`, password: PASSWORD, username: `loadtest_${i}` });
  // create any that don't exist yet, a few at a time (bcrypt is slow on purpose)
  for (let i = 0; i < users.length; i += 10) {
    await Promise.all(
      users.slice(i, i + 10).map((u) => call("POST", "/auth/signup", { body: { username: u.username, email: u.email, password: u.password, confirmPassword: u.password } })),
    );
  }
  return users;
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function runLevel(label, accounts) {
  const samples = new Map(); // name → [ms]
  let errors = 0;
  let requests = 0;
  const add = (name, r) => {
    requests++;
    if (r.status === 0 || r.status >= 500 || r.status === 429) errors++;
    if (!samples.has(name)) samples.set(name, []);
    samples.get(name).push(r.ms);
  };
  const started = now();
  await Promise.all(
    accounts.map(async (u) => {
      // already signed in (scenario B), or sign in first
      const signin = u.cookie ? { status: 200, cookie: u.cookie } : await call("POST", "/auth/signin", { body: { email: u.email, password: u.password } });
      if (!u.cookie) add("sign-in", signin);
      if (signin.status !== 200) return;
      for (const [name, method, path] of SESSION) add(name, await call(method, path, { cookie: signin.cookie }));
    }),
  );
  const wall = now() - started;
  const all = [...samples.values()].flat().sort((a, b) => a - b);
  console.log(`\n${label}: ${accounts.length} users at once, ${requests} requests in ${(wall / 1000).toFixed(1)} s (${(requests / (wall / 1000)).toFixed(1)} req/s), errors ${errors}`);
  console.log(`  ${"request".padEnd(16)} ${"p50".padStart(7)} ${"p95".padStart(7)} ${"p99".padStart(7)}  (ms)`);
  for (const [name, list] of samples) {
    const s = list.sort((a, b) => a - b);
    console.log(`  ${name.padEnd(16)} ${pct(s, 50).toFixed(0).padStart(7)} ${pct(s, 95).toFixed(0).padStart(7)} ${pct(s, 99).toFixed(0).padStart(7)}`);
  }
  console.log(`  ${"all".padEnd(16)} ${pct(all, 50).toFixed(0).padStart(7)} ${pct(all, 95).toFixed(0).padStart(7)} ${pct(all, 99).toFixed(0).padStart(7)}`);
  return { users: accounts.length, requests, errors, wallMs: wall, p50: pct(all, 50), p95: pct(all, 95), p99: pct(all, 99) };
}

const max = Math.max(...LEVELS);
console.log(`API ${API}; preparing ${max} load-test users…`);
const users = await ensureUsers(max);
// warm-up: one session, so the first level doesn't pay for start-up
await runLevel("warm-up", users.slice(0, 2));

const summary = [];
for (const n of LEVELS) summary.push(["new customers", await runLevel(`A. new customers`, users.slice(0, n))]);
// B: one signed-in customer with a lot of data (Tolu), N requests at once
// (signing one account in N times at once is refused, as it should be)
const rich = await call("POST", "/auth/signin", { body: RICH });
for (const n of LEVELS) summary.push(["data-heavy customer", await runLevel(`B. data-heavy customer (Tolu), ${n} sessions`, Array.from({ length: n }, () => ({ cookie: rich.cookie })))]);

console.log("\nSUMMARY");
for (const [kind, r] of summary) console.log(`  ${kind.padEnd(20)} ${String(r.users).padStart(4)} users  p50 ${r.p50.toFixed(0).padStart(5)} ms  p95 ${r.p95.toFixed(0).padStart(5)} ms  p99 ${r.p99.toFixed(0).padStart(5)} ms  errors ${r.errors}/${r.requests}`);
