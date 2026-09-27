import crypto from "crypto";

// Time-based one-time passwords (RFC 6238, the scheme authenticator apps
// such as Google Authenticator use): HMAC-SHA1, 6 digits, 30-second steps.

const DIGITS = 6;
const PERIOD_SECONDS = 30;
// accept the previous and next step too, for clock drift between phone and server
const DRIFT_STEPS = 1;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of text.replace(/=+$/, "").toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error("Invalid base32 secret.");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// A new random 160-bit secret, base32-encoded as authenticator apps expect.
export function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

// The otpauth:// URI an authenticator app reads from a QR code.
export function totpUri(secret, accountName, issuer = "VergePay") {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params}`;
}

export function currentStep(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000 / PERIOD_SECONDS);
}

export function totpCode(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

// Returns the time step the code matched, or null. A step at or before
// lastUsedStep is rejected, so a code can't be used twice.
export function verifyTotp(secret, code, lastUsedStep = null, nowMs = Date.now()) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return null;
  const now = currentStep(nowMs);
  for (let step = now - DRIFT_STEPS; step <= now + DRIFT_STEPS; step++) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    const expected = totpCode(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return step;
  }
  return null;
}
