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
  // variables named *Amount hold numbers, so they go into the JSON unquoted
  const raw = body && JSON.stringify(body, null, 2).replace(/"(\{\{\w+Amount\}\})"/g, "$1");
  if (body) request.body = { mode: "raw", raw, options: { raw: { language: "json" } } };
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
  req("2FA: verify before setup (expect 409)", "POST", "/auth/2fa/verify", {
    body: { code: "123456" },
    description: "Full 2FA setup needs codes from an authenticator app, so it's covered by the end-to-end tests rather than here.",
    tests: [status(409)],
  }),
  req("2FA: disable without a recent code (expect 403)", "DELETE", "/auth/2fa", {
    tests: [status(403), 'pm.test("asks for 2FA", () => pm.expect(pm.response.json().error.code).to.eql("TWO_FACTOR_REQUIRED"));'],
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

// Transfers: opens a fresh sender and receiver (both owned by the signed-in
// user, so the same user can also reverse), funds the sender through the
// dev top-up, then exercises transfer, replay, history and reversal.
const transferBody = {
  sender_account_id: "{{senderAccountId}}",
  receiver_account_number: "{{receiverAccountNumber}}",
  amount_minor: 30000,
  currency_code: "NGN",
  description: "August rent contribution",
};

const transactions = [
  req("Dev: mark me KYC-verified", "POST", "/dev/kyc/verify", {
    description: "Development only. Transfers require kyc_status = verified; this sets it for the signed-in user until real KYC exists.",
    tests: [status(200), 'pm.test("verified", () => pm.expect(pm.response.json().kyc_status).to.eql("verified"));'],
  }),
  req("Open sender account", "POST", "/accounts", {
    pre: newKey,
    headers: [idem()],
    body: { account_type: "current", currency_code: "NGN" },
    tests: [status(201), 'pm.collectionVariables.set("senderAccountId", pm.response.json().account_id);'],
  }),
  req("Open receiver account", "POST", "/accounts", {
    pre: newKey,
    headers: [idem()],
    body: { account_type: "savings", currency_code: "NGN" },
    tests: [
      status(201),
      "const a = pm.response.json();",
      'pm.collectionVariables.set("receiverAccountId", a.account_id);',
      'pm.collectionVariables.set("receiverAccountNumber", a.account_number);',
    ],
  }),
  req("Dev: fund sender with 100000", "POST", "/dev/accounts/{{senderAccountId}}/fund", {
    pre: newKey,
    headers: [idem()],
    body: { amount_minor: 100000 },
    description: "Development only. Posts a real ledger transaction from the platform funding account.",
    tests: [status(201), 'pm.test("settled", () => pm.expect(pm.response.json().status).to.eql("settled"));'],
  }),
  req("Transfer 30000 by account number", "POST", "/transactions", {
    pre: newKey,
    headers: [idem()],
    body: transferBody,
    tests: [
      status(201, "transfer created"),
      "const t = pm.response.json();",
      'pm.collectionVariables.set("transactionId", t.transaction_id);',
      'pm.test("settled immediately", () => pm.expect(t.status).to.eql("settled"));',
      'pm.test("amount is in minor units", () => pm.expect(t.amount_minor).to.eql(30000));',
    ],
  }),
  req("Transfer - replay same key (no double charge)", "POST", "/transactions", {
    headers: [idem()],
    body: transferBody,
    tests: [
      status(201),
      'pm.test("same transaction returned", () => pm.expect(pm.response.json().transaction_id).to.eql(pm.collectionVariables.get("transactionId")));',
    ],
  }),
  req("Transfer - insufficient funds (expect 422)", "POST", "/transactions", {
    pre: newKey,
    headers: [idem()],
    body: { ...transferBody, amount_minor: 100000000 },
    tests: [status(422), 'pm.test("insufficient funds", () => pm.expect(pm.response.json().error.code).to.eql("INSUFFICIENT_FUNDS"));'],
  }),
  req("Transfer - unknown account number (expect 422)", "POST", "/transactions", {
    pre: newKey,
    headers: [idem()],
    body: { ...transferBody, receiver_account_number: "0000000000" },
    tests: [status(422)],
  }),
  req("Get sender account (balance 70000)", "GET", "/accounts/{{senderAccountId}}", {
    tests: [status(200), 'pm.test("balance reflects the transfer", () => pm.expect(pm.response.json().balance_minor).to.eql(70000));'],
  }),
  req("Get transaction with ledger entries", "GET", "/transactions/{{transactionId}}", {
    tests: [
      status(200),
      "const e = pm.response.json().ledger_entries;",
      'pm.test("one debit and one credit", () => pm.expect(e.map((x) => x.direction)).to.eql(["DEBIT", "CREDIT"]));',
      'pm.test("they balance", () => pm.expect(e[0].amount_minor).to.eql(e[1].amount_minor));',
    ],
  }),
  req("Sender history", "GET", "/accounts/{{senderAccountId}}/transactions?limit=20", {
    tests: [
      status(200),
      "const page = pm.response.json();",
      'pm.test("latest entry is the debit", () => pm.expect(page.data[0].direction).to.eql("debit"));',
      'pm.test("has pagination fields", () => { pm.expect(page).to.have.property("next_cursor"); pm.expect(page).to.have.property("has_more"); });',
    ],
  }),
  req("Sender history - page size 1 (cursor)", "GET", "/accounts/{{senderAccountId}}/transactions?limit=1", {
    tests: [
      status(200),
      'pm.test("more pages available", () => pm.expect(pm.response.json().has_more).to.be.true);',
      'pm.collectionVariables.set("nextCursor", pm.response.json().next_cursor);',
    ],
  }),
  req("Sender history - next page", "GET", "/accounts/{{senderAccountId}}/transactions?limit=1&after={{nextCursor}}", {
    tests: [status(200), 'pm.test("second row is the top-up credit", () => pm.expect(pm.response.json().data[0].direction).to.eql("credit"));'],
  }),
  req("Sender balance history", "GET", "/accounts/{{senderAccountId}}/balance-history?interval=day", {
    tests: [status(200), 'pm.test("ends at the current balance", () => pm.expect(pm.response.json().data.slice(-1)[0].closing_balance_minor).to.eql(70000));'],
  }),
  req("Reverse transfer (as receiver)", "POST", "/transactions/{{transactionId}}/reverse", {
    pre: newKey,
    headers: [idem()],
    description: "Only the receiving side can reverse. Both accounts belong to this user here, so it's allowed.",
    tests: [status(201), 'pm.test("links to original", () => pm.expect(pm.response.json().original_transaction_id).to.eql(pm.collectionVariables.get("transactionId")));'],
  }),
  req("Reverse again (expect 409)", "POST", "/transactions/{{transactionId}}/reverse", {
    pre: newKey,
    headers: [idem()],
    tests: [status(409)],
  }),
];

// Loans: apply, then the back office approves and disburses (these send the
// X-Internal-Api-Key header; set internalApiKey to INTERNAL_API_KEY from
// .env), then the borrower repays the first installment.
const internal = { key: "X-Internal-Api-Key", value: "{{internalApiKey}}" };
const loanApplication = {
  account_id: "{{loanAccountId}}",
  loan_type: "personal",
  requested_amount_minor: 1500000,
  currency_code: "NGN",
  term_months: 3,
  purpose: "Laptop for freelance work",
};

const loans = [
  req("Open loan account", "POST", "/accounts", {
    pre: newKey,
    headers: [idem()],
    body: { account_type: "current", currency_code: "NGN" },
    tests: [status(201), 'pm.collectionVariables.set("loanAccountId", pm.response.json().account_id);'],
  }),
  req("Apply for a loan", "POST", "/loans/applications", {
    pre: newKey,
    headers: [idem()],
    body: loanApplication,
    description: "Needs KYC verified (done in '4. Transactions'). The Idempotency-Key is optional here.",
    tests: [
      status(202, "accepted for review"),
      "const a = pm.response.json();",
      'pm.collectionVariables.set("applicationId", a.application_id);',
      'pm.test("pending review", () => pm.expect(a.status).to.eql("pending_review"));',
    ],
  }),
  req("Apply again while one is pending (expect 409)", "POST", "/loans/applications", {
    body: loanApplication,
    tests: [status(409)],
  }),
  req("Get application status", "GET", "/loans/applications/{{applicationId}}", {
    tests: [status(200), 'pm.test("no loan yet", () => pm.expect(pm.response.json().loan_id).to.eql(null));'],
  }),
  req("Admin: underwriting queue", "GET", "/admin/loans/applications?status=pending_review", {
    headers: [internal],
    tests: [
      status(200),
      "const a = pm.response.json().data.find((x) => x.application_id === pm.collectionVariables.get(\"applicationId\"));",
      'pm.test("lists the application with applicant data", () => pm.expect(a.applicant.kyc_status).to.eql("verified"));',
    ],
  }),
  req("Admin: queue without key (expect 401)", "GET", "/admin/loans/applications", {
    tests: [status(401)],
  }),
  req("Admin: approve at 18%", "POST", "/loans/applications/{{applicationId}}/approve", {
    headers: [internal],
    body: { interest_rate_bps: 1800 },
    tests: [
      status(201, "loan created"),
      "const l = pm.response.json();",
      'pm.collectionVariables.set("loanId", l.loan_id);',
      'pm.test("approved, not yet paid out", () => pm.expect(l.loan_status).to.eql("approved"));',
    ],
  }),
  req("Get loan (approved, owes 0)", "GET", "/loans/{{loanId}}", {
    tests: [status(200), 'pm.test("nothing owed before disbursement", () => pm.expect(pm.response.json().balance_remaining_minor).to.eql(0));'],
  }),
  req("Admin: disburse", "POST", "/loans/{{loanId}}/disburse", {
    pre: newKey,
    headers: [internal, idem()],
    tests: [
      status(201, "paid out"),
      "const t = pm.response.json();",
      'pm.collectionVariables.set("disbursementId", t.transaction_id);',
      'pm.test("full principal settled", () => { pm.expect(t.status).to.eql("settled"); pm.expect(t.amount_minor).to.eql(1500000); });',
    ],
  }),
  req("Admin: disburse - replay same key", "POST", "/loans/{{loanId}}/disburse", {
    headers: [internal, idem()],
    tests: [status(201), 'pm.test("same transaction", () => pm.expect(pm.response.json().transaction_id).to.eql(pm.collectionVariables.get("disbursementId")));'],
  }),
  req("Admin: disburse again, new key (expect 409)", "POST", "/loans/{{loanId}}/disburse", {
    pre: newKey,
    headers: [internal, idem()],
    tests: [status(409)],
  }),
  req("Get repayment schedule", "GET", "/loans/{{loanId}}/schedule", {
    tests: [
      status(200),
      "const s = pm.response.json().data;",
      'pm.test("3 unpaid installments", () => { pm.expect(s).to.have.length(3); pm.expect(s.every((x) => !x.paid_flag)).to.be.true; });',
      'pm.test("principal portions add up", () => pm.expect(s.reduce((n, x) => n + x.principal_minor, 0)).to.eql(1500000));',
      'pm.collectionVariables.set("installmentAmount", s[0].installment_amount_minor);',
    ],
  }),
  req("Repay - wrong amount (expect 422)", "POST", "/loans/{{loanId}}/repayments", {
    pre: newKey,
    headers: [idem()],
    body: { source_account_id: "{{loanAccountId}}", amount_minor: 100 },
    tests: [status(422)],
  }),
  req("Repay installment 1", "POST", "/loans/{{loanId}}/repayments", {
    pre: newKey,
    headers: [idem()],
    body: { source_account_id: "{{loanAccountId}}", amount_minor: "{{installmentAmount}}" },
    tests: [
      status(201, "repaid"),
      'pm.test("installment 1 marked paid", () => pm.expect(pm.response.json().schedule_installment_marked_paid).to.eql(1));',
    ],
  }),
  req("Get loan (1 of 3 paid)", "GET", "/loans/{{loanId}}", {
    tests: [
      status(200),
      "const l = pm.response.json();",
      'pm.test("active with 1 installment paid", () => { pm.expect(l.loan_status).to.eql("active"); pm.expect(l.installments_paid).to.eql(1); });',
      'pm.test("next is installment 2", () => pm.expect(l.next_installment.installment_number).to.eql(2));',
    ],
  }),
  req("List my loans", "GET", "/loans", {
    tests: [status(200), 'pm.test("includes the loan", () => pm.expect(pm.response.json().data.map((l) => l.loan_id)).to.include(pm.collectionVariables.get("loanId")));'],
  }),
  req("Apply for a second loan", "POST", "/loans/applications", {
    body: loanApplication,
    tests: [status(202), 'pm.collectionVariables.set("applicationId", pm.response.json().application_id);'],
  }),
  req("Admin: reject", "POST", "/loans/applications/{{applicationId}}/reject", {
    headers: [internal],
    body: { reason: "Existing loan still in progress" },
    tests: [status(200), 'pm.test("rejected", () => pm.expect(pm.response.json().status).to.eql("rejected"));'],
  }),
];

// Invoices: the signed-in user bills their own receiver account from the
// sender account (a different user works the same way), then pays it from
// the loan account opened in '5. Loans'.
const invoiceBody = {
  issuer_account_id: "{{senderAccountId}}",
  billed_account_number: "{{receiverAccountNumber}}",
  amount_due_minor: 25000,
  currency_code: "NGN",
  due_date: "2030-12-31",
  description: "UI design, mobile app",
};

const invoices = [
  req("Create invoice", "POST", "/invoices", {
    body: invoiceBody,
    description: "The Idempotency-Key is optional here.",
    tests: [
      status(201, "invoice created"),
      "const i = pm.response.json();",
      'pm.collectionVariables.set("invoiceId", i.invoice_id);',
      'pm.test("open and issued by me", () => { pm.expect(i.invoice_status).to.eql("open"); pm.expect(i.direction).to.eql("issued"); });',
    ],
  }),
  req("Create - due date in the past (expect 422)", "POST", "/invoices", {
    body: { ...invoiceBody, due_date: "2020-01-01" },
    tests: [status(422)],
  }),
  req("Get invoice", "GET", "/invoices/{{invoiceId}}", {
    tests: [status(200), 'pm.test("amount due", () => pm.expect(pm.response.json().amount_due_minor).to.eql(25000));'],
  }),
  req("List my open issued invoices", "GET", "/invoices?role=issued&status=open&limit=20", {
    tests: [
      status(200),
      'pm.test("includes the invoice", () => pm.expect(pm.response.json().data.map((i) => i.invoice_id)).to.include(pm.collectionVariables.get("invoiceId")));',
      'pm.test("has pagination fields", () => pm.expect(pm.response.json()).to.have.property("next_cursor"));',
    ],
  }),
  req("Pay invoice", "POST", "/invoices/{{invoiceId}}/pay", {
    pre: newKey,
    headers: [idem()],
    body: { source_account_id: "{{loanAccountId}}" },
    tests: [
      status(200, "paid"),
      "const i = pm.response.json();",
      'pm.collectionVariables.set("settlingTransactionId", i.settling_transaction_id);',
      'pm.test("paid with a settling transaction", () => { pm.expect(i.invoice_status).to.eql("paid"); pm.expect(i.settling_transaction_id).to.be.a("string"); });',
    ],
  }),
  req("Pay - replay same key (no double charge)", "POST", "/invoices/{{invoiceId}}/pay", {
    headers: [idem()],
    body: { source_account_id: "{{loanAccountId}}" },
    tests: [status(200), 'pm.test("same settling transaction", () => pm.expect(pm.response.json().settling_transaction_id).to.eql(pm.collectionVariables.get("settlingTransactionId")));'],
  }),
  req("Pay again, new key (expect 409)", "POST", "/invoices/{{invoiceId}}/pay", {
    pre: newKey,
    headers: [idem()],
    body: { source_account_id: "{{loanAccountId}}" },
    tests: [status(409)],
  }),
  req("Cancel a paid invoice (expect 409)", "POST", "/invoices/{{invoiceId}}/cancel", {
    tests: [status(409)],
  }),
  req("Refund the paid invoice (as issuer)", "POST", "/invoices/{{invoiceId}}/refund", {
    pre: newKey,
    headers: [idem()],
    body: { reason: "Project cancelled" },
    description: "Returns the full payment from the issuer's account to the account that paid. Only the issuer (or a back-office caller) can refund.",
    tests: [
      status(200, "refunded"),
      "const i = pm.response.json();",
      'pm.test("refunded with a refund transaction", () => { pm.expect(i.invoice_status).to.eql("refunded"); pm.expect(i.refund_transaction_id).to.be.a("string"); });',
    ],
  }),
  req("Refund again, new key (expect 409)", "POST", "/invoices/{{invoiceId}}/refund", {
    pre: newKey,
    headers: [idem()],
    tests: [status(409)],
  }),
  req("Payment transaction now reversed", "GET", "/transactions/{{settlingTransactionId}}", {
    tests: [status(200), 'pm.test("reversed", () => pm.expect(pm.response.json().status).to.eql("reversed"));'],
  }),
  req("Create a second invoice", "POST", "/invoices", {
    body: { ...invoiceBody, amount_due_minor: 5000 },
    tests: [status(201), 'pm.collectionVariables.set("invoiceId", pm.response.json().invoice_id);'],
  }),
  req("Cancel it", "POST", "/invoices/{{invoiceId}}/cancel", {
    tests: [status(200), 'pm.test("cancelled", () => pm.expect(pm.response.json().invoice_status).to.eql("cancelled"));'],
  }),
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
      "Auth, profile, account, transaction, loan and invoice endpoints for vergepay_api. Run the folders top to bottom (or use the Collection Runner). Postman's cookie jar keeps the session cookies, so always call http://localhost, not 127.0.0.1.",
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
    { key: "senderAccountId", value: "" },
    { key: "receiverAccountId", value: "" },
    { key: "receiverAccountNumber", value: "" },
    { key: "transactionId", value: "" },
    { key: "nextCursor", value: "" },
    { key: "internalApiKey", value: "", description: "INTERNAL_API_KEY from .env. Needed by the Admin requests in 5. Loans." },
    { key: "loanAccountId", value: "" },
    { key: "applicationId", value: "" },
    { key: "loanId", value: "" },
    { key: "disbursementId", value: "" },
    { key: "installmentAmount", value: "" },
    { key: "invoiceId", value: "" },
    { key: "settlingTransactionId", value: "" },
  ],
  item: [
    { name: "1. Auth", item: auth },
    { name: "2. Profile", item: profile },
    { name: "3. Accounts", item: accounts },
    { name: "4. Transactions", item: transactions },
    { name: "5. Loans", item: loans },
    { name: "6. Invoices", item: invoices },
    { name: "7. Logout", item: logout },
  ],
};

fs.writeFileSync(out, JSON.stringify(collection, null, 2));
const count = collection.item.reduce((n, folder) => n + folder.item.length, 0);
console.log(`wrote ${out}: ${collection.item.length} folders, ${count} requests`);
