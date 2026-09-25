// Builds postman/vergepay-api.postman_collection.json.
// Run: npm run postman:build   (edit the requests below, then rebuild)

import fs from "fs";

const out = new URL("./vergepay-api.postman_collection.json", import.meta.url);
const json = { key: "Content-Type", value: "application/json" };
const idem = () => ({ key: "Idempotency-Key", value: "{{idempotencyKey}}" });
const newKey = [
  'pm.collectionVariables.set("idempotencyKey", pm.variables.replaceIn("{{$guid}}"));',
];
const status = (code, label = `status is ${code}`) =>
  `pm.test(${JSON.stringify(label)}, () => pm.response.to.have.status(${code}));`;

function req(name, method, path, opts = {}) {
  const { body, headers = [], tests = [], pre = [], description } = opts;
  const event = [];
  if (pre.length) event.push({ listen: "prerequest", script: { type: "text/javascript", exec: pre } });
  if (tests.length) event.push({ listen: "test", script: { type: "text/javascript", exec: tests } });
  const request = {
    method,
    header: [...(body ? [json] : []), ...headers],
    url: { raw: `{{baseUrl}}${path}`, host: ["{{baseUrl}}"], path: path.split("/").filter(Boolean) },
  };
  if (body) request.body = { mode: "raw", raw: JSON.stringify(body, null, 2), options: { raw: { language: "json" } } };
  if (description) request.description = description;
  return { name, event, request };
}

const auth = [
  req("Sign up (random new user)", "POST", "/auth/signup", {
    pre: ['pm.collectionVariables.set("signupUsername", "qa_" + Date.now());'],
    body: {
      username: "{{signupUsername}}",
      email: "{{signupUsername}}@vergepay.dev",
      password: "VergePay#Test2026",
      confirmPassword: "VergePay#Test2026",
    },
    tests: [
      status(201, "user created"),
      'pm.test("no session is created", () => pm.expect(pm.cookies.has("access_token")).to.be.false);',
    ],
  }),
  req("Sign up - weak password (expect 422)", "POST", "/auth/signup", {
    body: { username: "weak_pw_user", email: "weak@vergepay.dev", password: "password123", confirmPassword: "password123" },
    tests: [status(422, "rejected as weak")],
  }),
  req("Sign in", "POST", "/auth/signin", {
    body: { email: "{{loginEmail}}", password: "{{loginPassword}}" },
    tests: [
      status(200, "signed in"),
      'pm.test("session cookies set", () => {',
      '  pm.expect(pm.cookies.has("access_token")).to.be.true;',
      '  pm.expect(pm.cookies.has("refresh_token")).to.be.true;',
      "});",
      'pm.collectionVariables.set("oldRefreshToken", pm.cookies.get("refresh_token"));',
    ],
  }),
  req("Sign in - wrong password (expect 401)", "POST", "/auth/signin", {
    body: { email: "{{loginEmail}}", password: "Wrong#Password1" },
    tests: [status(401, "rejected")],
  }),
  req("Refresh session", "POST", "/auth/refresh", {
    tests: [
      status(200, "refreshed"),
      'pm.test("new refresh token issued", () => pm.expect(pm.cookies.get("refresh_token")).to.not.eql(pm.collectionVariables.get("oldRefreshToken")));',
    ],
  }),
  req("Refresh - reuse old token (expect 401)", "POST", "/auth/refresh", {
    headers: [{ key: "Cookie", value: "refresh_token={{oldRefreshToken}}" }],
    description: "Sends the refresh token from before 'Refresh session'. Each refresh token works once, so this must fail.",
    tests: [status(401, "used refresh token is rejected")],
  }),
];

const profile = [
  req("Get my profile", "GET", "/users/me", {
    tests: [
      status(200),
      'pm.test("returns own email", () => pm.expect(pm.response.json().email).to.eql(pm.collectionVariables.get("loginEmail")));',
    ],
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
    tests: [status(200), 'pm.test("name saved", () => pm.expect(pm.response.json().first_name).to.eql("Tolu"));'],
  }),
  req("Update - email not allowed (expect 422)", "PATCH", "/users/me", {
    body: { email: "new@vergepay.dev" },
    tests: [status(422), 'pm.test("email flagged", () => pm.expect(pm.response.json().error.details).to.have.property("email"));'],
  }),
  req("Update - under 18 (expect 422)", "PATCH", "/users/me", {
    body: { date_of_birth: "2015-01-01" },
    tests: [status(422)],
  }),
];

const accounts = [
  req("List my accounts", "GET", "/accounts", {
    tests: [status(200), 'pm.test("returns a data array", () => pm.expect(pm.response.json().data).to.be.an("array"));'],
  }),
  req("Open account", "POST", "/accounts", {
    pre: newKey,
    headers: [idem()],
    body: { account_type: "savings", currency_code: "NGN" },
    description: "Generates a fresh Idempotency-Key each time it runs and saves the new account's id for the requests below.",
    tests: [
      status(201, "account opened"),
      "const a = pm.response.json();",
      'pm.collectionVariables.set("accountId", a.account_id);',
      'pm.test("10-digit account number", () => pm.expect(a.account_number).to.match(/^\\d{10}$/));',
      'pm.test("starts with zero balance", () => pm.expect(a.balance_minor).to.eql(0));',
    ],
  }),
  req("Open account - replay same key (no duplicate)", "POST", "/accounts", {
    headers: [idem()],
    body: { account_type: "savings", currency_code: "NGN" },
    description: "Re-sends the key from 'Open account' with the same body. The original response comes back and no second account is created.",
    tests: [
      status(201),
      'pm.test("same account returned", () => pm.expect(pm.response.json().account_id).to.eql(pm.collectionVariables.get("accountId")));',
      'pm.test("marked as replay", () => pm.expect(pm.response.headers.get("Idempotent-Replayed")).to.eql("true"));',
    ],
  }),
  req("Open account - same key, different body (expect 422)", "POST", "/accounts", {
    headers: [idem()],
    body: { account_type: "current", currency_code: "NGN" },
    tests: [status(422), 'pm.test("key conflict", () => pm.expect(pm.response.json().error.code).to.eql("IDEMPOTENCY_KEY_CONFLICT"));'],
  }),
  req("Open account - missing key (expect 400)", "POST", "/accounts", {
    body: { account_type: "current", currency_code: "NGN" },
    tests: [status(400)],
  }),
  req("Get account", "GET", "/accounts/{{accountId}}", {
    tests: [status(200), 'pm.test("right account", () => pm.expect(pm.response.json().account_id).to.eql(pm.collectionVariables.get("accountId")));'],
  }),
  req("Get account - unknown id (expect 404)", "GET", "/accounts/00000000-0000-4000-8000-000000000000", {
    tests: [status(404)],
  }),
  req("Update savings target", "PATCH", "/accounts/{{accountId}}", {
    body: { total_savings_minor: 10000000 },
    tests: [status(200), 'pm.test("target saved", () => pm.expect(pm.response.json().total_savings_minor).to.eql(10000000));'],
  }),
  req("Update balance - not allowed (expect 422)", "PATCH", "/accounts/{{accountId}}", {
    body: { balance_minor: 999999 },
    tests: [status(422)],
  }),
  req("Freeze account", "POST", "/accounts/{{accountId}}/freeze", {
    tests: [status(200), 'pm.test("frozen", () => pm.expect(pm.response.json().account_status).to.eql("frozen"));'],
  }),
  req("Freeze again (expect 409)", "POST", "/accounts/{{accountId}}/freeze", { tests: [status(409)] }),
  req("Unfreeze account", "POST", "/accounts/{{accountId}}/unfreeze", {
    tests: [status(200), 'pm.test("active", () => pm.expect(pm.response.json().account_status).to.eql("active"));'],
  }),
  req("Close account", "POST", "/accounts/{{accountId}}/close", {
    tests: [status(200), 'pm.test("closed", () => pm.expect(pm.response.json().account_status).to.eql("closed"));'],
  }),
  req("Unfreeze closed account (expect 409)", "POST", "/accounts/{{accountId}}/unfreeze", { tests: [status(409)] }),
];

const logout = [
  req("Logout", "POST", "/auth/logout", { tests: [status(200)] }),
  req("Profile after logout (expect 401)", "GET", "/users/me", { tests: [status(401)] }),
  req("Logout with no session (expect 200)", "POST", "/auth/logout", { tests: [status(200)] }),
];

const collection = {
  info: {
    name: "VergePay API",
    description:
      "Auth, profile and account endpoints for vergepay_api. Run the folders top to bottom (or use the Collection Runner). Postman's cookie jar keeps the session cookies, so always call http://localhost, not 127.0.0.1.",
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  variable: [
    { key: "baseUrl", value: "http://localhost:8000/v1" },
    { key: "loginEmail", value: "tolu.login@vergepay.dev" },
    { key: "loginPassword", value: "Signin#Tolu2026" },
    { key: "signupUsername", value: "" },
    { key: "idempotencyKey", value: "" },
    { key: "accountId", value: "" },
    { key: "oldRefreshToken", value: "" },
  ],
  item: [
    { name: "1. Auth", item: auth },
    { name: "2. Profile", item: profile },
    { name: "3. Accounts", item: accounts },
    { name: "4. Logout", item: logout },
  ],
};

fs.writeFileSync(out, JSON.stringify(collection, null, 2));
const count = collection.item.reduce((n, folder) => n + folder.item.length, 0);
console.log(`wrote ${out}: ${collection.item.length} folders, ${count} requests`);
