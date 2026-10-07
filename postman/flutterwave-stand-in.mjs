// A local stand-in for the Flutterwave v3 endpoints the API calls, with the
// response shapes from Flutterwave's docs and the behaviour seen on the
// real sandbox (localhost redirect URLs refused, 3-D Secure on saved-card
// charges). It lets the Postman suite test card edge cases the real sandbox
// can't produce on demand: declines, tampered amounts, forged webhooks.
//
//   npm run flw:stand-in           (listens on :9999)
//   npm run start:with-stand-in    (the API, pointed at it)
//
// Test-only controls, called by the Postman collection:
//   POST /_test/mode              { charge: "pending" | "successful" | "decline" | "3ds" }
//   POST /_test/complete          { tx_ref, status, card?, amount? }   checkout finished
//   POST /_test/complete-latest   { status, amount? }  the newest saved-card charge resolves
//   POST /_test/deposit           { tx_ref, amount }   a bank transfer lands
//   POST /_test/transfer-mode     { transfer: "pending" | "successful" | "failed" | "reject" | "down" }
//   POST /_test/transfer-complete { reference, status: "SUCCESSFUL" | "FAILED", complete_message? }
//
// Banks and name enquiry: account number 0000000000 doesn't exist at any
// bank; any other number belongs to "STAND-IN HOLDER <last four digits>".
// Transfer fees follow Flutterwave's NGN tiers: ₦10.75 up to ₦5,000,
// ₦26.875 up to ₦50,000, ₦53.75 above.
import http from "http";

export const STAND_IN_SECRET_KEY = "FLWSECK_TEST-stand-in-X";
const PORT = Number(process.env.FLW_STAND_IN_PORT) || 9999;

const txns = new Map(); // id -> transaction
const byRef = new Map(); // tx_ref -> id
const tokens = new Map(); // card token -> email
const links = new Map(); // tx_ref -> hosted checkout request
let latestTokenCharge = null;
// unique across restarts, like real Flutterwave ids (the database keeps old ones)
let nextId = Date.now();
let chargeMode = "pending";
let transferMode = "pending";
const transfers = new Map(); // id -> transfer
const transferByRef = new Map(); // reference -> id

const BANKS = [
  { id: 1, code: "044", name: "Access Bank" },
  { id: 2, code: "058", name: "Guaranty Trust Bank" },
  { id: 3, code: "011", name: "First Bank of Nigeria" },
  { id: 4, code: "057", name: "Zenith Bank" },
  { id: 5, code: "50211", name: "Kuda Bank" },
];
const transferFee = (amount) => (amount <= 5000 ? 10.75 : amount <= 50000 ? 26.875 : 53.75);

const send = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const notFound = (res) => send(res, 400, { status: "error", message: "No transaction was found for this id", data: null });

function makeTxn({ tx_ref, amount, currency, status, email, card, payment_type = "card", meta_data }) {
  const id = nextId++;
  const txn = {
    id,
    tx_ref,
    flw_ref: `FLW-MOCK-${id}`,
    amount,
    currency,
    charged_amount: amount,
    status,
    payment_type,
    processor_response: status === "successful" ? "Approved" : "Declined",
    customer: { email, name: "Stand-in Customer" },
    card,
    meta_data,
    created_at: new Date().toISOString(),
  };
  txns.set(id, txn);
  byRef.set(tx_ref, id);
  return txn;
}

const publicCard = (card) => card && { ...card, token: undefined };

http
  .createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return send(res, 400, { status: "error", message: "invalid JSON" });
    }
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    // ---- test controls
    if (path === "/_test/mode") {
      chargeMode = body.charge;
      return send(res, 200, { chargeMode });
    }
    if (path === "/_test/complete") {
      const link = links.get(body.tx_ref);
      if (!link) return send(res, 404, { error: "unknown tx_ref" });
      if (body.card?.token) tokens.set(body.card.token, link.email);
      const t = makeTxn({
        tx_ref: body.tx_ref,
        amount: body.amount ?? link.amount,
        currency: link.currency,
        status: body.status,
        email: link.email,
        card: body.card,
      });
      return send(res, 200, { ...t, card: publicCard(t.card) });
    }
    if (path === "/_test/complete-latest") {
      if (!latestTokenCharge) return send(res, 404, { error: "no saved-card charge yet" });
      const t = txns.get(latestTokenCharge);
      t.status = body.status;
      if (body.amount != null) t.amount = body.amount;
      return send(res, 200, { ...t, card: publicCard(t.card) });
    }
    if (path === "/_test/deposit") {
      const t = makeTxn({
        tx_ref: body.tx_ref,
        amount: body.amount,
        currency: "NGN",
        status: "successful",
        email: "",
        payment_type: "bank_transfer",
        meta_data: { originatorname: "JOHN DOE", bankname: "Test Bank", originatoraccountnumber: "0123456789" },
      });
      return send(res, 200, t);
    }

    if (path === "/_test/transfer-mode") {
      transferMode = body.transfer;
      return send(res, 200, { transferMode });
    }
    if (path === "/_test/transfer-complete") {
      const t = transfers.get(transferByRef.get(body.reference));
      if (!t) return send(res, 404, { error: "unknown reference" });
      t.status = body.status;
      t.complete_message = body.complete_message ?? (body.status === "FAILED" ? "Account resolve failed" : "Transaction was successful");
      return send(res, 200, t);
    }

    // ---- the Flutterwave v3 API
    if (req.headers.authorization !== `Bearer ${STAND_IN_SECRET_KEY}`) {
      return send(res, 401, { status: "error", message: "Invalid authorization key" });
    }

    if (req.method === "POST" && path === "/payments") {
      if (!body.tx_ref || !body.amount || !body.redirect_url || !body.customer?.email) {
        return send(res, 400, { status: "error", message: "missing fields" });
      }
      links.set(body.tx_ref, { amount: body.amount, currency: body.currency, email: body.customer.email });
      return send(res, 200, {
        status: "success",
        message: "Hosted Link",
        data: { link: `https://checkout.flutterwave.com/v3/hosted/pay/flwlnk-mock-${body.tx_ref}` },
      });
    }
    if (req.method === "GET" && path === "/transactions/verify_by_reference") {
      const id = byRef.get(url.searchParams.get("tx_ref"));
      return id
        ? send(res, 200, { status: "success", message: "Transaction fetched successfully", data: txns.get(id) })
        : notFound(res);
    }
    const verify = /^\/transactions\/(\d+)\/verify$/.exec(path);
    if (req.method === "GET" && verify) {
      const t = txns.get(Number(verify[1]));
      return t ? send(res, 200, { status: "success", message: "Transaction fetched successfully", data: t }) : notFound(res);
    }
    if (req.method === "POST" && path === "/tokenized-charges") {
      if (tokens.get(body.token) !== body.email) {
        return send(res, 400, { status: "error", message: "Wrong token or email passed" });
      }
      if (chargeMode === "decline") {
        return send(res, 400, { status: "error", message: "Card declined: insufficient funds" });
      }
      // as on the real sandbox
      if (!/^https:\/\/(?!localhost|127\.)/.test(body.redirect_url ?? "")) {
        return send(res, 400, { status: "error", message: "Please enter a valid redirect url" });
      }
      const status = chargeMode === "3ds" ? "pending" : chargeMode;
      const t = makeTxn({ tx_ref: body.tx_ref, amount: body.amount, currency: body.currency, status, email: body.email, card: { token: body.token } });
      latestTokenCharge = t.id;
      const meta =
        chargeMode === "3ds"
          ? { authorization: { mode: "redirect", redirect: `https://ravesandboxapi.flutterwave.com/mockvbvpage?ref=${t.flw_ref}` } }
          : undefined;
      return send(res, 200, {
        status: "success",
        message: "Charge initiated",
        data: { id: t.id, tx_ref: t.tx_ref, flw_ref: t.flw_ref, amount: t.amount, status: t.status, auth_model: meta ? "VBVSECURECODE" : "NOAUTH", meta },
      });
    }
    if (req.method === "POST" && path === "/virtual-account-numbers") {
      if (!body.is_permanent || !/^\d{11}$/.test(body.bvn ?? "") || body.bvn === "00000000000") {
        return send(res, 400, { status: "error", message: "BVN validation failed" });
      }
      return send(res, 200, {
        status: "success",
        message: "Virtual account created",
        data: {
          response_code: "02",
          flw_ref: `FLW-${Date.now()}`,
          order_ref: `URF_${Date.now()}`,
          // like the real test mode: every customer gets the same number
          account_number: "0067100155",
          bank_name: "Stand-in MFB",
          expiry_date: "N/A",
          amount: "0.00",
        },
      });
    }
    if (req.method === "GET" && path === "/banks/NG") {
      return send(res, 200, { status: "success", message: "Banks fetched successfully", data: BANKS });
    }
    if (req.method === "POST" && path === "/accounts/resolve") {
      const bank = BANKS.find((b) => b.code === body.account_bank);
      if (!bank || !/^\d{10}$/.test(body.account_number ?? "") || body.account_number === "0000000000") {
        return send(res, 400, { status: "error", message: "Sorry, recipient account could not be validated. Please try again", data: null });
      }
      return send(res, 200, {
        status: "success",
        message: "Account details fetched",
        data: { account_number: body.account_number, account_name: `STAND-IN HOLDER ${body.account_number.slice(-4)}` },
      });
    }
    if (req.method === "GET" && path === "/transfers/fee") {
      const amount = Number(url.searchParams.get("amount"));
      return send(res, 200, {
        status: "success",
        message: "Transfer fee fetched",
        data: [{ currency: url.searchParams.get("currency") || "NGN", fee_type: "value", fee: transferFee(amount) }],
      });
    }
    if (req.method === "POST" && path === "/transfers") {
      if (transferMode === "down") return send(res, 503, { status: "error", message: "Service unavailable" });
      if (transferMode === "reject") {
        return send(res, 400, { status: "error", message: "Insufficient balance in your Flutterwave wallet", data: null });
      }
      if (transferByRef.has(body.reference)) {
        return send(res, 400, { status: "error", message: "Transfer with this reference already exists", data: null });
      }
      const bank = BANKS.find((b) => b.code === body.account_bank);
      const id = nextId++;
      const t = {
        id,
        account_number: body.account_number,
        bank_code: body.account_bank,
        full_name: `STAND-IN HOLDER ${String(body.account_number).slice(-4)}`,
        created_at: new Date().toISOString(),
        currency: body.currency,
        debit_currency: body.debit_currency,
        amount: body.amount,
        fee: transferFee(body.amount),
        status: transferMode === "successful" ? "SUCCESSFUL" : transferMode === "failed" ? "FAILED" : "NEW",
        reference: body.reference,
        narration: body.narration,
        complete_message: transferMode === "failed" ? "Account resolve failed" : "",
        requires_approval: 0,
        is_approved: 1,
        bank_name: bank?.name ?? "Unknown bank",
      };
      transfers.set(id, t);
      transferByRef.set(body.reference, id);
      return send(res, 200, { status: "success", message: "Transfer Queued Successfully", data: t });
    }
    const transfer = /^\/transfers\/(\d+)$/.exec(path);
    if (req.method === "GET" && transfer) {
      const t = transfers.get(Number(transfer[1]));
      return t
        ? send(res, 200, { status: "success", message: "Transfer fetched", data: t })
        : send(res, 404, { status: "error", message: "Transfer not found", data: null });
    }
    return send(res, 404, { status: "error", message: `no stand-in for ${req.method} ${path}` });
  })
  .listen(PORT, () => console.log(`Flutterwave stand-in listening on http://localhost:${PORT}`));
