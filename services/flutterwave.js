import env from "../env.js";
import logger from "../logger.js";
import AppError from "../utils/appError.js";
import { ServiceUnavailableError } from "../utils/errorStr.js";

// Thin client for the Flutterwave v3 API (https://developer.flutterwave.com/docs).
// v3 is Flutterwave's supported API; v4 was still in beta when this was
// written. FLW_BASE_URL can point at a stand-in server for tests.
//
// Amounts: our API and database use integer minor units (kobo); Flutterwave
// v3 takes and returns major units (naira), so every call converts here.

const TIMEOUT_MS = 20_000;

export const toMajor = (minor) => minor / 100;
export const toMinor = (major) => Math.round(Number(major) * 100);

export class ProcessorError extends AppError {
  constructor({ message = "The payment processor rejected the request.", details = null } = {}) {
    super({ message, statusCode: 502, code: "PAYMENT_PROCESSOR_ERROR", details });
  }
}

export function isConfigured() {
  return Boolean(env.flutterwave.secretKey);
}

async function request(method, path, body) {
  if (!isConfigured()) {
    throw new ServiceUnavailableError({
      message: "Card and bank-transfer funding aren't configured on this server (FLW_SECRET_KEY is missing).",
    });
  }

  let response;
  try {
    response = await fetch(`${env.flutterwave.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.flutterwave.secretKey}`,
        "Content-Type": "application/json",
      },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    logger.error({ message: "flutterwave request failed", path, error: err.message });
    throw new ServiceUnavailableError({ message: "The payment processor couldn't be reached. Try again shortly." });
  }

  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { message: text.slice(0, 200) };
  }

  if (response.status >= 500) {
    logger.error({ message: "flutterwave server error", path, status: response.status });
    throw new ServiceUnavailableError({ message: "The payment processor is having trouble. Try again shortly." });
  }
  if (!response.ok || json.status !== "success") {
    throw new ProcessorError({ message: json.message || "The payment processor rejected the request." });
  }
  return json.data;
}

// Hosted checkout (Flutterwave Standard). The customer types their card on
// Flutterwave's page, so the card number never reaches our servers.
export function createPaymentLink({ txRef, amountMinor, currency, redirectUrl, customer, title, description, paymentOptions }) {
  return request("POST", "/payments", {
    tx_ref: txRef,
    amount: toMajor(amountMinor),
    currency,
    redirect_url: redirectUrl,
    customer,
    payment_options: paymentOptions,
    customizations: { title, description },
  });
}

// The source of truth for a payment's outcome. Never give value on a webhook
// payload or a redirect's query string alone.
export function verifyTransaction(processorTransactionId) {
  return request("GET", `/transactions/${encodeURIComponent(processorTransactionId)}/verify`);
}

export function verifyByReference(txRef) {
  return request("GET", `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`);
}

// Charges a saved card token. Flutterwave answers "pending" and the outcome
// is confirmed by verifying or by the charge.completed webhook.
export function chargeCardToken({ token, email, amountMinor, currency, txRef, narration }) {
  return request("POST", "/tokenized-charges", {
    token,
    email,
    currency,
    country: "NG",
    amount: toMajor(amountMinor),
    tx_ref: txRef,
    narration,
    redirect_url: env.flutterwave.redirectUrl,
  });
}

// A permanent (static) NGN virtual account. Flutterwave requires a BVN.
export function createStaticVirtualAccount({ email, bvn, txRef, firstName, lastName, narration }) {
  return request("POST", "/virtual-account-numbers", {
    email,
    is_permanent: true,
    bvn,
    tx_ref: txRef,
    firstname: firstName,
    lastname: lastName,
    narration,
    currency: "NGN",
  });
}
