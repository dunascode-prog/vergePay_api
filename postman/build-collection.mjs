// Builds the Postman test suite and its expected results:
//
//   postman/vergepay-api.postman_collection.json      the full suite (run top to bottom)
//   postman/vergepay-flutterwave-live.postman_collection.json
//                                                     the real Flutterwave sandbox, with manual steps
//   postman/EXPECTED_RESULTS.md                       every request, its expected status and checks
//
// Run: npm run postman:build   (edit the requests below, then rebuild)
//
// Every request declares what it expects once (status + named checks) and
// the builder turns that into both the Postman tests and the Markdown, so
// the document can't drift from what the collection actually checks.

import fs from "fs";

// ---------------------------------------------------------------------------
// Request helpers

const JSON_HEADER = { key: "Content-Type", value: "application/json" };

// Runs before every request's own checks.
const PRELUDE = [
  "const j = (() => { try { return pm.response.json(); } catch (e) { return {}; } })();",
  "const v = (k) => pm.collectionVariables.get(k);",
  "const n = (k) => Number(pm.collectionVariables.get(k));",
  'const replayed = pm.response.headers.get("Idempotent-Replayed") === "true";',
  "const errorCode = j.error && j.error.code;",
  "const errorMessage = (j.error && j.error.message) || \"\";",
  // query-string reader: the Postman sandbox has no URL global
  'const qp = (url, key) => { const m = String(url || "").match(new RegExp("[?&]" + key + "=([^&#]*)")); return m ? decodeURIComponent(m[1].replace(/\\+/g, " ")) : null; };',
];

// TOTP (RFC 6238) in the Postman sandbox, so 2FA steps need no phone. (The
// sandbox already defines a global CryptoJS, so the module is bound to
// another name.) It computes the code for the secret in `secretVar`, never
// reusing a time step (the API rejects a reused code). It uses the current
// 30-second window or the next one, never the previous: the server accepts
// one window either side, so a code from the current window is still valid
// if the request crosses into the next window, but one from the previous
// window would not be. When both are used, it waits for the next window.
function totpScript(secretVar = "totpSecret", { advance = true, into = "totpCode" } = {}) {
  return [
    "const cryptoJs = require(\"crypto-js\");",
    `const secret = pm.collectionVariables.get(${JSON.stringify(secretVar)});`,
    "const alphabet = \"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567\";",
    "let bits = \"\";",
    "for (const c of secret.replace(/=+$/, \"\")) bits += alphabet.indexOf(c).toString(2).padStart(5, \"0\");",
    "let keyHex = \"\";",
    "for (let i = 0; i + 8 <= bits.length; i += 8) keyHex += parseInt(bits.substr(i, 8), 2).toString(16).padStart(2, \"0\");",
    "const codeFor = (step) => {",
    "  const h = cryptoJs.HmacSHA1(cryptoJs.enc.Hex.parse(step.toString(16).padStart(16, \"0\")), cryptoJs.enc.Hex.parse(keyHex)).toString();",
    "  const o = parseInt(h.substr(-1), 16);",
    "  return String((parseInt(h.substr(o * 2, 8), 16) & 0x7fffffff) % 1000000).padStart(6, \"0\");",
    "};",
    "const nowStep = () => Math.floor(Date.now() / 30000);",
    "const last = Number(pm.collectionVariables.get(\"totpLastStep\") || -1);",
    `const advance = ${advance};`,
    "const pick = () => advance ? Math.max(nowStep(), last + 1) : nowStep();",
    "const finish = () => {",
    "  const step = pick();",
    `  pm.collectionVariables.set(${JSON.stringify(into)}, codeFor(step));`,
    "  if (advance) pm.collectionVariables.set(\"totpLastStep\", String(step));",
    "};",
    "const wanted = pick();",
    "if (wanted > nowStep() + 1) {",
    "  // every code in the current window is used up: wait for the next one",
    "  setTimeout(finish, (wanted - 1) * 30000 - Date.now() + 1500);",
    "} else finish();",
  ];
}

function buildUrl(base, path) {
  const [pathPart, queryPart] = path.split("?");
  const url = {
    raw: `${base}${path}`,
    host: [base],
    path: pathPart.split("/").filter(Boolean),
  };
  if (queryPart) {
    url.query = queryPart.split("&").map((pair) => {
      const [key, ...rest] = pair.split("=");
      return { key, value: rest.join("=") };
    });
  }
  return url;
}

// Variables named *Amount hold numbers, so they go into the JSON unquoted.
const rawBody = (body) => JSON.stringify(body, null, 2).replace(/"(\{\{\w+Amount\}\})"/g, "$1");

let counter = 0;
const expected = []; // { collection, folder, rows: [...] }

// opts:
//   status       expected HTTP status (always checked)
//   checks       [[label, boolean expression]] run against the response
//   save         [[variable, expression]] saved after the response
//   idem         "new" | "same" | "new:<var>" | "same:<var>"  Idempotency-Key handling
//   internal     true = send X-Internal-Api-Key; "wrong" = send a wrong one
//   totp         true = generate {{totpCode}} first (2FA steps)
//   rawUrl       a whole URL from a variable (e.g. "{{authorizationUrl}}") instead of base + path
//   noRedirect   don't follow redirects, so the redirect itself can be checked
//   body, raw, headers, pre, tests, description, base
function req(name, method, path, opts = {}) {
  const {
    status,
    checks = [],
    save = [],
    idem,
    internal,
    totp,
    body,
    raw,
    headers = [],
    pre = [],
    tests = [],
    description = "",
    base = "{{baseUrl}}",
    rawUrl,
    noRedirect,
  } = opts;
  if (status === undefined) throw new Error(`${name}: every request needs an expected status`);

  const preScript = [...pre];
  const header = [...(body || raw ? [JSON_HEADER] : []), ...headers];
  if (idem) {
    const [mode, variable = "idempotencyKey"] = idem.split(":");
    if (mode === "new") preScript.unshift(`pm.collectionVariables.set(${JSON.stringify(variable)}, pm.variables.replaceIn("{{$guid}}"));`);
    header.push({ key: "Idempotency-Key", value: `{{${variable}}}` });
  }
  if (internal) {
    header.push({ key: "X-Internal-Api-Key", value: internal === "wrong" ? "wrong-key" : "{{internalApiKey}}" });
  }
  if (totp) preScript.push(...totpScript());

  const statusList = Array.isArray(status) ? status : [status];
  const testScript = [
    ...PRELUDE,
    statusList.length === 1
      ? `pm.test("status is ${statusList[0]}", () => pm.response.to.have.status(${statusList[0]}));`
      : `pm.test("status is one of ${statusList.join("/")}", () => pm.expect(${JSON.stringify(statusList)}).to.include(pm.response.code));`,
    ...checks.map(([label, expr]) => `pm.test(${JSON.stringify(label)}, () => pm.expect(${expr}, ${JSON.stringify(label)}).to.be.true);`),
    ...save.map(([variable, expr]) => `try { pm.collectionVariables.set(${JSON.stringify(variable)}, ${expr}); } catch (e) {}`),
    ...tests,
  ];

  const request = { method, header, url: rawUrl ?? buildUrl(base, path) };
  const bodyText = raw ?? (body !== undefined ? rawBody(body) : undefined);
  if (bodyText !== undefined) request.body = { mode: "raw", raw: bodyText, options: { raw: { language: "json" } } };

  counter += 1;
  const checkLabels = [...checks.map(([label]) => label), ...(opts.extraCheckLabels ?? [])];
  const expectText = `**Expect:** ${statusList.join(" or ")}${checkLabels.length ? `\n\n**Checks:**\n${checkLabels.map((c) => `- ${c}`).join("\n")}` : ""}`;
  request.description = [description, expectText].filter(Boolean).join("\n\n");

  const item = { name, event: [], request };
  if (noRedirect) item.protocolProfileBehavior = { followRedirects: false };
  if (preScript.length) item.event.push({ listen: "prerequest", script: { type: "text/javascript", exec: preScript } });
  item.event.push({ listen: "test", script: { type: "text/javascript", exec: testScript } });
  item._doc = { name, method, path: rawUrl ?? path, status: statusList.join(" / "), checks: checkLabels, description };
  return item;
}

// A call to the Flutterwave stand-in's test controls (not the API).
const standIn = (name, path, body, opts = {}) =>
  req(name, "POST", path, { base: "{{standInUrl}}", body, status: 200, ...opts });

// Several requests at once, to prove the API's row locks. Fired from a test
// script with pm.sendRequest, which shares the session cookie jar. The probe
// is the request that carries that script: by default a harmless GET that
// needs a session; override it where there may be no session yet.
function concurrently(name, { count, method, path, bodyExpr, headersExpr = "{}", expectExpr, label, description, probe = { method: "GET", path: "/users/me" } }) {
  return req(name, probe.method, probe.path, {
    body: probe.body,
    status: 200,
    description: `${description}\n\nThe request itself is a harmless ${probe.method} ${probe.path}; its test script fires ${count} ${method} ${path} requests at the same moment and counts the outcomes.`,
    extraCheckLabels: [label],
    tests: [
      `const url = pm.variables.replaceIn(${JSON.stringify(`{{baseUrl}}${path}`)});`,
      "const codes = [];",
      `for (let i = 0; i < ${count}; i++) {`,
      "  pm.sendRequest({",
      `    url, method: ${JSON.stringify(method)},`,
      `    header: Object.assign({ "Content-Type": "application/json", "Idempotency-Key": pm.variables.replaceIn("{{$guid}}") }, ${headersExpr}),`,
      `    body: { mode: "raw", raw: JSON.stringify(${bodyExpr}) },`,
      "  }, (err, res) => {",
      "    codes.push(err ? 0 : res.code);",
      `    if (codes.length === ${count}) {`,
      "      codes.sort();",
      "      pm.collectionVariables.set(\"lastConcurrentCodes\", JSON.stringify(codes));",
      `      pm.test(${JSON.stringify(label)} + " (" + codes.join(", ") + ")", () => pm.expect(${expectExpr}).to.be.true);`,
      "    }",
      "  });",
      "}",
    ],
  });
}

const count = (codes, c) => `codes.filter((x) => x === ${c}).length`;

// ---------------------------------------------------------------------------
// Reusable steps

const signIn = (who) =>
  req(`Sign in as ${who === "ada" ? "Ada" : "Tolu"}`, "POST", "/auth/signin", {
    body: { email: `{{${who}Email}}`, password: `{{${who}Password}}` },
    status: 200,
    description: `Switches the session (Postman's cookie jar) to ${who === "ada" ? "ada_login" : "tolu_login"}.`,
    checks: [["session cookies set", 'pm.cookies.has("access_token") && pm.cookies.has("refresh_token")']],
  });

const kycVerify = (note = "") =>
  req("Dev: mark me KYC-verified", "POST", "/dev/kyc/verify", {
    status: 200,
    description: `Development only. Money movement needs kyc_status = verified.${note ? ` ${note}` : ""}`,
    checks: [["verified", 'j.kyc_status === "verified"']],
  });

// A customer has at most one personal and one business wallet, so folders
// that need several accounts use their own fresh users, created each run
// (role_<timestamp>) and signed in with signInAs(role).
const TEST_PASSWORD = "VergePay#Test2026";

const signInAs = (role, label = role) =>
  req(`Sign in as ${label}`, "POST", "/auth/signin", {
    body: { email: `{{${role}Username}}@vergepay.dev`, password: TEST_PASSWORD },
    status: 200,
    description: `Switches the session to this run's ${label} user.`,
    checks: [["session cookies set", 'pm.cookies.has("access_token") && pm.cookies.has("refresh_token")']],
  });

const newUser = (role, label = role) => [
  req(`New user: ${label}`, "POST", "/auth/signup", {
    pre: [`pm.collectionVariables.set("${role}Username", "${role}_" + Date.now());`],
    body: {
      username: `{{${role}Username}}`,
      email: `{{${role}Username}}@vergepay.dev`,
      password: TEST_PASSWORD,
      confirmPassword: TEST_PASSWORD,
    },
    status: 201,
    description: `A fresh user for this run, so the ${label} steps start with no wallets.`,
  }),
  signInAs(role, label),
];

const openAccount = (name, variable, { purpose = "personal", currency = "NGN", saveNumber } = {}) =>
  req(name, "POST", "/accounts", {
    idem: "new",
    body: { account_type: "current", currency_code: currency, purpose },
    status: 201,
    save: [[variable, "j.account_id"], ...(saveNumber ? [[saveNumber, "j.account_number"]] : [])],
  });

const balanceIs = (name, accountVar, expr, label) =>
  req(name, "GET", `/accounts/{{${accountVar}}}`, {
    status: 200,
    checks: [[label ?? `balance is ${expr}`, `j.balance_minor === ${expr}`]],
  });

const forgetKey = (keyVar = "idempotencyKey", scope = "") =>
  req("Dev: forget the stored response (simulate a crash)", "DELETE", `/dev/idempotency-keys/{{${keyVar}}}${scope ? `?scope=${scope}` : ""}`, {
    status: 200,
    description:
      "Development only. Deletes the idempotency record for the last key, as if the server crashed after committing the money but before saving its reply. The next retry must still be answered from what was committed, without moving money again.",
    checks: [["a stored response was forgotten", "j.deleted === 1"]],
  });

const enableTwoFactor = () => [
  req("2FA: start setup", "POST", "/auth/2fa/enable", {
    status: 200,
    save: [["totpSecret", "j.secret"], ["totpLastStep", '""']],
    checks: [["returns a base32 secret and otpauth URI", '/^[A-Z2-7]{32}$/.test(j.secret) && j.otpauth_uri.startsWith("otpauth://totp/")']],
  }),
  req("2FA: confirm a code (Postman computes it)", "POST", "/auth/2fa/verify", {
    totp: true,
    body: { code: "{{totpCode}}" },
    status: 200,
    checks: [["2FA confirmed", "j.two_factor_enabled === true"]],
  }),
];

const reverify = (why) =>
  req("2FA: confirm a fresh code", "POST", "/auth/2fa/verify", {
    totp: true,
    body: { code: "{{totpCode}}" },
    status: 200,
    description: why,
    checks: [["confirmed", "j.two_factor_enabled === true"]],
  });

const dropTwoFactorStamp = () =>
  req("Refresh the session (drops the recent-2FA stamp)", "POST", "/auth/refresh", {
    status: 200,
    description: "A refreshed session is a full session but carries no tfa_at, so \"User + 2FA\" actions are refused until a new code is confirmed.",
  });

const invariants = () =>
  req("Dev: ledger invariants all hold", "GET", "/dev/invariants", {
    status: 200,
    description:
      "Development only. Checks the whole database: every transaction's debits equal its credits, every cached balance equals its ledger, loans, schedules, invoices and refunds match their transactions, and processor money only has ledger rows once settled.",
    checks: [["every invariant count is 0", "j.ok === true"]],
    tests: ['if (!j.ok) console.log("invariant counts", JSON.stringify(j.checks));'],
  });

// ---------------------------------------------------------------------------
// 0. Setup

const setup = [
  signIn("ada"),
  req("Dev: reset Ada", "POST", "/dev/test-user/reset", {
    body: { kyc: true, two_factor: true, pending_loan_applications: true, name: true },
    status: 200,
    description: "Development only. Puts ada_login back to a known state (unverified, 2FA off, no name, no pending loan application) and clears her rate-limit counters, so the suite can run again at once.",
    checks: [["back to unverified with 2FA off", 'j.kyc_status === "unverified" && j.two_factor_enabled === false']],
  }),
  signIn("tolu"),
  req("Dev: reset Tolu", "POST", "/dev/test-user/reset", {
    body: { kyc: true, two_factor: true, pending_loan_applications: true },
    status: 200,
    description: "Same for tolu_login. Folder 2 edits Tolu's name, which KYC locks, so Tolu must start unverified.",
    checks: [["unverified", 'j.kyc_status === "unverified"']],
  }),
];

// ---------------------------------------------------------------------------
// 1. Auth (as Tolu)

const auth = [
  req("Sign up (random new user)", "POST", "/auth/signup", {
    pre: ['pm.collectionVariables.set("signupUsername", "qa_" + Date.now());'],
    body: {
      username: "{{signupUsername}}",
      email: "{{signupUsername}}@vergepay.dev",
      password: "VergePay#Test2026",
      confirmPassword: "VergePay#Test2026",
    },
    status: 201,
    description: "Creates an account only. Signing up doesn't sign you in: it clears any session cookies the browser had (they come back empty, expired in 1970).",
    checks: [["no live session cookie is set", '!pm.response.headers.all().some((h) => h.key.toLowerCase() === "set-cookie" && /^(access|refresh)_token=[^;]/.test(h.value))']],
  }),
  req("Sign up - weak password", "POST", "/auth/signup", {
    body: { username: "weak_pw_user", email: "weak@vergepay.dev", password: "password123", confirmPassword: "password123" },
    status: 422,
  }),
  concurrently("Concurrent: sign in twice at the same moment", {
    count: 2,
    method: "POST",
    path: "/auth/signin",
    bodyExpr: '{ email: pm.collectionVariables.get("toluEmail"), password: pm.collectionVariables.get("toluPassword") }',
    expectExpr: "codes.every((c) => c === 200)",
    label: "both succeed (two sessions issued in the same second never collide)",
    // signing up just cleared the session, so the probe is a sign-in itself
    probe: { method: "POST", path: "/auth/signin", body: { email: "{{toluEmail}}", password: "{{toluPassword}}" } },
    description: "Regression check: session tokens used to be identical when issued for the same user in the same second, so the second sign-in failed with a 500. Each token now carries a random id.",
  }),
  req("Sign in (Tolu)", "POST", "/auth/signin", {
    body: { email: "{{toluEmail}}", password: "{{toluPassword}}" },
    status: 200,
    checks: [
      ["session cookies set", 'pm.cookies.has("access_token") && pm.cookies.has("refresh_token")'],
      ["no 2FA challenge", "j.two_factor_required === false"],
    ],
    save: [["oldRefreshToken", 'pm.cookies.get("refresh_token")']],
  }),
  req("Sign in - body isn't valid JSON", "POST", "/auth/signin", {
    raw: "{not json",
    status: 400,
    description: "A malformed body is the client's mistake: 400, never 500, and no internal parser message in the response.",
    checks: [["bad request, no leaked details", 'errorCode === "BAD_REQUEST" && !("message" in j)']],
  }),
  req("Sign in - wrong password", "POST", "/auth/signin", {
    body: { email: "{{toluEmail}}", password: "Wrong#Password1" },
    status: 401,
  }),
  req("Refresh session", "POST", "/auth/refresh", {
    status: 200,
    checks: [["new refresh token issued", 'pm.cookies.get("refresh_token") !== v("oldRefreshToken")']],
  }),
  req("Refresh - reuse the old token", "POST", "/auth/refresh", {
    headers: [{ key: "Cookie", value: "refresh_token={{oldRefreshToken}}" }],
    status: 401,
    description: "Sends the refresh token from before 'Refresh session'. Each refresh token works once, so this must fail.",
  }),
];

// ---------------------------------------------------------------------------
// 2. Profile (as Tolu)

const profile = [
  req("Get my profile", "GET", "/users/me", {
    status: 200,
    checks: [["returns own email", 'j.email === v("toluEmail")']],
  }),
  req("Update my profile", "PATCH", "/users/me", {
    body: {
      first_name: "Tolu",
      last_name: "Adeyemi",
      date_of_birth: "2000-05-14",
      present_address: "12 Admiralty Way, Lekki",
      permanent_address: "12 Admiralty Way, Lekki",
      city: "Lagos",
      postal_code: "106104",
      country_code: "NG",
      default_currency_code: "NGN",
      timezone: "Africa/Lagos",
    },
    status: 200,
    checks: [["name saved", 'j.first_name === "Tolu"']],
  }),
  req("Update - email isn't editable here", "PATCH", "/users/me", {
    body: { email: "new@vergepay.dev" },
    status: 422,
    checks: [["email flagged", "Boolean(j.error.details.email)"]],
  }),
  req("Update - under 18", "PATCH", "/users/me", { body: { date_of_birth: "2015-01-01" }, status: 422 }),
  req("2FA: verify before setup", "POST", "/auth/2fa/verify", { body: { code: "123456" }, status: 409 }),
  req("2FA: disable without a recent code", "DELETE", "/auth/2fa", {
    status: 403,
    checks: [["asks for 2FA", 'errorCode === "TWO_FACTOR_REQUIRED"']],
  }),
];

// ---------------------------------------------------------------------------
// 3. Accounts (a fresh account holder: one personal and one business wallet at most)

const accounts = [
  ...newUser("holder", "account holder"),
  req("List my accounts (none yet)", "GET", "/accounts", { status: 200, checks: [["a new user has no wallets", "Array.isArray(j.data) && j.data.length === 0"]] }),
  req("Open my personal wallet", "POST", "/accounts", {
    idem: "new",
    body: { account_type: "current", currency_code: "NGN" },
    status: 201,
    description: "Generates a fresh Idempotency-Key and saves the new account's id. purpose defaults to personal.",
    save: [["accountId", "j.account_id"]],
    checks: [
      ["10-digit account number", "/^\\d{10}$/.test(j.account_number)"],
      ["starts with zero balance", "j.balance_minor === 0"],
      ["purpose defaults to personal", 'j.purpose === "personal"'],
    ],
  }),
  req("Open account - replay same key (no duplicate)", "POST", "/accounts", {
    idem: "same",
    body: { account_type: "current", currency_code: "NGN" },
    status: 201,
    description: "Re-sends the same key and body. The original response comes back; no second account is created.",
    checks: [
      ["same account returned", 'j.account_id === v("accountId")'],
      ["marked as a replay", "replayed"],
    ],
  }),
  req("Open account - same key, different body", "POST", "/accounts", {
    idem: "same",
    body: { account_type: "current", currency_code: "USD" },
    status: 422,
    checks: [["key conflict", 'errorCode === "IDEMPOTENCY_KEY_CONFLICT"']],
  }),
  req("Open account - missing key", "POST", "/accounts", { body: { account_type: "current", currency_code: "NGN" }, status: 400 }),
  req("Open a second personal wallet", "POST", "/accounts", {
    idem: "new",
    body: { account_type: "current", currency_code: "USD", purpose: "personal" },
    status: 409,
    description: "A customer has one personal and one business wallet at most.",
    checks: [["already has one", 'errorCode === "CONFLICT" && j.error.field === "purpose"']],
  }),
  req("Open account - savings isn't user-openable", "POST", "/accounts", {
    idem: "new",
    body: { account_type: "savings", currency_code: "NGN", purpose: "business" },
    status: 422,
    checks: [["account_type flagged", "Boolean(j.error.details.account_type)"]],
  }),
  req("Open account - investment_wallet isn't user-openable", "POST", "/accounts", {
    idem: "new",
    body: { account_type: "investment_wallet", currency_code: "USD", purpose: "business" },
    status: 422,
    description: "Investment wallets are opened for the customer when they link a brokerage (folder 10).",
    checks: [["account_type flagged", "Boolean(j.error.details.account_type)"]],
  }),
  req("Open account - loan_holding isn't user-openable", "POST", "/accounts", {
    idem: "new",
    body: { account_type: "loan_holding", currency_code: "NGN", purpose: "business" },
    status: 422,
  }),
  req("Open account - currency other than NGN or USD", "POST", "/accounts", {
    idem: "new",
    body: { account_type: "current", currency_code: "GBP", purpose: "business" },
    status: 422,
    checks: [["currency flagged", "Boolean(j.error.details.currency_code)"]],
  }),
  req("Open account - unknown purpose", "POST", "/accounts", {
    idem: "new",
    body: { account_type: "current", currency_code: "NGN", purpose: "family" },
    status: 422,
    checks: [["purpose flagged", "Boolean(j.error.details.purpose)"]],
  }),
  concurrently("Concurrent: open the business wallet 3 times at once", {
    count: 3,
    method: "POST",
    path: "/accounts",
    bodyExpr: '{ account_type: "current", currency_code: "USD", purpose: "business" }',
    expectExpr: `${count(null, 201)} === 1 && ${count(null, 409)} === 2`,
    label: "exactly one business wallet is opened",
    description: "Three taps at once, each with its own Idempotency-Key. Account opening locks the user's row, so the first opens the wallet and the other two see it and get 409.",
  }),
  req("List accounts - business only", "GET", "/accounts?purpose=business", {
    status: 200,
    save: [["businessAccountId", "j.data[0] && j.data[0].account_id"]],
    checks: [
      ["exactly one business wallet, in USD", 'j.data.length === 1 && j.data[0].purpose === "business" && j.data[0].currency_code === "USD"'],
    ],
  }),
  req("List accounts - unknown purpose filter", "GET", "/accounts?purpose=family", { status: 422 }),
  req("List my accounts (two wallets)", "GET", "/accounts", {
    status: 200,
    checks: [["one personal, one business", 'j.data.length === 2 && j.data.some((a) => a.purpose === "personal") && j.data.some((a) => a.purpose === "business")']],
  }),
  req("Update - purpose isn't editable", "PATCH", "/accounts/{{businessAccountId}}", {
    body: { purpose: "personal" },
    status: 422,
    description: "A wallet's purpose is fixed once it's opened.",
    checks: [["purpose flagged", "Boolean(j.error.details.purpose)"]],
  }),
  req("Get account", "GET", "/accounts/{{accountId}}", {
    status: 200,
    checks: [["matches", 'j.account_id === v("accountId")']],
  }),
  req("Update declared income", "PATCH", "/accounts/{{accountId}}", {
    body: { income_minor: 45000000 },
    status: 200,
    checks: [["saved", "j.income_minor === 45000000"]],
  }),
  req("Update - balance isn't editable", "PATCH", "/accounts/{{accountId}}", {
    body: { balance_minor: 999999999 },
    status: 422,
    checks: [["balance_minor flagged", "Boolean(j.error.details.balance_minor)"]],
  }),
  req("Freeze", "POST", "/accounts/{{accountId}}/freeze", { status: 200, checks: [["frozen", 'j.account_status === "frozen"']] }),
  req("Freeze again", "POST", "/accounts/{{accountId}}/freeze", { status: 409 }),
  req("Unfreeze", "POST", "/accounts/{{accountId}}/unfreeze", { status: 200, checks: [["active", 'j.account_status === "active"']] }),
  req("Close", "POST", "/accounts/{{accountId}}/close", { status: 200, checks: [["closed", 'j.account_status === "closed"']] }),
  req("Reopen a closed account", "POST", "/accounts/{{accountId}}/unfreeze", { status: 409 }),
  req("Open a new personal wallet after closing the old one", "POST", "/accounts", {
    idem: "new",
    body: { account_type: "current", currency_code: "NGN", purpose: "personal" },
    status: 201,
    description: "A closed wallet doesn't count, so its slot is free again.",
    checks: [["a different account", 'j.account_id !== v("accountId")']],
  }),
  req("Someone else's / unknown account", "GET", "/accounts/00000000-0000-4000-8000-000000000000", {
    status: 404,
    description: "Ownership mismatches are reported as 404, never 403, so account ids can't be probed.",
  }),
];

// ---------------------------------------------------------------------------
// 4. Transactions (a fresh sender: personal wallet → business wallet)

const transferBody = {
  sender_account_id: "{{senderAccountId}}",
  receiver_account_number: "{{receiverAccountNumber}}",
  amount_minor: 30000,
  currency_code: "NGN",
  description: "August rent contribution",
};

const transactions = [
  ...newUser("sender"),
  kycVerify(),
  openAccount("Open sender account (personal wallet)", "senderAccountId"),
  openAccount("Open receiver account (business wallet)", "receiverAccountId", { purpose: "business", saveNumber: "receiverAccountNumber" }),
  req("Dev: fund sender with 100,000", "POST", "/dev/accounts/{{senderAccountId}}/fund", {
    idem: "new",
    body: { amount_minor: 100000 },
    status: 201,
    description: "Development only. Posts a real ledger transaction from the platform funding account.",
    checks: [["settled", 'j.status === "settled"']],
  }),
  req("Transfer 30,000 by account number", "POST", "/transactions", {
    idem: "new:transferKey",
    body: transferBody,
    status: 201,
    save: [["transactionId", "j.transaction_id"]],
    checks: [
      ["settled immediately", 'j.status === "settled"'],
      ["amount in minor units", "j.amount_minor === 30000"],
    ],
  }),
  req("Transfer - replay same key (no double charge)", "POST", "/transactions", {
    idem: "same:transferKey",
    body: transferBody,
    status: 201,
    checks: [["same transaction returned", 'j.transaction_id === v("transactionId") && replayed']],
  }),
  forgetKey("transferKey"),
  req("Transfer - retry after the lost record (still no double charge)", "POST", "/transactions", {
    idem: "same:transferKey",
    body: transferBody,
    status: 201,
    description: "The idempotency record is gone, so this reaches the ledger. The unique transaction key finds the committed transfer and replays it.",
    checks: [["same transaction replayed from the ledger", 'j.transaction_id === v("transactionId") && replayed']],
  }),
  req("Transfer - same key, different amount", "POST", "/transactions", {
    idem: "same:transferKey",
    body: { ...transferBody, amount_minor: 1 },
    status: 422,
    checks: [["key conflict", 'errorCode === "IDEMPOTENCY_KEY_CONFLICT"']],
  }),
  req("Transfer - insufficient funds", "POST", "/transactions", {
    idem: "new",
    body: { ...transferBody, amount_minor: 100000000 },
    status: 422,
    checks: [["insufficient funds", 'errorCode === "INSUFFICIENT_FUNDS"']],
  }),
  req("Transfer - unknown account number", "POST", "/transactions", {
    idem: "new",
    body: { ...transferBody, receiver_account_number: "0000000000" },
    status: 422,
  }),
  req("Transfer - to the same account", "POST", "/transactions", {
    idem: "new",
    body: { sender_account_id: "{{senderAccountId}}", receiver_account_id: "{{senderAccountId}}", amount_minor: 100, currency_code: "NGN" },
    status: 422,
  }),
  req("Transfer - missing key", "POST", "/transactions", { body: transferBody, status: 400 }),
  balanceIs("Sender balance is 70,000 (charged once)", "senderAccountId", "70000"),
  req("Get transaction with ledger entries", "GET", "/transactions/{{transactionId}}", {
    status: 200,
    checks: [
      ["one debit and one credit", 'JSON.stringify(j.ledger_entries.map((e) => e.direction)) === JSON.stringify(["DEBIT", "CREDIT"])'],
      ["they balance", "j.ledger_entries[0].amount_minor === j.ledger_entries[1].amount_minor"],
    ],
  }),
  req("Sender history", "GET", "/accounts/{{senderAccountId}}/transactions?limit=20", {
    status: 200,
    checks: [
      ["latest entry is the debit", 'j.data[0].direction === "debit"'],
      ["has pagination fields", '"next_cursor" in j && "has_more" in j'],
    ],
  }),
  req("Sender history - page size 1", "GET", "/accounts/{{senderAccountId}}/transactions?limit=1", {
    status: 200,
    save: [["nextCursor", "j.next_cursor"]],
    checks: [["more pages available", "j.has_more === true"]],
  }),
  req("Sender history - next page", "GET", "/accounts/{{senderAccountId}}/transactions?limit=1&after={{nextCursor}}", {
    status: 200,
    checks: [["second row is the top-up credit", 'j.data[0].direction === "credit"']],
  }),
  req("History - bad cursor", "GET", "/accounts/{{senderAccountId}}/transactions?after=garbage", { status: 400 }),
  req("Sender balance history", "GET", "/accounts/{{senderAccountId}}/balance-history?interval=day", {
    status: 200,
    checks: [["ends at the current balance", "j.data[j.data.length - 1].closing_balance_minor === 70000"]],
  }),
  req("Reverse transfer (as receiver)", "POST", "/transactions/{{transactionId}}/reverse", {
    idem: "new",
    status: 201,
    description: "Only the receiving side can reverse. Both accounts belong to this user here, so it's allowed.",
    checks: [["links to original", 'j.original_transaction_id === v("transactionId")']],
  }),
  req("Reverse again", "POST", "/transactions/{{transactionId}}/reverse", { idem: "new", status: 409 }),
  balanceIs("Sender balance is back to 100,000", "senderAccountId", "100000"),
  invariants(),
];

// ---------------------------------------------------------------------------
// 5. Loans (a fresh borrower; the back office uses the internal key)

const loanApplication = {
  account_id: "{{loanAccountId}}",
  loan_type: "personal",
  requested_amount_minor: 1500000,
  currency_code: "NGN",
  term_months: 3,
  purpose: "Laptop for freelance work",
};

const loans = [
  ...newUser("borrower"),
  kycVerify(),
  openAccount("Open loan account (personal wallet)", "loanAccountId"),
  openAccount("Open the repaying account (business wallet)", "receiverAccountId", { purpose: "business" }),
  req("Apply - term of 0 months", "POST", "/loans/applications", { body: { ...loanApplication, term_months: 0 }, status: 422 }),
  req("Apply - currency doesn't match the account", "POST", "/loans/applications", { body: { ...loanApplication, currency_code: "USD" }, status: 422 }),
  req("Apply - unknown account", "POST", "/loans/applications", {
    body: { ...loanApplication, account_id: "00000000-0000-4000-8000-000000000000" },
    status: 422,
  }),
  req("Apply for a loan", "POST", "/loans/applications", {
    idem: "new:applyKey",
    body: loanApplication,
    status: 202,
    description: "202: accepted for review, not decided. The Idempotency-Key is optional here.",
    save: [["applicationId", "j.application_id"]],
    checks: [["pending review", 'j.status === "pending_review"']],
  }),
  req("Apply - replay same key", "POST", "/loans/applications", {
    idem: "same:applyKey",
    body: loanApplication,
    status: 202,
    checks: [["same application", 'j.application_id === v("applicationId") && replayed']],
  }),
  req("Apply again while one is pending", "POST", "/loans/applications", { body: loanApplication, status: 409 }),
  req("Get application status", "GET", "/loans/applications/{{applicationId}}", {
    status: 200,
    checks: [["pending, no loan yet", 'j.status === "pending_review" && j.loan_id === null']],
  }),
  req("Get an unknown application", "GET", "/loans/applications/00000000-0000-4000-8000-000000000000", { status: 404 }),
  req("Admin: queue without a key", "GET", "/admin/loans/applications", { status: 401 }),
  req("Admin: queue with a wrong key", "GET", "/admin/loans/applications", { internal: "wrong", status: 401 }),
  req("Admin: approve as a customer (no key)", "POST", "/loans/applications/{{applicationId}}/approve", {
    body: { interest_rate_bps: 1800 },
    status: 401,
  }),
  req("Admin: underwriting queue", "GET", "/admin/loans/applications?status=pending_review", {
    internal: true,
    status: 200,
    checks: [["lists the application with underwriting data", 'j.data.some((a) => a.application_id === v("applicationId") && a.applicant.kyc_status === "verified" && a.existing_loans && "declared_income_minor" in a.account)']],
  }),
  req("Admin: approve more than requested", "POST", "/loans/applications/{{applicationId}}/approve", {
    internal: true,
    body: { interest_rate_bps: 1800, approved_amount_minor: 9000000 },
    status: 422,
  }),
  req("Admin: approve at 18%", "POST", "/loans/applications/{{applicationId}}/approve", {
    internal: true,
    body: { interest_rate_bps: 1800 },
    status: 201,
    save: [["loanId", "j.loan_id"]],
    checks: [["approved, not paid out", 'j.loan_status === "approved" && j.monthly_installment_minor > 0']],
  }),
  req("Admin: approve twice", "POST", "/loans/applications/{{applicationId}}/approve", { internal: true, body: { interest_rate_bps: 1800 }, status: 409 }),
  req("Application now links the loan", "GET", "/loans/applications/{{applicationId}}", {
    status: 200,
    checks: [["approved with loan_id", 'j.status === "approved" && j.loan_id === v("loanId")']],
  }),
  req("Get loan (approved, owes 0)", "GET", "/loans/{{loanId}}", {
    status: 200,
    checks: [["nothing owed, nothing due", "j.balance_remaining_minor === 0 && j.next_installment === null"]],
  }),
  req("Schedule is empty before payout", "GET", "/loans/{{loanId}}/schedule", { status: 200, checks: [["no rows", "j.data.length === 0"]] }),
  req("Repay before payout", "POST", "/loans/{{loanId}}/repayments", {
    idem: "new",
    body: { source_account_id: "{{senderAccountId}}", amount_minor: 1000 },
    status: 409,
  }),
  req("Admin: disburse without a key", "POST", "/loans/{{loanId}}/disburse", { internal: true, status: 400 }),
  req("Admin: disburse", "POST", "/loans/{{loanId}}/disburse", {
    internal: true,
    idem: "new:disburseKey",
    status: 201,
    save: [["disbursementId", "j.transaction_id"]],
    checks: [["full principal settled", 'j.status === "settled" && j.amount_minor === 1500000']],
  }),
  req("Admin: disburse - replay same key", "POST", "/loans/{{loanId}}/disburse", {
    internal: true,
    idem: "same:disburseKey",
    status: 201,
    checks: [["same transaction", 'j.transaction_id === v("disbursementId") && replayed']],
  }),
  forgetKey("disburseKey", "internal"),
  req("Admin: disburse - retry after the lost record", "POST", "/loans/{{loanId}}/disburse", {
    internal: true,
    idem: "same:disburseKey",
    status: 201,
    checks: [["replayed from the ledger, not paid twice", 'j.transaction_id === v("disbursementId") && replayed']],
  }),
  req("Admin: disburse again, new key", "POST", "/loans/{{loanId}}/disburse", { internal: true, idem: "new", status: 409 }),
  balanceIs("Borrower credited 1,500,000", "loanAccountId", "1500000"),
  req("Disbursement is a loan transaction", "GET", "/transactions/{{disbursementId}}", {
    status: 200,
    checks: [["loan_disbursement with loan_id and 2 entries", 'j.transaction_type === "loan_disbursement" && j.loan_id === v("loanId") && j.ledger_entries.length === 2']],
  }),
  req("Get repayment schedule", "GET", "/loans/{{loanId}}/schedule", {
    status: 200,
    save: [
      ["installment1Amount", "j.data[0].installment_amount_minor"],
      ["installment2Amount", "j.data[1].installment_amount_minor"],
      ["installment3Amount", "j.data[2].installment_amount_minor"],
      ["loanTotal", "j.data.reduce((s, x) => s + x.installment_amount_minor, 0)"],
    ],
    checks: [
      ["3 unpaid installments", "j.data.length === 3 && j.data.every((x) => !x.paid_flag)"],
      ["principal portions add up exactly", "j.data.reduce((s, x) => s + x.principal_minor, 0) === 1500000"],
    ],
  }),
  req("Active loan owes the schedule total", "GET", "/loans/{{loanId}}", {
    status: 200,
    checks: [["active, balance = total, next is #1", 'j.loan_status === "active" && j.balance_remaining_minor === n("loanTotal") && j.next_installment.installment_number === 1']],
  }),
  req("Move the loan money out", "POST", "/transactions", {
    idem: "new",
    body: { sender_account_id: "{{loanAccountId}}", receiver_account_id: "{{receiverAccountId}}", amount_minor: 1500000, currency_code: "NGN" },
    status: 201,
    description: "Empties the loan account, so the next request tests the loan rule rather than the non-zero-balance rule.",
  }),
  req("Dev: add 100,000 to the repaying account (for the interest)", "POST", "/dev/accounts/{{receiverAccountId}}/fund", {
    idem: "new",
    body: { amount_minor: 100000 },
    status: 201,
    description: "The loan repays principal plus 18% interest (about ₦15,452), more than the ₦15,000 principal moved into this account, so it needs a little extra.",
  }),
  req("Close an account with a loan in progress", "POST", "/accounts/{{loanAccountId}}/close", {
    status: 409,
    checks: [["mentions the loan", "/loan/.test(errorMessage)"]],
  }),
  req("Repay - wrong amount", "POST", "/loans/{{loanId}}/repayments", {
    idem: "new",
    body: { source_account_id: "{{receiverAccountId}}", amount_minor: 1000 },
    status: 422,
    checks: [["says what's due", "Boolean(j.error.details.amount_minor)"]],
  }),
  req("Repay - unknown source account", "POST", "/loans/{{loanId}}/repayments", {
    idem: "new",
    body: { source_account_id: "00000000-0000-4000-8000-000000000000", amount_minor: "{{installment1Amount}}" },
    status: 422,
  }),
  req("Repay installment 1", "POST", "/loans/{{loanId}}/repayments", {
    idem: "new:repayKey",
    body: { source_account_id: "{{receiverAccountId}}", amount_minor: "{{installment1Amount}}" },
    status: 201,
    save: [["repay1Body", "JSON.stringify(j)"]],
    checks: [["installment 1 paid, balance lowered", 'j.schedule_installment_marked_paid === 1 && j.new_balance_remaining_minor === n("loanTotal") - n("installment1Amount")']],
  }),
  forgetKey("repayKey"),
  req("Repay - retry after the lost record", "POST", "/loans/{{loanId}}/repayments", {
    idem: "same:repayKey",
    body: { source_account_id: "{{receiverAccountId}}", amount_minor: "{{installment1Amount}}" },
    status: 201,
    checks: [["same result, nothing paid twice", 'replayed && j.transaction_id === JSON.parse(v("repay1Body")).transaction_id && j.schedule_installment_marked_paid === 1']],
  }),
  req("Repay - same key, different source", "POST", "/loans/{{loanId}}/repayments", {
    idem: "same:repayKey",
    body: { source_account_id: "{{loanAccountId}}", amount_minor: "{{installment1Amount}}" },
    status: 422,
  }),
  concurrently("Concurrent: 4 repayments at once (2 installments left)", {
    count: 4,
    method: "POST",
    path: "/loans/{{loanId}}/repayments",
    bodyExpr: '{ source_account_id: pm.collectionVariables.get("receiverAccountId"), amount_minor: Number(pm.collectionVariables.get("installment2Amount")) }',
    expectExpr: `${count(null, 201)} === (pm.collectionVariables.get("installment2Amount") === pm.collectionVariables.get("installment3Amount") ? 2 : 1) && codes.every((c) => [201, 409, 422].includes(c))`,
    label: "the loan row lock lets through only as many as there are matching installments",
    description: "Four clients pay the next installment at the same moment. The loan row is locked, so they queue: the first pays #2, and the next can only succeed if #3 is the same amount. The rest get 409 (repaid) or 422 (wrong amount).",
  }),
  req("Pay whatever is left", "GET", "/loans/{{loanId}}", {
    status: 200,
    description: "If installment 3 differed by a kobo from installment 2, the concurrent round left it unpaid; this pays it.",
    extraCheckLabels: ["last installment paid (here, or already in the concurrent round)"],
    tests: [
      'if (j.loan_status !== "active") pm.test("last installment paid (already in the concurrent round)", () => pm.expect(j.loan_status).to.eql("repaid"));',
      'if (j.loan_status === "active") {',
      "  pm.sendRequest({",
      '    url: pm.variables.replaceIn("{{baseUrl}}/loans/{{loanId}}/repayments"), method: "POST",',
      '    header: { "Content-Type": "application/json", "Idempotency-Key": pm.variables.replaceIn("{{$guid}}") },',
      '    body: { mode: "raw", raw: JSON.stringify({ source_account_id: v("receiverAccountId"), amount_minor: j.next_installment.installment_amount_minor }) },',
      '  }, (err, res) => pm.test("last installment paid", () => pm.expect(res.code).to.eql(201)));',
      "}",
    ],
  }),
  req("Loan is repaid", "GET", "/loans/{{loanId}}", {
    status: 200,
    checks: [["repaid, nothing owed, 3 paid", 'j.loan_status === "repaid" && j.balance_remaining_minor === 0 && j.installments_paid === 3 && j.next_installment === null']],
  }),
  req("Repay a repaid loan", "POST", "/loans/{{loanId}}/repayments", {
    idem: "new",
    body: { source_account_id: "{{receiverAccountId}}", amount_minor: 100 },
    status: 409,
  }),
  req("List my loans", "GET", "/loans", { status: 200, checks: [["includes the loan", 'j.data.some((l) => l.loan_id === v("loanId"))']] }),
  req("Close the loan account now", "POST", "/accounts/{{loanAccountId}}/close", { status: 200, description: "Allowed once the loan is repaid (and the account is empty)." }),
  req("Apply for a second loan", "POST", "/loans/applications", {
    body: { ...loanApplication, account_id: "{{receiverAccountId}}" },
    description: "Into the borrower's other wallet (the first loan's account is closed now).",
    status: 202,
    save: [["applicationId", "j.application_id"]],
  }),
  req("Admin: reject without a reason", "POST", "/loans/applications/{{applicationId}}/reject", { internal: true, body: {}, status: [400, 422] }),
  req("Admin: reject", "POST", "/loans/applications/{{applicationId}}/reject", {
    internal: true,
    body: { reason: "Income not verified" },
    status: 200,
    checks: [["rejected", 'j.status === "rejected"']],
  }),
  req("Rejected application shows the reason", "GET", "/loans/applications/{{applicationId}}", {
    status: 200,
    checks: [["reason, no loan", 'j.status === "rejected" && j.decision_reason === "Income not verified" && j.loan_id === null']],
  }),
  req("Admin: approve a rejected application", "POST", "/loans/applications/{{applicationId}}/approve", { internal: true, body: { interest_rate_bps: 1800 }, status: 409 }),
  invariants(),
];

// ---------------------------------------------------------------------------
// 6. Invoices (fresh users each run: Tolu issues, Ada pays)

const invoiceBase = {
  issuer_account_id: "{{issuerAccountId}}",
  billed_account_number: "{{payerAccountNumber}}",
  amount_due_minor: 250000,
  currency_code: "NGN",
  due_date: "2030-12-31",
  description: "UI design, mobile app",
};
const createInvoice = (name, overrides, opts = {}) =>
  req(name, "POST", "/invoices", { body: { ...invoiceBase, ...overrides }, ...opts });
const payInvoice = (name, invoiceVar, opts = {}) =>
  req(name, "POST", `/invoices/{{${invoiceVar}}}/pay`, { body: { source_account_id: "{{payerAccountId}}" }, ...opts });
const refundInvoice = (name, invoiceVar, opts = {}) =>
  req(name, "POST", `/invoices/{{${invoiceVar}}}/refund`, opts);

const invoices = [
  ...newUser("usdholder", "USD account holder"),
  openAccount("USD holder: open a USD wallet", "payerUsdAccountId", { currency: "USD", saveNumber: "payerUsdAccountNumber" }),
  ...newUser("payer", "payer (Ada)"),
  kycVerify(),
  openAccount("Ada: open payer account (personal wallet)", "payerAccountId", { saveNumber: "payerAccountNumber" }),
  openAccount("Ada: open an empty account (business wallet)", "payerEmptyAccountId", { purpose: "business" }),
  req("Ada: fund payer with 1,000,000", "POST", "/dev/accounts/{{payerAccountId}}/fund", { idem: "new", body: { amount_minor: 1000000 }, status: 201 }),
  ...newUser("issuer", "issuer (Tolu)"),
  kycVerify(),
  openAccount("Tolu: open issuing account (personal wallet)", "issuerAccountId", { saveNumber: "issuerAccountNumber" }),
  openAccount("Tolu: open a second issuing account (business wallet)", "issuerEmptyAccountId", { purpose: "business" }),
  createInvoice("Create - both account_id and a number", { account_id: "{{payerAccountId}}" }, { status: 422 }),
  createInvoice("Create - due date in the past", { due_date: "2020-01-01" }, { status: 422, checks: [["due_date flagged", "Boolean(j.error.details.due_date)"]] }),
  createInvoice("Create - billed account in another currency", { billed_account_number: "{{payerUsdAccountNumber}}" }, { status: 422, checks: [["currency flagged", "Boolean(j.error.details.currency_code)"]] }),
  createInvoice("Create - bill the issuing account itself", { billed_account_number: "{{issuerAccountNumber}}" }, { status: 422 }),
  createInvoice("Create - unknown account number", { billed_account_number: "0000000000" }, { status: 422 }),
  createInvoice("Create - issue from someone else's account", { issuer_account_id: "{{payerAccountId}}" }, { status: 422, checks: [["issuer flagged", "Boolean(j.error.details.issuer_account_id)"]] }),
  createInvoice("Create - zero amount", { amount_due_minor: 0 }, { status: 422 }),
  createInvoice("Create invoice (₦2,500 to Ada)", {}, {
    idem: "new:invoiceKey",
    status: 201,
    save: [["invoiceId", "j.invoice_id"]],
    checks: [["open, issued by me, billed to Ada's account", 'j.invoice_status === "open" && j.direction === "issued" && j.account_id === v("payerAccountId")']],
  }),
  createInvoice("Create - replay same key", {}, { idem: "same:invoiceKey", status: 201, checks: [["same invoice", 'j.invoice_id === v("invoiceId") && replayed']] }),
  createInvoice("Create extra invoice A", { amount_due_minor: 1000 }, { status: 201, save: [["extraA", "j.invoice_id"]] }),
  createInvoice("Create extra invoice B", { amount_due_minor: 1001 }, { status: 201, save: [["extraB", "j.invoice_id"]] }),
  createInvoice("Create extra invoice C", { amount_due_minor: 1002 }, { status: 201, save: [["extraC", "j.invoice_id"]] }),
  req("List my issued invoices", "GET", "/invoices?role=issued&limit=100", { status: 200, checks: [["includes the invoice", 'j.data.some((x) => x.invoice_id === v("invoiceId"))']] }),
  req("List - bad status filter", "GET", "/invoices?status=bogus", { status: 422 }),
  req("List - bad cursor", "GET", "/invoices?after=garbage", { status: 400 }),
  req("Pagination page 1 (newest first)", "GET", "/invoices?role=issued&status=open&limit=1", {
    status: 200,
    save: [["invoiceCursor", "j.next_cursor"]],
    checks: [["newest is C", 'j.data[0].invoice_id === v("extraC") && j.has_more === true']],
  }),
  req("Pagination page 2", "GET", "/invoices?role=issued&status=open&limit=1&after={{invoiceCursor}}", {
    status: 200,
    save: [["invoiceCursor", "j.next_cursor"]],
    checks: [["then B", 'j.data[0].invoice_id === v("extraB")']],
  }),
  req("Pagination page 3", "GET", "/invoices?role=issued&status=open&limit=1&after={{invoiceCursor}}", {
    status: 200,
    save: [["invoiceCursor", "j.next_cursor"]],
    checks: [["then A", 'j.data[0].invoice_id === v("extraA")']],
  }),
  req("Pagination page 4", "GET", "/invoices?role=issued&status=open&limit=1&after={{invoiceCursor}}", {
    status: 200,
    checks: [["then the first invoice", 'j.data[0].invoice_id === v("invoiceId")']],
  }),
  payInvoice("Issuer pays their own invoice", "invoiceId", { idem: "new", body: { source_account_id: "{{issuerEmptyAccountId}}" }, status: 403 }),
  signInAs("payer", "payer (Ada)"),
  req("Ada sees it as received", "GET", "/invoices/{{invoiceId}}", {
    status: 200,
    checks: [["received, from Tolu's account", 'j.direction === "received" && j.issuer_account_number === v("issuerAccountNumber")']],
  }),
  req("Unknown invoice", "GET", "/invoices/00000000-0000-4000-8000-000000000000", { status: 404 }),
  req("Ada's received list includes it", "GET", "/invoices?role=received&limit=100", { status: 200, checks: [["included", 'j.data.some((x) => x.invoice_id === v("invoiceId"))']] }),
  req("Ada's issued list excludes it", "GET", "/invoices?role=issued&limit=100", { status: 200, checks: [["excluded", '!j.data.some((x) => x.invoice_id === v("invoiceId"))']] }),
  payInvoice("Pay - insufficient funds", "invoiceId", { idem: "new", body: { source_account_id: "{{payerEmptyAccountId}}" }, status: 422, checks: [["insufficient funds", 'errorCode === "INSUFFICIENT_FUNDS"']] }),
  payInvoice("Pay - from someone else's account", "invoiceId", { idem: "new", body: { source_account_id: "{{issuerAccountId}}" }, status: 422 }),
  payInvoice("Pay - missing key", "invoiceId", { status: 400 }),
  payInvoice("Pay invoice", "invoiceId", {
    idem: "new:payKey",
    status: 200,
    save: [["settlingTransactionId", "j.settling_transaction_id"]],
    checks: [["paid with a settling transaction", 'j.invoice_status === "paid" && typeof j.settling_transaction_id === "string"']],
  }),
  payInvoice("Pay - replay same key", "invoiceId", { idem: "same:payKey", status: 200, checks: [["same settlement", 'replayed && j.settling_transaction_id === v("settlingTransactionId")']] }),
  forgetKey("payKey"),
  payInvoice("Pay - retry after the lost record", "invoiceId", { idem: "same:payKey", status: 200, checks: [["replayed, not charged twice", 'replayed && j.settling_transaction_id === v("settlingTransactionId")']] }),
  payInvoice("Pay again, new key", "invoiceId", { idem: "new", status: 409 }),
  balanceIs("Ada was charged once (750,000 left)", "payerAccountId", "750000"),
  req("Settling transaction is an invoice payment to Tolu", "GET", "/transactions/{{settlingTransactionId}}", {
    status: 200,
    checks: [["invoice_payment, 250,000, into the issuing account", 'j.transaction_type === "invoice_payment" && j.amount_minor === 250000 && j.receiver_account_id === v("issuerAccountId")']],
  }),
  req("Billed user can't cancel", "POST", "/invoices/{{extraA}}/cancel", { status: 403 }),
  signInAs("issuer", "issuer (Tolu)"),
  balanceIs("Tolu received 250,000", "issuerAccountId", "250000"),
  req("Cancel a paid invoice", "POST", "/invoices/{{invoiceId}}/cancel", {
    status: 409,
    checks: [["clear message", "/already been paid/.test(errorMessage)"]],
  }),
  req("Issuer cancels invoice A", "POST", "/invoices/{{extraA}}/cancel", { status: 200, checks: [["cancelled", 'j.invoice_status === "cancelled" && Boolean(j.cancelled_at)']] }),
  req("Cancel twice", "POST", "/invoices/{{extraA}}/cancel", { status: 409 }),
  req("Back office: cancel with a wrong key", "POST", "/invoices/{{extraB}}/cancel", { internal: "wrong", status: 401 }),
  req("Back office: cancel invoice B", "POST", "/invoices/{{extraB}}/cancel", { internal: true, status: 200, checks: [["cancelled", 'j.invoice_status === "cancelled"']] }),
  createInvoice("Create a 'late' invoice (₦50)", { amount_due_minor: 5000 }, { status: 201, save: [["lateInvoiceId", "j.invoice_id"]] }),
  req("Dev: move its due date 3 days into the past", "POST", "/dev/invoices/{{lateInvoiceId}}/backdate", {
    body: { days: 3 },
    status: 200,
    description: "Development only. The API itself refuses past due dates, so this simulates time passing.",
  }),
  createInvoice("Create one from the second account", { issuer_account_id: "{{issuerEmptyAccountId}}" }, { status: 201, save: [["pendingInvoiceId", "j.invoice_id"]] }),
  req("Close an account with open invoices", "POST", "/accounts/{{issuerEmptyAccountId}}/close", { status: 409, checks: [["mentions invoices", "/invoices/.test(errorMessage)"]] }),
  req("Cancel that invoice", "POST", "/invoices/{{pendingInvoiceId}}/cancel", { status: 200 }),
  req("Close the account now", "POST", "/accounts/{{issuerEmptyAccountId}}/close", { status: 200 }),
  createInvoice("Create a 'race' invoice (₦70)", { amount_due_minor: 7000 }, { status: 201, save: [["raceInvoiceId", "j.invoice_id"]] }),
  signInAs("payer", "payer (Ada)"),
  req("Ada: pay a cancelled invoice", "POST", "/invoices/{{extraA}}/pay", { idem: "new", body: { source_account_id: "{{payerAccountId}}" }, status: 409 }),
  req("Past-due open invoice reads as overdue", "GET", "/invoices/{{lateInvoiceId}}", { status: 200, checks: [["overdue", 'j.invoice_status === "overdue"']] }),
  req("Overdue filter", "GET", "/invoices?status=overdue&limit=100", {
    status: 200,
    checks: [["includes it, and only overdue ones", 'j.data.some((x) => x.invoice_id === v("lateInvoiceId")) && j.data.every((x) => x.invoice_status === "overdue")']],
  }),
  req("Open filter excludes overdue", "GET", "/invoices?status=open&limit=100", { status: 200, checks: [["excluded", '!j.data.some((x) => x.invoice_id === v("lateInvoiceId"))']] }),
  payInvoice("An overdue invoice can still be paid", "lateInvoiceId", { idem: "new", status: 200, checks: [["paid", 'j.invoice_status === "paid"']] }),
  concurrently("Concurrent: 5 payments of one invoice at once", {
    count: 5,
    method: "POST",
    path: "/invoices/{{raceInvoiceId}}/pay",
    bodyExpr: '{ source_account_id: pm.collectionVariables.get("payerAccountId") }',
    expectExpr: `${count(null, 200)} === 1 && ${count(null, 409)} === 4`,
    label: "exactly one payment wins, four get 409",
    description: "The invoice row is locked while it's paid, so the other four see it already paid.",
  }),
  balanceIs("Ada charged once for each (738,000 left)", "payerAccountId", "738000"),
  signInAs("issuer", "issuer (Tolu)"),
  balanceIs("Tolu holds all three payments (262,000)", "issuerAccountId", "262000"),
  refundInvoice("Refund - missing key", "invoiceId", { body: {}, status: 400 }),
  refundInvoice("Refund - reason too long", "invoiceId", { idem: "new", body: { reason: "x".repeat(300) }, status: 422 }),
  refundInvoice("Refund an open invoice", "extraC", { idem: "new", status: 409, checks: [["only paid ones", "/Only a paid invoice/.test(errorMessage)"]] }),
  refundInvoice("Refund a cancelled invoice", "extraA", { idem: "new", status: 409 }),
  req("Generic reverse on an invoice payment", "POST", "/transactions/{{settlingTransactionId}}/reverse", {
    idem: "new",
    status: 409,
    checks: [["points to the invoice refund", "/invoices/.test(errorMessage)"]],
  }),
  refundInvoice("Refund the invoice (as issuer)", "invoiceId", {
    idem: "new:refundKey",
    body: { reason: "Project cancelled" },
    status: 200,
    save: [["refundTransactionId", "j.refund_transaction_id"]],
    checks: [["refunded, with the refund transaction and reason", 'j.invoice_status === "refunded" && typeof j.refund_transaction_id === "string" && j.refund_reason === "Project cancelled"']],
  }),
  refundInvoice("Refund - replay same key", "invoiceId", { idem: "same:refundKey", body: { reason: "Project cancelled" }, status: 200, checks: [["same refund", 'replayed && j.refund_transaction_id === v("refundTransactionId")']] }),
  forgetKey("refundKey"),
  refundInvoice("Refund - retry after the lost record", "invoiceId", { idem: "same:refundKey", body: { reason: "Project cancelled" }, status: 200, checks: [["replayed, not refunded twice", 'replayed && j.refund_transaction_id === v("refundTransactionId")']] }),
  refundInvoice("Refund twice", "invoiceId", { idem: "new", status: 409, checks: [["already refunded", "/already been refunded/.test(errorMessage)"]] }),
  balanceIs("Tolu debited once (12,000 left)", "issuerAccountId", "12000"),
  req("Back office: refund the late invoice (a dispute)", "POST", "/invoices/{{lateInvoiceId}}/refund", {
    internal: true,
    idem: "new",
    body: { reason: "Dispute upheld" },
    status: 200,
    checks: [["refunded", 'j.invoice_status === "refunded"']],
  }),
  openAccount("Tolu: open a sink account (business wallet; the second one was closed)", "sinkAccountId", { purpose: "business" }),
  req("Move Tolu's last 7,000 out", "POST", "/transactions", {
    idem: "new",
    body: { sender_account_id: "{{issuerAccountId}}", receiver_account_id: "{{sinkAccountId}}", amount_minor: 7000, currency_code: "NGN" },
    status: 201,
  }),
  refundInvoice("Refund without the funds", "raceInvoiceId", { idem: "new", status: 422, checks: [["insufficient funds", 'errorCode === "INSUFFICIENT_FUNDS"']] }),
  req("A failed refund leaves the invoice paid", "GET", "/invoices/{{raceInvoiceId}}", { status: 200, checks: [["still paid", 'j.invoice_status === "paid"']] }),
  req("Move the 7,000 back", "POST", "/transactions", {
    idem: "new",
    body: { sender_account_id: "{{sinkAccountId}}", receiver_account_id: "{{issuerAccountId}}", amount_minor: 7000, currency_code: "NGN" },
    status: 201,
  }),
  concurrently("Concurrent: 4 refunds of one invoice at once", {
    count: 4,
    method: "POST",
    path: "/invoices/{{raceInvoiceId}}/refund",
    bodyExpr: "{}",
    expectExpr: `${count(null, 200)} === 1 && ${count(null, 409)} === 3`,
    label: "exactly one refund wins, three get 409",
    description: "A payment can only be refunded once: the invoice row lock and the unique reverses_transaction_id both enforce it.",
  }),
  balanceIs("Tolu refunded once (0 left)", "issuerAccountId", "0"),
  signInAs("payer", "payer (Ada)"),
  refundInvoice("Billed user can't refund", "raceInvoiceId", { idem: "new", body: { reason: "please" }, status: 403 }),
  req("Original payment is now reversed", "GET", "/transactions/{{settlingTransactionId}}", {
    status: 200,
    checks: [["reversed and linked to its refund", 'j.status === "reversed" && j.reversed_by_transaction_id === v("refundTransactionId")']],
  }),
  req("Refund goes Tolu -> Ada", "GET", "/transactions/{{refundTransactionId}}", {
    status: 200,
    checks: [["refund of 250,000 back to the paying account", 'j.transaction_type === "refund" && j.sender_account_id === v("issuerAccountId") && j.receiver_account_id === v("payerAccountId") && j.amount_minor === 250000']],
  }),
  req("Ada sees the refund", "GET", "/invoices/{{invoiceId}}", {
    status: 200,
    checks: [["refunded", 'j.invoice_status === "refunded" && Boolean(j.refunded_at) && j.refund_transaction_id === v("refundTransactionId")']],
  }),
  req("Refunded filter", "GET", "/invoices?status=refunded&limit=100", { status: 200, checks: [["includes it, only refunded", 'j.data.some((x) => x.invoice_id === v("invoiceId")) && j.data.every((x) => x.invoice_status === "refunded")']] }),
  payInvoice("Pay a refunded invoice", "invoiceId", { idem: "new", status: 409 }),
  balanceIs("Ada has her ₦10,000 back after the three refunds", "payerAccountId", "1000000"),
  invariants(),
];

// ---------------------------------------------------------------------------
// 7. Two-factor authentication (as Ada)

const twoFactor = [
  signIn("ada"),
  req("Disable 2FA without a recent code", "DELETE", "/auth/2fa", { status: 403, checks: [["asks for 2FA", 'errorCode === "TWO_FACTOR_REQUIRED"']] }),
  req("Verify before setup", "POST", "/auth/2fa/verify", { body: { code: "123456" }, status: 409 }),
  req("Start setup", "POST", "/auth/2fa/enable", {
    status: 200,
    save: [["staleSecret", "j.secret"]],
    checks: [["secret + otpauth URI for Ada", '/^[A-Z2-7]{32}$/.test(j.secret) && j.otpauth_uri.startsWith("otpauth://totp/VergePay%3Aada.login%40vergepay.dev?")']],
  }),
  req("Start setup again (replaces the unconfirmed secret)", "POST", "/auth/2fa/enable", {
    status: 200,
    save: [["totpSecret", "j.secret"], ["totpLastStep", '""']],
    checks: [["a different secret", 'j.secret !== v("staleSecret")']],
  }),
  req("Verify with a code from the replaced secret", "POST", "/auth/2fa/verify", {
    pre: totpScript("staleSecret", { advance: false, into: "staleCode" }),
    body: { code: "{{staleCode}}" },
    status: 422,
    checks: [["invalid code", 'errorCode === "INVALID_TWO_FACTOR_CODE"']],
  }),
  req("Verify with a malformed code", "POST", "/auth/2fa/verify", { body: { code: "12ab56" }, status: 422 }),
  req("Verify to finish setup", "POST", "/auth/2fa/verify", {
    totp: true,
    body: { code: "{{totpCode}}" },
    status: 200,
    checks: [["setup completed", "j.setup_completed === true && j.two_factor_enabled === true"]],
  }),
  req("Start setup when already on", "POST", "/auth/2fa/enable", { status: 409 }),
  req("Use the same code twice", "POST", "/auth/2fa/verify", {
    body: { code: "{{totpCode}}" },
    status: 422,
    description: "Reuses the code just accepted. Each code works once.",
  }),
  req("Sign in: now asks for a code", "POST", "/auth/signin", {
    body: { email: "{{adaEmail}}", password: "{{adaPassword}}" },
    status: 200,
    save: [["pendingRefreshToken", 'pm.cookies.get("refresh_token")']],
    checks: [["two_factor_required", "j.two_factor_required === true"]],
  }),
  req("A half-signed-in session can't reach the API", "GET", "/users/me", { status: 403, checks: [["asks for 2FA", 'errorCode === "TWO_FACTOR_REQUIRED"']] }),
  req("Refreshing keeps it limited", "POST", "/auth/refresh", { status: 200 }),
  req("Still blocked after refresh", "GET", "/accounts", { status: 403 }),
  req("Verify the sign-in challenge", "POST", "/auth/2fa/verify", {
    totp: true,
    body: { code: "{{totpCode}}" },
    status: 200,
    checks: [["challenge answered", "j.setup_completed === false"]],
  }),
  req("The full session works", "GET", "/users/me", { status: 200 }),
  req("The half-session's refresh token was revoked", "POST", "/auth/refresh", {
    headers: [{ key: "Cookie", value: "refresh_token={{pendingRefreshToken}}" }],
    status: 401,
  }),
  dropTwoFactorStamp(),
  req("Disable without a recent code (refreshed session)", "DELETE", "/auth/2fa", { status: 403 }),
  reverify("Re-confirm to disable."),
  req("Disable 2FA", "DELETE", "/auth/2fa", { status: 200, checks: [["off", "j.two_factor_enabled === false"]] }),
  req("Sign in: no code needed any more", "POST", "/auth/signin", {
    body: { email: "{{adaEmail}}", password: "{{adaPassword}}" },
    status: 200,
    checks: [["no challenge", "j.two_factor_required === false"]],
  }),
];

// ---------------------------------------------------------------------------
// 8. Cards, webhook and bank transfers (a fresh card holder, against the Flutterwave stand-in)

const webhookHeaders = [{ key: "verif-hash", value: "{{flwSecretHash}}" }];
const chargeCard = (name, amount, opts = {}) =>
  req(name, "POST", "/cards/{{cardId}}/charges", { body: { amount_minor: amount }, ...opts });
const syncTxn = (name, txnVar, opts) => req(name, "POST", `/transactions/{{${txnVar}}}/sync`, opts);
const chargeCompleted = (name, idVar, txRefVar, opts = {}) =>
  req(name, "POST", "/webhooks/payment-processor", {
    headers: webhookHeaders,
    body: { event: "charge.completed", data: { id: `{{${idVar}}}`, tx_ref: `{{${txRefVar}}}`, status: "successful" }, "event.type": "CARD_TRANSACTION" },
    status: 200,
    ...opts,
  });

const cards = [
  standIn("Stand-in: is it running? (sets charges to 'pending')", "/_test/mode", { charge: "pending" }, {
    description: "Calls the Flutterwave stand-in, not the API. If this fails, start it with `npm run flw:stand-in` and start the API with `npm run start:with-stand-in`.",
  }),
  ...newUser("cardholder", "card holder (Ada)"),
  kycVerify(),
  openAccount("Open the card account (personal wallet)", "cardAccountId"),
  openAccount("Open a second account (business wallet)", "cardAccount2Id", { purpose: "business" }),
  req("Add a card without 2FA", "POST", "/cards", { idem: "new", body: { account_id: "{{cardAccountId}}" }, status: 403, checks: [["asks for 2FA", 'errorCode === "TWO_FACTOR_REQUIRED"']] }),
  ...enableTwoFactor(),
  req("Add a card - missing key", "POST", "/cards", { body: { account_id: "{{cardAccountId}}" }, status: 400 }),
  req("Add a card - client-supplied card_token is refused", "POST", "/cards", {
    idem: "new",
    body: { account_id: "{{cardAccountId}}", card_token: "tok_x" },
    status: 422,
    description: "Only the server may get a card token (from Flutterwave's verify API). Accepting one from a client would let anyone attach a card they don't own.",
    checks: [["card_token flagged", "Boolean(j.error.details.card_token)"]],
  }),
  req("Add a card (start the ₦100 checkout)", "POST", "/cards", {
    idem: "new:linkKey",
    body: { account_id: "{{cardAccountId}}" },
    status: 202,
    save: [
      ["linkTxnId", "j.transaction_id"],
      ["linkTxRef", 'j.checkout_url.split("flwlnk-mock-")[1]'],
      ["cardToken", '"flw-t1-postman-" + Date.now()'],
    ],
    checks: [["pending with a checkout URL", 'j.status === "pending" && j.checkout_url.startsWith("https://checkout.flutterwave.com/")']],
  }),
  req("Add a card - replay same key", "POST", "/cards", { idem: "same:linkKey", body: { account_id: "{{cardAccountId}}" }, status: 202, checks: [["same link", 'replayed && j.transaction_id === v("linkTxnId")']] }),
  balanceIs("Nothing credited before paying", "cardAccountId", "0"),
  syncTxn("Sync before paying stays pending", "linkTxnId", { status: 200, checks: [["pending", 'j.status === "pending"']] }),
  standIn("Stand-in: the customer pays on the checkout page", "/_test/complete", {
    tx_ref: "{{linkTxRef}}",
    status: "successful",
    card: { first_6digits: "553188", last_4digits: "2950", issuer: "MASTERCARD  CREDIT", country: "NG", type: "MASTERCARD", expiry: "09/32", token: "{{cardToken}}" },
  }, { save: [["flwLinkId", "String(j.id)"]] }),
  req("Webhook without a signature", "POST", "/webhooks/payment-processor", {
    body: { event: "charge.completed", data: { id: "{{flwLinkId}}", tx_ref: "{{linkTxRef}}" } },
    status: 401,
  }),
  req("Webhook with a wrong hash", "POST", "/webhooks/payment-processor", {
    headers: [{ key: "verif-hash", value: "wrong" }],
    body: { event: "charge.completed", data: { id: "{{flwLinkId}}", tx_ref: "{{linkTxRef}}" } },
    status: 401,
  }),
  req("Webhook that lies about the amount", "POST", "/webhooks/payment-processor", {
    headers: webhookHeaders,
    body: { event: "charge.completed", data: { id: "{{flwLinkId}}", tx_ref: "{{linkTxRef}}", status: "successful", amount: 999999, currency: "NGN" } },
    status: 200,
    description: "Signed correctly, but the amount in the body is false. The API ignores it and asks Flutterwave's verify API for the truth.",
    checks: [["accepted", "j.received === true"]],
  }),
  req("Same webhook again", "POST", "/webhooks/payment-processor", {
    headers: webhookHeaders,
    body: { event: "charge.completed", data: { id: "{{flwLinkId}}", tx_ref: "{{linkTxRef}}", status: "successful", amount: 999999, currency: "NGN" } },
    status: 200,
    checks: [["recognised as a duplicate", "j.duplicate === true"]],
  }),
  balanceIs("Credited the verified ₦100, not the webhook's number", "cardAccountId", "10000"),
  syncTxn("Sync shows the linked card", "linkTxnId", {
    status: 200,
    save: [["cardId", "j.linked_card_id"]],
    checks: [["settled and linked", 'j.status === "settled" && j.card_link_status === "linked" && Boolean(j.linked_card_id)']],
  }),
  req("Link payment has its 2 ledger entries", "GET", "/transactions/{{linkTxnId}}", { status: 200, checks: [["2 entries, card_id set", 'j.ledger_entries.length === 2 && j.card_id === v("cardId")']] }),
  req("List my cards", "GET", "/cards", {
    status: 200,
    checks: [
      ["display fields only", 'j.data.some((c) => c.card_id === v("cardId") && c.pan_bin === "553188" && c.pan_last_four === "2950" && c.provider_name === "Mastercard" && c.card_status === "active" && c.expiry_year === 2032)'],
      ["the token appears nowhere", '!pm.response.text().includes(v("cardToken")) && !pm.response.text().includes("card_token")'],
    ],
  }),
  req("Get the card", "GET", "/cards/{{cardId}}", {
    status: 200,
    checks: [["default controls", "j.controls.online_payments_enabled === true && j.controls.daily_limit_minor === null && j.issuer === \"MASTERCARD CREDIT\""]],
  }),
  req("Filter cards by another account", "GET", "/cards?account_id={{cardAccount2Id}}", { status: 200, checks: [["none", "j.data.length === 0"]] }),
  req("Webhook signed the v4 way (HMAC)", "POST", "/webhooks/payment-processor", {
    pre: [
      'const cryptoJs = require("crypto-js");',
      'const body = JSON.stringify({ type: "charge.completed", id: "evt-" + Date.now(), data: { id: 1, tx_ref: "unknown-ref" } });',
      'pm.collectionVariables.set("webhookBody", body);',
      'pm.collectionVariables.set("webhookSignature", cryptoJs.HmacSHA256(body, pm.collectionVariables.get("flwSecretHash")).toString(cryptoJs.enc.Base64));',
    ],
    headers: [{ key: "flutterwave-signature", value: "{{webhookSignature}}" }],
    raw: "{{webhookBody}}",
    status: 200,
    description: "flutterwave-signature is a base64 HMAC-SHA256 of the raw body, keyed with the secret hash.",
  }),
  req("Webhook with a bad HMAC", "POST", "/webhooks/payment-processor", {
    headers: [{ key: "flutterwave-signature", value: "bm9wZQ==" }],
    raw: "{{webhookBody}}",
    status: 401,
  }),
  chargeCard("Top up ₦500 from the card", 50000, {
    idem: "new:chargeKey",
    status: 202,
    save: [["charge1Id", "j.transaction_id"]],
    checks: [["pending, for this card", 'j.status === "pending" && j.card_id === v("cardId")']],
  }),
  req("A pending charge has no ledger rows", "GET", "/transactions/{{charge1Id}}", { status: 200, checks: [["pending, 0 entries", 'j.status === "pending" && j.ledger_entries.length === 0']] }),
  balanceIs("Balance unchanged while pending", "cardAccountId", "10000"),
  chargeCard("Top up - replay same key", 50000, { idem: "same:chargeKey", status: 202, checks: [["same charge", 'replayed && j.transaction_id === v("charge1Id")']] }),
  forgetKey("chargeKey"),
  chargeCard("Top up - retry after the lost record", 50000, { idem: "same:chargeKey", status: 202, checks: [["same charge, not sent twice", 'replayed && j.transaction_id === v("charge1Id")']] }),
  req("Same key on another card", "POST", "/cards/00000000-0000-4000-8000-000000000000/charges", { idem: "same:chargeKey", body: { amount_minor: 50000 }, status: 422 }),
  standIn("Stand-in: the charge succeeds", "/_test/complete-latest", { status: "successful" }, { save: [["flwChargeId", "String(j.id)"], ["flwChargeRef", "j.tx_ref"]] }),
  chargeCompleted("Webhook: charge.completed", "flwChargeId", "flwChargeRef"),
  balanceIs("Settled by the webhook (₦600)", "cardAccountId", "60000"),
  req("Settled card payment carries its card", "GET", "/transactions/{{charge1Id}}", {
    status: 200,
    checks: [["settled card_payment with card_id and 2 entries", 'j.status === "settled" && j.transaction_type === "card_payment" && j.card_id === v("cardId") && j.ledger_entries.length === 2']],
  }),
  standIn("Stand-in: next charges succeed at once", "/_test/mode", { charge: "successful" }),
  chargeCard("Top up ₦200 (settles in the response)", 20000, { idem: "new", status: 202, checks: [["settled", 'j.status === "settled"']] }),
  balanceIs("Balance ₦800", "cardAccountId", "80000"),
  standIn("Stand-in: next charges need 3-D Secure", "/_test/mode", { charge: "3ds" }),
  chargeCard("Top up ₦100 (bank asks the customer to approve)", 10000, {
    idem: "new:tdsKey",
    status: 202,
    save: [["tdsId", "j.transaction_id"]],
    description: "As seen on the real sandbox: the charge waits for 3-D Secure, and the app must open authorization_url.",
    checks: [["pending with authorization_url", 'j.status === "pending" && String(j.authorization_url).startsWith("https://ravesandboxapi.flutterwave.com/mockvbvpage")']],
  }),
  chargeCard("Replay still returns the approval link", 10000, { idem: "same:tdsKey", status: 202, checks: [["link again", "replayed && Boolean(j.authorization_url)"]] }),
  standIn("Stand-in: the customer approves", "/_test/complete-latest", { status: "successful" }),
  syncTxn("Sync after approval", "tdsId", { status: 200, checks: [["settled", 'j.status === "settled"']] }),
  forgetKey("tdsKey"),
  chargeCard("Retry: settled, link no longer offered", 10000, { idem: "same:tdsKey", status: 202, checks: [["settled, authorization_url null", 'j.status === "settled" && j.authorization_url === null']] }),
  balanceIs("Balance ₦900", "cardAccountId", "90000"),
  standIn("Stand-in: next charges are declined", "/_test/mode", { charge: "decline" }),
  chargeCard("Top up - declined", 15000, { idem: "new", status: 502, checks: [["processor error", 'errorCode === "PAYMENT_PROCESSOR_ERROR"']] }),
  standIn("Stand-in: back to pending", "/_test/mode", { charge: "pending" }),
  chargeCard("Top up ₦300 (will be tampered with)", 30000, { idem: "new", status: 202, save: [["tamperedId", "j.transaction_id"]] }),
  standIn("Stand-in: it 'succeeds' for ₦3 instead", "/_test/complete-latest", { status: "successful", amount: 3 }),
  syncTxn("Amount mismatch is failed, never credited", "tamperedId", { status: 200, checks: [["failed: amount mismatch", 'j.status === "failed" && /amount mismatch/.test(j.failure_reason)']] }),
  balanceIs("Balance still ₦900", "cardAccountId", "90000"),
  chargeCard("Top up ₦300 (the bank will decline later)", 30000, { idem: "new", status: 202, save: [["failingId", "j.transaction_id"]] }),
  standIn("Stand-in: it fails", "/_test/complete-latest", { status: "failed" }),
  syncTxn("Failed at the processor is failed here", "failingId", { status: 200, checks: [["failed", 'j.status === "failed"']] }),
  chargeCard("Top up below the ₦100 minimum", 100, { idem: "new", status: 422 }),
  req("Controls: daily limit ₦1,100", "PATCH", "/cards/{{cardId}}/controls", { body: { daily_limit_minor: 110000 }, status: 200, checks: [["saved", "j.controls.daily_limit_minor === 110000"]] }),
  chargeCard("Top up over the daily limit", 40000, {
    idem: "new",
    status: 422,
    description: "Used today: the ₦100 link + ₦500 + ₦200 + ₦100 = ₦900. Failed and declined charges don't count.",
    checks: [["90000 used", '/90000 used/.test(j.error.details.amount_minor[0])']],
  }),
  req("Controls: online payments off, no limit", "PATCH", "/cards/{{cardId}}/controls", {
    body: { online_payments_enabled: false, daily_limit_minor: null },
    status: 200,
    checks: [["saved", "j.controls.online_payments_enabled === false && j.controls.daily_limit_minor === null"]],
  }),
  chargeCard("Top up with online payments off", 20000, { idem: "new", status: 409 }),
  req("Controls: unknown field", "PATCH", "/cards/{{cardId}}/controls", { body: { online_payments_enabled: true, bogus: 1 }, status: 422 }),
  req("Controls: online payments back on", "PATCH", "/cards/{{cardId}}/controls", { body: { online_payments_enabled: true }, status: 200 }),
  dropTwoFactorStamp(),
  req("Block the card (no 2FA needed)", "POST", "/cards/{{cardId}}/block", { status: 200, description: "Deliberately plain User auth: a lost card can be stopped in one tap.", checks: [["blocked", 'j.card_status === "blocked"']] }),
  req("Block twice", "POST", "/cards/{{cardId}}/block", { status: 409 }),
  chargeCard("Charge a blocked card", 20000, { idem: "new", status: 409 }),
  req("Unblock without a recent code", "POST", "/cards/{{cardId}}/unblock", { status: 403 }),
  reverify("Unblocking needs a recent code."),
  req("Unblock", "POST", "/cards/{{cardId}}/unblock", { status: 200, checks: [["active", 'j.card_status === "active"']] }),
  req("Unblock a card that isn't blocked", "POST", "/cards/{{cardId}}/unblock", { status: 409 }),
  req("Add a card to the second account", "POST", "/cards", {
    idem: "new",
    body: { account_id: "{{cardAccount2Id}}" },
    status: 202,
    save: [["badLinkTxnId", "j.transaction_id"], ["badLinkTxRef", 'j.checkout_url.split("flwlnk-mock-")[1]']],
  }),
  standIn("Stand-in: that checkout fails", "/_test/complete", { tx_ref: "{{badLinkTxRef}}", status: "failed" }),
  syncTxn("Failed link", "badLinkTxnId", { status: 200, checks: [["payment and link failed", 'j.status === "failed" && j.card_link_status === "failed"']] }),
  req("Try again on the second account", "POST", "/cards", {
    idem: "new",
    body: { account_id: "{{cardAccount2Id}}" },
    status: 202,
    save: [["dupLinkTxnId", "j.transaction_id"], ["dupLinkTxRef", 'j.checkout_url.split("flwlnk-mock-")[1]']],
  }),
  standIn("Stand-in: paid with the SAME card", "/_test/complete", {
    tx_ref: "{{dupLinkTxRef}}",
    status: "successful",
    card: { first_6digits: "553188", last_4digits: "2950", type: "MASTERCARD", expiry: "09/32", token: "{{cardToken}}" },
  }),
  syncTxn("Same card on another account: paid, not linked", "dupLinkTxnId", {
    status: 200,
    checks: [["settled, link failed: already linked", 'j.status === "settled" && j.card_link_status === "failed" && /already linked/.test(j.card_link_failure_reason)']],
  }),
  balanceIs("Its ₦100 was still credited", "cardAccount2Id", "10000"),
  req("Bank-transfer number - bad BVN format", "POST", "/accounts/{{cardAccountId}}/virtual-account", { body: { bvn: "123" }, status: 422 }),
  req("Bank-transfer number - needs a profile name", "POST", "/accounts/{{cardAccountId}}/virtual-account", {
    body: { bvn: "22222223883" },
    status: 422,
    checks: [["first_name flagged", "Boolean(j.error.details.first_name)"]],
  }),
  req("Dev: unverify KYC so the name can be set", "POST", "/dev/test-user/reset", { body: { kyc: true }, status: 200, description: "KYC locks names, so this steps back to unverified for a moment." }),
  req("Set Ada's name", "PATCH", "/users/me", { body: { first_name: "Ada", last_name: "Test" }, status: 200 }),
  kycVerify("Verified again."),
  req("Bank-transfer number - processor rejects the BVN", "POST", "/accounts/{{cardAccountId}}/virtual-account", { body: { bvn: "00000000000" }, status: 502 }),
  req("No bank-transfer number yet", "GET", "/accounts/{{cardAccountId}}/virtual-account", { status: 404 }),
  req("Create the bank-transfer number", "POST", "/accounts/{{cardAccountId}}/virtual-account", {
    body: { bvn: "22222223883" },
    status: 201,
    save: [["virtualAccountNumber", "j.account_number"]],
    checks: [["10-digit number and a bank", "/^\\d{10}$/.test(j.account_number) && Boolean(j.bank_name)"], ["BVN not echoed", '!pm.response.text().includes("22222223883")']],
  }),
  req("Create it again returns the same one", "POST", "/accounts/{{cardAccountId}}/virtual-account", {
    body: { bvn: "22222223883" },
    status: 200,
    checks: [["same number", 'j.account_number === v("virtualAccountNumber")']],
  }),
  standIn("Stand-in: someone transfers ₦2,500.50 into it", "/_test/deposit", { tx_ref: "va-{{cardAccountId}}", amount: 2500.5 }, { save: [["depositId", "String(j.id)"]] }),
  req("Webhook: the bank transfer", "POST", "/webhooks/payment-processor", {
    headers: webhookHeaders,
    body: { event: "charge.completed", data: { id: "{{depositId}}", tx_ref: "va-{{cardAccountId}}", amount: 2500.5, payment_type: "bank_transfer" }, "event.type": "BANK_TRANSFER_TRANSACTION" },
    status: 200,
  }),
  balanceIs("Credited in kobo (₦900 + ₦2,500.50)", "cardAccountId", "90000 + 250050"),
  req("Same bank-transfer webhook again", "POST", "/webhooks/payment-processor", {
    headers: webhookHeaders,
    body: { event: "charge.completed", data: { id: "{{depositId}}", tx_ref: "va-{{cardAccountId}}", amount: 2500.5, payment_type: "bank_transfer" }, "event.type": "BANK_TRANSFER_TRANSACTION" },
    status: 200,
    checks: [["duplicate", "j.duplicate === true"]],
  }),
  balanceIs("Credited once", "cardAccountId", "90000 + 250050"),
  req("The deposit shows in history", "GET", "/accounts/{{cardAccountId}}/transactions?limit=1", {
    status: 200,
    checks: [["bank_deposit from JOHN DOE", 'j.data[0].transaction_type === "bank_deposit" && /JOHN DOE/.test(j.data[0].description)']],
  }),
  req("Webhook: a chargeback is recorded", "POST", "/webhooks/payment-processor", {
    headers: webhookHeaders,
    body: { event: "chargeback.initiated", data: { id: "{{depositId}}", flw_ref: "x", amount: 100 } },
    status: 200,
  }),
  req("Move the card account's money out", "POST", "/transactions", {
    idem: "new",
    body: { sender_account_id: "{{cardAccountId}}", receiver_account_id: "{{cardAccount2Id}}", amount_minor: "{{cardBalanceAmount}}", currency_code: "NGN" },
    pre: ['pm.collectionVariables.set("cardBalanceAmount", String(90000 + 250050));'],
    status: 201,
  }),
  req("Close an account with a linked card", "POST", "/accounts/{{cardAccountId}}/close", { status: 409, checks: [["mentions cards", "/cards/.test(errorMessage)"]] }),
  dropTwoFactorStamp(),
  req("Remove the card without a recent code", "DELETE", "/cards/{{cardId}}", { status: 403 }),
  reverify("Removing needs a recent code."),
  req("Remove the card", "DELETE", "/cards/{{cardId}}", { status: 200, description: "The token is overwritten in the database, so the credential itself is gone.", checks: [["removed", 'j.card_status === "removed"']] }),
  req("A removed card is gone", "GET", "/cards/{{cardId}}", { status: 404 }),
  req("Close the card account now", "POST", "/accounts/{{cardAccountId}}/close", {
    status: 200,
    description: "The card is gone and the money was moved out, so it can close. That frees the personal-wallet slot for the USD checks.",
  }),
  openAccount("Open a USD personal wallet", "cardUsdAccountId", { currency: "USD" }),
  req("Add a card to a USD account", "POST", "/cards", { idem: "new", body: { account_id: "{{cardUsdAccountId}}" }, status: 422, description: "Cards fund NGN wallets only." }),
  req("Bank-transfer number for a USD account", "POST", "/accounts/{{cardUsdAccountId}}/virtual-account", { body: { bvn: "22222223883" }, status: 422 }),
  chargeCard("Charge a removed card", 20000, { idem: "new", status: 404 }),
  req("2FA off again", "DELETE", "/auth/2fa", { status: 200 }),
  invariants(),
];

// ---------------------------------------------------------------------------
// 10. Investments (a fresh investor; Alpaca stand-in; needs the worker running)

const alpacaStandIn = (name, path, body, opts = {}) =>
  req(name, "POST", path, { base: "{{alpacaUrl}}", body, status: 200, ...opts });

const saveCalls = () =>
  req("Stand-in: how many positions calls so far", "GET", "/_test/calls?account_number={{brokerageAccount}}", {
    base: "{{alpacaUrl}}",
    status: 200,
    save: [["positionsCallsBefore", "String(j.positions_calls)"]],
  });

const callsSince = (label, expected) =>
  req(`Stand-in: ${label}`, "GET", "/_test/calls?account_number={{brokerageAccount}}", {
    base: "{{alpacaUrl}}",
    status: 200,
    checks: [[`${expected} positions call(s) since`, `j.positions_calls - n("positionsCallsBefore") === ${expected}`]],
  });

// Polls the link until the worker has finished with it, then checks it.
// The sync runs in the background worker, never in the request that asked for it.
function waitForLink(name, { until, checks, description }) {
  return req(name, "GET", "/brokerage-links", {
    status: 200,
    description: `${description ?? ""}\n\nPolls the link (up to 30 seconds) until the background worker is done with it.`.trim(),
    extraCheckLabels: checks.map(([label]) => label),
    tests: [
      'const linkId = v("brokerageLinkId");',
      "const started = Date.now();",
      "const poll = () => pm.sendRequest({ url: pm.variables.replaceIn(\"{{baseUrl}}/brokerage-links\"), method: \"GET\" }, (err, res) => {",
      "  const link = (res.json().data || []).find((l) => l.link_id === linkId);",
      `  const done = link && (${until});`,
      "  if (!done && Date.now() - started < 30000) return setTimeout(poll, 500);",
      '  pm.collectionVariables.set("lastLinkState", JSON.stringify(link || null));',
      ...checks.map(([label, expr]) => `  pm.test(${JSON.stringify(label)}, () => pm.expect(Boolean(link && (${expr})), JSON.stringify(link)).to.be.true);`),
      "});",
      "poll();",
    ],
  });
}

const startConnect = (name, opts = {}) =>
  req(name, "POST", "/brokerage-links", {
    body: { provider_name: "alpaca" },
    status: 200,
    save: [["authorizationUrl", "j.authorization_url"], ["oauthState", "j.state"]],
    ...opts,
  });
const approveAtBrokerage = (name = "The user approves on Alpaca (redirects to our callback)") =>
  req(name, "GET", "", {
    rawUrl: "{{authorizationUrl}}",
    noRedirect: true,
    status: 302,
    description: "What the user's browser does: open authorization_url, log in and approve on the brokerage's site. The brokerage then redirects to our callback with a one-time code.",
    save: [["callbackUrl", 'pm.response.headers.get("Location")']],
    checks: [["redirects to our callback with code and state", '/\\/v1\\/brokerage-links\\/oauth\\/callback\\?/.test(pm.response.headers.get("Location")) && /[?&]state=/.test(pm.response.headers.get("Location"))']],
  });
const landOnCallback = (name, { expectStatus = "linked", reason, save = true } = {}) =>
  req(name, "GET", "", {
    rawUrl: "{{callbackUrl}}",
    noRedirect: true,
    status: 302,
    description: "Our callback exchanges the code for a token (server to server), stores it in the vault, creates the link, queues the first sync, and redirects the browser back to the app.",
    save: save ? [["brokerageLinkId", 'qp(pm.response.headers.get("Location"), "link_id") || v("brokerageLinkId")']] : [],
    checks: [[
      `back to the app with status=${expectStatus}${reason ? ` (${reason})` : ""}`,
      `qp(pm.response.headers.get("Location"), "status") === ${JSON.stringify(expectStatus)}${reason ? ` && qp(pm.response.headers.get("Location"), "reason") === ${JSON.stringify(reason)}` : ""}`,
    ]],
  });
const holdingsList = (name, checks) =>
  req(name, "GET", "/holdings?account_id={{investmentAccountId}}", { status: 200, checks });

const investments = [
  alpacaStandIn("Stand-in: the next Alpaca login approves (fresh brokerage account)", "/_test/next-authorize", { decision: "approve", account_number: "{{brokerageAccount}}" }, {
    pre: ['pm.collectionVariables.set("brokerageAccount", "PA3" + Math.random().toString(36).slice(2, 10).toUpperCase());'],
    description: "Calls the Alpaca stand-in, not the API. If this fails, start it with `npm run alpaca:stand-in`, and start the worker with `npm run worker:with-stand-in`.",
  }),
  alpacaStandIn("Stand-in: the brokerage account holds AAPL, VOO, Bitcoin and an option", "/_test/positions", {
    account_number: "{{brokerageAccount}}",
    positions: [
      { symbol: "AAPL", qty: "10", avg_entry_price: "185.2549", current_price: "190.1" },
      { symbol: "VOO", qty: "2.5", avg_entry_price: "480", current_price: "500.505" },
      { symbol: "BTCUSD", qty: "0.01234567", avg_entry_price: "60000", current_price: "65000", asset_class: "crypto" },
      { symbol: "AAPL250117C00200000", qty: "1", avg_entry_price: "2.5", asset_class: "us_option" },
    ],
  }),
  ...newUser("investor"),
  openAccount("Open a personal wallet", "investorWalletId"),
  req("No investment wallet yet", "GET", "/accounts", {
    status: 200,
    description: "Customers don't open investment wallets; one is opened for them when they link a brokerage.",
    checks: [["none", '!j.data.some((a) => a.account_type === "investment_wallet")']],
  }),
  req("Connect without 2FA", "POST", "/brokerage-links", { body: { provider_name: "alpaca" }, status: 403, checks: [["asks for 2FA", 'errorCode === "TWO_FACTOR_REQUIRED"']] }),
  ...enableTwoFactor(),
  req("Connect - unsupported provider", "POST", "/brokerage-links", { body: { provider_name: "robinhood" }, status: 422 }),
  req("Connect - into a current account", "POST", "/brokerage-links", {
    body: { provider_name: "alpaca", account_id: "{{investorWalletId}}" },
    status: 422,
    description: "Holdings sit in an investment_wallet account, not a wallet.",
  }),
  startConnect("Start connecting Alpaca", {
    checks: [
      ["an Alpaca authorization URL and a state", 'j.authorization_url.startsWith(v("alpacaUrl") + "/oauth/authorize?") && typeof j.state === "string"'],
      ["asks for the paper account, with our callback", 'qp(j.authorization_url, "env") === "paper" && qp(j.authorization_url, "redirect_uri").endsWith("/v1/brokerage-links/oauth/callback") && qp(j.authorization_url, "state") === j.state']],
  }),
  req("An investment wallet was opened for me", "GET", "/accounts", {
    status: 200,
    description: "Starting the connection opened the customer's investment wallet (USD), outside the two-wallet limit.",
    save: [["investmentAccountId", 'j.data.find((a) => a.account_type === "investment_wallet").account_id']],
    checks: [["exactly one, in USD", 'j.data.filter((a) => a.account_type === "investment_wallet").length === 1 && j.data.find((a) => a.account_type === "investment_wallet").currency_code === "USD"']],
  }),
  approveAtBrokerage(),
  landOnCallback("Our callback links the account"),
  landOnCallback("The same callback again (state already used)", { expectStatus: "failed", reason: "expired_or_used_state", save: false }),
  req("A callback with a forged state", "GET", "/brokerage-links/oauth/callback?code=x&state=forged", {
    noRedirect: true,
    status: 302,
    checks: [["refused", 'qp(pm.response.headers.get("Location"), "reason") === "expired_or_used_state"']],
  }),
  waitForLink("First sync done by the worker", {
    until: '["succeeded", "failed"].includes(link.last_sync_status)',
    checks: [
      ["sync succeeded", 'link.last_sync_status === "succeeded" && Boolean(link.last_synced_at)'],
      ["brokerage account number masked", 'link.provider_account === "••••" + v("brokerageAccount").slice(-4)'],
    ],
  }),
  req("Links list shows no token material", "GET", "/brokerage-links", {
    status: 200,
    checks: [["no vault reference or token anywhere", '!/vault:|oauth_token|access_token/.test(pm.response.text())']],
  }),
  holdingsList("Holdings synced from the brokerage", [
    ["3 holdings; the option is skipped", 'j.data.length === 3 && !j.data.some((h) => h.security.ticker_symbol.startsWith("AAPL2"))'],
    ["AAPL in cents, rounded half up", 'j.data.some((h) => h.security.ticker_symbol === "AAPL" && h.quantity === "10" && h.average_cost_minor === 18525 && h.current_price_minor === 19010 && h.market_value_minor === 190100)'],
    ["security nested inline with its name", 'j.data.some((h) => h.security.ticker_symbol === "AAPL" && h.security.company_name === "Apple Inc. Common Stock" && h.security.asset_type === "stock" && h.security.currency_code === "USD")'],
    ["fractional Bitcoin kept exactly (up to 9 decimals)", 'j.data.some((h) => h.security.ticker_symbol === "BTCUSD" && h.quantity === "0.01234567" && h.security.asset_type === "crypto")'],
    ["biggest position first", 'j.data[0].security.ticker_symbol === "AAPL"'],
  ], ),
  req("Holdings: save one id", "GET", "/holdings?account_id={{investmentAccountId}}", {
    status: 200,
    save: [["holdingId", 'j.data.find((h) => h.security.ticker_symbol === "VOO").holding_id']],
  }),
  req("Get one holding", "GET", "/holdings/{{holdingId}}", { status: 200, checks: [["VOO from Alpaca", 'j.security.ticker_symbol === "VOO" && j.provider_name === "alpaca"']] }),
  req("An unknown holding", "GET", "/holdings/00000000-0000-4000-8000-000000000000", { status: 404 }),
  alpacaStandIn("Stand-in: the user sells VOO and buys more AAPL", "/_test/positions", {
    account_number: "{{brokerageAccount}}",
    positions: [
      { symbol: "AAPL", qty: "12", avg_entry_price: "186", current_price: "191" },
      { symbol: "BTCUSD", qty: "0.01234567", avg_entry_price: "60000", current_price: "64000", asset_class: "crypto" },
    ],
  }),
  req("Sync now", "POST", "/brokerage-links/{{brokerageLinkId}}/sync", {
    status: 202,
    description: "202: the sync is queued for the worker. A slow or rate-limited brokerage never holds up this request.",
    save: [["syncJobId", "j.job_id"], ["syncRequestedAt", "new Date().toISOString()"]],
    checks: [["queued (or already picked up)", '["queued", "running"].includes(j.sync_status) && j.job_id === "link-" + v("brokerageLinkId")']],
  }),
  req("Sync again at once (no duplicate job)", "POST", "/brokerage-links/{{brokerageLinkId}}/sync", {
    status: 202,
    checks: [["same job", 'j.job_id === v("syncJobId")']],
  }),
  waitForLink("Wait for that sync", {
    until: 'link.last_sync_status === "succeeded" && new Date(link.last_synced_at) > new Date(v("syncRequestedAt"))',
    checks: [["succeeded", 'link.last_sync_status === "succeeded"']],
  }),
  holdingsList("Sold position removed, the rest updated", [
    ["2 holdings, AAPL now 12, VOO gone", 'j.data.length === 2 && j.data.find((h) => h.security.ticker_symbol === "AAPL").quantity === "12" && !j.data.some((h) => h.security.ticker_symbol === "VOO")'],
  ]),
  saveCalls(),
  alpacaStandIn("Stand-in: the next two calls hit a rate limit, then an outage", "/_test/fail-next", { account_number: "{{brokerageAccount}}", statuses: [429, 503] }),
  req("Sync (the brokerage misbehaves)", "POST", "/brokerage-links/{{brokerageLinkId}}/sync", { status: 202, save: [["syncRequestedAt", "new Date().toISOString()"]] }),
  waitForLink("Retried with backoff, then succeeded", {
    until: 'link.last_sync_status === "succeeded" && new Date(link.last_synced_at) > new Date(v("syncRequestedAt"))',
    checks: [["succeeded after retries", 'link.last_sync_status === "succeeded"']],
  }),
  callsSince("the worker made 3 attempts", 3),
  saveCalls(),
  alpacaStandIn("Stand-in: the next five calls all fail", "/_test/fail-next", { account_number: "{{brokerageAccount}}", statuses: [500, 500, 500, 500, 500] }),
  req("Sync (the brokerage stays down)", "POST", "/brokerage-links/{{brokerageLinkId}}/sync", { status: 202 }),
  waitForLink("Gives up after 5 attempts", {
    until: 'link.last_sync_status === "failed"',
    checks: [["failed, error recorded, link still active", 'link.last_sync_status === "failed" && /500/.test(link.last_sync_error) && link.link_status === "active"']],
  }),
  callsSince("exactly 5 attempts", 5),
  holdingsList("A failed sync leaves holdings as they were", [["still 2", "j.data.length === 2"]]),
  req("Dev: make the link overdue and run the scheduler", "POST", "/dev/brokerage/run-scheduler", {
    status: 202,
    save: [["syncRequestedAt", "new Date().toISOString()"]],
    description: "Development only. Queues the same sync-all-links job the scheduler runs every 15 minutes, after making this user's links look overdue.",
  }),
  waitForLink("The scheduler synced the overdue link", {
    until: 'link.last_sync_status === "succeeded" && new Date(link.last_synced_at) > new Date(v("syncRequestedAt"))',
    checks: [["synced by the scheduled job", 'link.last_sync_status === "succeeded"']],
  }),
  saveCalls(),
  alpacaStandIn("Stand-in: the user revokes our access at Alpaca", "/_test/revoke", { account_number: "{{brokerageAccount}}" }),
  req("Sync (the token is now refused)", "POST", "/brokerage-links/{{brokerageLinkId}}/sync", { status: 202 }),
  waitForLink("The link is marked expired", {
    until: 'link.link_status === "expired"',
    checks: [["expired, sync failed", 'link.link_status === "expired" && link.last_sync_status === "failed"']],
  }),
  callsSince("not retried: 1 attempt", 1),
  req("Syncing an expired link", "POST", "/brokerage-links/{{brokerageLinkId}}/sync", {
    status: 409,
    checks: [["asks to reconnect", "/Reconnect/.test(errorMessage)"]],
  }),
  reverify("Reconnecting is 'User + 2FA' too."),
  startConnect("Reconnect"),
  approveAtBrokerage("Reconnect: the user approves"),
  req("Reconnect: our callback reuses the same link", "GET", "", {
    rawUrl: "{{callbackUrl}}",
    noRedirect: true,
    status: 302,
    checks: [["linked, same link_id", 'qp(pm.response.headers.get("Location"), "status") === "linked" && qp(pm.response.headers.get("Location"), "link_id") === v("brokerageLinkId")']],
  }),
  waitForLink("The reconnected link is active and syncs again", {
    until: 'link.link_status === "active" && link.last_sync_status === "succeeded" && link.account_id === v("investmentAccountId")',
    checks: [["active, synced, same wallet", 'link.link_status === "active" && link.last_sync_status === "succeeded" && link.account_id === v("investmentAccountId")']],
  }),
  holdingsList("The holdings are back in the wallet", [["the 2 holdings are here", "j.data.length === 2"]]),
  req("Still one investment wallet", "GET", "/accounts", {
    status: 200,
    description: "Reconnecting reuses the customer's investment wallet rather than opening another.",
    checks: [["exactly one", 'j.data.filter((a) => a.account_type === "investment_wallet").length === 1']],
  }),
  alpacaStandIn("Stand-in: the next Alpaca login is denied", "/_test/next-authorize", { decision: "deny" }),
  startConnect("Start connecting (the user will decline)"),
  approveAtBrokerage("The user declines on Alpaca"),
  landOnCallback("Back to the app: failed, access_denied", { expectStatus: "failed", reason: "access_denied", save: false }),
  alpacaStandIn("Stand-in: logins approve again", "/_test/next-authorize", { decision: "approve", account_number: "{{brokerageAccount}}" }),
  startConnect("Start connecting (the user will be too slow)"),
  req("Dev: let the 10 minutes pass", "POST", "/dev/oauth-states/expire", { body: { state: "{{oauthState}}" }, status: 200, description: "Development only. Ages the pending connection past its 10-minute window." }),
  approveAtBrokerage("The user approves, too late"),
  landOnCallback("Back to the app: failed, the state expired", { expectStatus: "failed", reason: "expired_or_used_state", save: false }),
  dropTwoFactorStamp(),
  req("Disconnect without a recent code", "DELETE", "/brokerage-links/{{brokerageLinkId}}", { status: 403 }),
  reverify("Disconnecting is 'User + 2FA'."),
  req("Disconnect", "DELETE", "/brokerage-links/{{brokerageLinkId}}", {
    status: 200,
    description: "Destroys the stored token (nothing is left to decrypt) and removes the holdings that came from this link.",
    checks: [["revoked", 'j.link_status === "revoked"']],
  }),
  req("Its holdings are gone", "GET", "/holdings?account_id={{investmentAccountId}}", { status: 200, checks: [["none", "j.data.length === 0"]] }),
  req("Gone from the links list", "GET", "/brokerage-links", { status: 200, checks: [["not listed", '!j.data.some((l) => l.link_id === v("brokerageLinkId"))']] }),
  req("Disconnect twice", "DELETE", "/brokerage-links/{{brokerageLinkId}}", { status: 409 }),
  req("Sync a disconnected link", "POST", "/brokerage-links/{{brokerageLinkId}}/sync", { status: 409 }),
  req("2FA off again", "DELETE", "/auth/2fa", { status: 200 }),
];

// ---------------------------------------------------------------------------
// 9. Wrap-up

const wrapUp = [
  signIn("ada"),
  req("2FA: start setup (for the brute-force check)", "POST", "/auth/2fa/enable", { status: 200 }),
  req("2FA: brute force is cut off", "POST", "/auth/2fa/verify", {
    body: { code: "000000" },
    status: 422,
    description: "Sends wrong codes until the limit (5 failures per user per 15 minutes) answers 429. Earlier folders already used some failures, so it may take fewer than 5.",
    extraCheckLabels: ["a 429 arrives within 5 more wrong codes"],
    tests: [
      "const codes = [pm.response.code];",
      "const next = () => pm.sendRequest({",
      '  url: pm.variables.replaceIn("{{baseUrl}}/auth/2fa/verify"), method: "POST",',
      '  header: { "Content-Type": "application/json" }, body: { mode: "raw", raw: JSON.stringify({ code: "000000" }) },',
      "}, (err, res) => {",
      "  codes.push(res.code);",
      "  if (res.code !== 429 && codes.length < 6) return next();",
      '  pm.test("a 429 arrives within 5 more wrong codes (" + codes.join(", ") + ")", () => pm.expect(codes).to.include(429));',
      "});",
      "next();",
    ],
  }),
  req("Dev: reset Ada (2FA off, limits cleared)", "POST", "/dev/test-user/reset", { body: { two_factor: true, kyc: true }, status: 200 }),
  signIn("tolu"),
  req("Dev: reset Tolu", "POST", "/dev/test-user/reset", { body: { kyc: true }, status: 200 }),
  req("Logout", "POST", "/auth/logout", { status: 200 }),
  req("Profile after logout", "GET", "/users/me", { status: 401 }),
  req("Logout with no session", "POST", "/auth/logout", { status: 200 }),
];

// ---------------------------------------------------------------------------
// The live Flutterwave sandbox collection (manual steps)

const live = [
  ...newUser("liveholder", "live sandbox customer"),
  req("Set a profile name", "PATCH", "/users/me", {
    body: { first_name: "Ada", last_name: "Test" },
    status: 200,
    description: "The bank-transfer number needs a first and last name, and KYC locks names, so it's set before verifying.",
  }),
  kycVerify(),
  ...enableTwoFactor(),
  openAccount("Open the card account", "liveAccountId"),
  req("Add a card (real checkout)", "POST", "/cards", {
    idem: "new",
    body: { account_id: "{{liveAccountId}}" },
    status: 202,
    save: [["liveLinkTxnId", "j.transaction_id"], ["liveCheckoutUrl", "j.checkout_url"]],
    description:
      "MANUAL STEP AFTER THIS: open the checkout_url from the response in a browser and pay with Flutterwave's test card: 5531 8866 5214 2950, expiry 09/32, CVV 564, PIN 3310, OTP 12345. Then run the next request.",
    checks: [["a real Flutterwave checkout URL", 'String(j.checkout_url).startsWith("https://")']],
    tests: ['console.log("OPEN THIS AND PAY:", j.checkout_url);'],
  }),
  syncTxn("After paying: sync the link", "liveLinkTxnId", {
    status: 200,
    save: [["liveCardId", "j.linked_card_id"]],
    description: "Asks Flutterwave's verify API. If it still says pending, you haven't finished paying; pay, then send this again.",
    checks: [["settled and card linked", 'j.status === "settled" && j.card_link_status === "linked"']],
  }),
  req("The card, display fields only", "GET", "/cards/{{liveCardId}}", { status: 200, checks: [["Mastercard 553188 •••• 2950", 'j.pan_bin === "553188" && j.pan_last_four === "2950"']] }),
  req("Top up ₦200 from the saved card", "POST", "/cards/{{liveCardId}}/charges", {
    idem: "new",
    body: { amount_minor: 20000 },
    status: 202,
    save: [["liveChargeId", "j.transaction_id"]],
    description:
      "Needs FLW_REDIRECT_URL to be a public https address (start the API with `npm run start:flw-sandbox`). MANUAL STEP AFTER THIS: if authorization_url is in the response, open it in a browser (Flutterwave's mock bank page approves by itself).",
    checks: [["pending", 'j.status === "pending" || j.status === "settled"']],
    tests: ['if (j.authorization_url) console.log("OPEN THIS TO APPROVE:", j.authorization_url);'],
  }),
  syncTxn("After approving: sync the top-up", "liveChargeId", { status: 200, checks: [["settled", 'j.status === "settled"']] }),
  balanceIs("Balance ₦300 (₦100 link + ₦200 top-up)", "liveAccountId", "30000"),
  req("Real sandbox bank-transfer number", "POST", "/accounts/{{liveAccountId}}/virtual-account", {
    pre: [],
    body: { bvn: "22222223883" },
    status: [200, 201],
    description: "Needs a first and last name on the profile (set at the start).",
  }),
  reverify("Re-confirm to switch 2FA off."),
  req("2FA off", "DELETE", "/auth/2fa", { status: 200 }),
];

// ---------------------------------------------------------------------------
// Assembly

const baseVariables = [
  { key: "baseUrl", value: "http://localhost:8000/v1" },
  { key: "standInUrl", value: "http://localhost:9999" },
  { key: "toluEmail", value: "tolu.login@vergepay.dev" },
  { key: "toluPassword", value: "Signin#Tolu2026" },
  { key: "adaEmail", value: "ada.login@vergepay.dev" },
  { key: "adaPassword", value: "Signin$Ada7741" },
  { key: "internalApiKey", value: "", description: "INTERNAL_API_KEY from .env (the back-office key). npm run test:postman fills it in." },
  { key: "flwSecretHash", value: "stand-in-secret-hash", description: "The webhook secret hash. Matches npm run start:with-stand-in." },
  { key: "alpacaUrl", value: "http://localhost:9998", description: "The Alpaca stand-in (npm run alpaca:stand-in)." },
];

function folder(name, description, items) {
  return { name, description, item: items };
}

function collection(name, description, folders) {
  return {
    info: { name, description, schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    variable: baseVariables,
    item: folders.map((f) => ({ ...f, item: f.item.map(({ _doc, ...rest }) => rest) })),
    _docs: folders.map((f) => ({ name: f.name, description: f.description, rows: f.item.map((i) => i._doc) })),
  };
}

const main = collection(
  "VergePay API - full test suite",
  "Every end-to-end test of vergepay_api, including the edge cases. Run the folders in order (Collection Runner, or `npm run test:postman`). Needs the two stand-ins (`npm run flw:stand-in`, `npm run alpaca:stand-in`), the API (`npm run start:with-stand-in`) and the worker (`npm run worker:with-stand-in`), with REDIS_URL set. Always call http://localhost (the cookie jar is per host). Expected results: postman/EXPECTED_RESULTS.md.",
  [
    folder("0. Setup", "Resets the two test users so the suite can run from a clean state.", setup),
    folder("1. Auth", "Sign-up, sign-in, one-time refresh tokens. As Tolu.", auth),
    folder("2. Profile", "Profile edits and the 2FA guards before 2FA exists. As Tolu.", profile),
    folder("3. Accounts", "Opening, idempotency, editing, and the legal status transitions. As Tolu.", accounts),
    folder("4. Transactions", "Transfers through the double-entry ledger: idempotency (including a lost record), validation, history, pagination, reversal. As Tolu.", transactions),
    folder("5. Loans", "Application, back-office approval and payout, the schedule, repayments (including a concurrent race), rejection. As Tolu, with the internal key for back-office calls.", loans),
    folder("6. Invoices", "Tolu bills Ada: validation, visibility, payment, cancellation, overdue, the close guard, a concurrent payment race, and full refunds (including a concurrent refund race).", invoices),
    folder("7. Two-factor authentication", "TOTP setup, the sign-in challenge, one-time codes and the recent-confirmation rule. As Ada. Codes are computed in Postman.", twoFactor),
    folder("8. Cards, webhook and bank transfers", "Card linking through hosted checkout, the signed webhook (v3 and v4), saved-card charges (pending, instant, 3-D Secure, declined, tampered, failed), spending controls, block/unblock/remove, and bank-transfer funding. As Ada, against the Flutterwave stand-in.", cards),
    folder("9. Investments", "Connecting an Alpaca brokerage account with OAuth (approve, deny, replayed, forged and expired states, reconnect), background syncs by the BullMQ worker (retries with backoff, giving up, the scheduler, a revoked token), the synced holdings, and disconnecting. As Ada, against the Alpaca stand-in; needs the worker running.", investments),
    folder("10. Wrap-up", "The 2FA brute-force limit, resetting the test users, and logout.", wrapUp),
  ],
);

const liveCollection = collection(
  "VergePay API - real Flutterwave sandbox",
  "Card linking and a saved-card top-up against the REAL Flutterwave sandbox, with two manual browser steps. Start the API with `npm run start:flw-sandbox` (uses the FLW_* keys in .env). Run the requests one at a time, not in the Collection Runner.",
  [folder("Real sandbox", "Manual steps are described on the requests that need them.", live)],
);

function write(name, value) {
  const { _docs, ...collectionJson } = value;
  fs.writeFileSync(new URL(name, import.meta.url), JSON.stringify(collectionJson, null, 2));
  return _docs;
}

const mainDocs = write("./vergepay-api.postman_collection.json", main);
const liveDocs = write("./vergepay-flutterwave-live.postman_collection.json", liveCollection);

// EXPECTED_RESULTS.md
const escape = (text) => String(text).replace(/\|/g, "\\|").replace(/\n/g, " ");
function docSection(title, docs) {
  let n = 0;
  const parts = [`## ${title}\n`];
  for (const f of docs) {
    parts.push(`### ${f.name}\n\n${f.description}\n\n| # | Request | Expected | Checks |\n|---|---|---|---|`);
    for (const row of f.rows) {
      n += 1;
      const checks = row.checks.length ? row.checks.map(escape).join("<br>") : "";
      parts.push(`| ${n} | **${escape(row.name)}**<br>\`${row.method} ${escape(row.path)}\` | ${row.status} | ${checks} |`);
    }
    parts.push("");
  }
  return { text: parts.join("\n"), count: n };
}
const mainSection = docSection("Full suite (`vergepay-api.postman_collection.json`)", mainDocs);
const liveSection = docSection("Real Flutterwave sandbox (`vergepay-flutterwave-live.postman_collection.json`)", liveDocs);
const totalChecks = mainDocs.reduce((sum, f) => sum + f.rows.reduce((s, r) => s + 1 + r.checks.length, 0), 0);

fs.writeFileSync(
  new URL("./EXPECTED_RESULTS.md", import.meta.url),
  `# VergePay API: expected Postman results

Generated by \`npm run postman:build\` from the same definitions as the collections, so this always matches what they check. Every request checks its status; the "Checks" column lists the extra assertions.

**Full suite:** ${mainSection.count} requests, ${totalChecks} assertions (status + checks). A clean run shows every one passing.

## How to run it

1. Terminals 1 and 2: \`npm run flw:stand-in\` and \`npm run alpaca:stand-in\` (the Flutterwave and Alpaca stand-ins on :9999 and :9998)
2. Terminal 3: \`npm run start:with-stand-in\` (the API on :8000, pointed at the stand-ins)
3. Terminal 4: \`npm run worker:with-stand-in\` (the background worker; needs \`REDIS_URL\` in \`.env\`)
4. Terminal 5: \`npm run test:postman\` (Newman runs every folder and prints a summary), **or** import \`postman/vergepay-api.postman_collection.json\` into Postman, set the \`internalApiKey\` variable to \`INTERNAL_API_KEY\` from \`.env\`, and run it in the Collection Runner in order.

Notes:
- Use \`http://localhost\`, not \`127.0.0.1\`: Postman's cookie jar is per host.
- The suite resets \`tolu_login\` and \`ada_login\` at the start and end (folders 0 and 10), so it can be re-run straight away.
- Requests marked **Dev:** use development-only helpers (\`/v1/dev/*\`) that don't exist in production.
- Requests marked **Stand-in:** call the Flutterwave stand-in's test controls, not the API.
- "Concurrent:" requests fire several requests at the same moment from their test script to prove the row locks.

${mainSection.text}
${liveSection.text}`,
);

console.log(`wrote the full suite: ${mainDocs.length} folders, ${mainSection.count} requests, ${totalChecks} assertions`);
console.log(`wrote the live sandbox collection: ${liveSection.count} requests`);
console.log("wrote postman/EXPECTED_RESULTS.md");
