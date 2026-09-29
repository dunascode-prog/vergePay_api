import crypto from "crypto";
import env from "../env.js";
import { ServiceUnavailableError } from "./errorStr.js";

// Encrypts small secrets at rest with AES-256-GCM. Stored as
// "v1:<iv>:<tag>:<ciphertext>", all base64url. Each purpose has its own key
// (64 hex characters = 32 bytes), so one leaked key doesn't open the other:
//
//   twoFactor   TWO_FACTOR_ENCRYPTION_KEY   TOTP secrets
//   vault       VAULT_ENCRYPTION_KEY        third-party OAuth tokens (services/vault.js)

const KEYS = {
  twoFactor: { variable: "TWO_FACTOR_ENCRYPTION_KEY", read: () => env.twoFactorEncryptionKey, feature: "Two-factor authentication" },
  vault: { variable: "VAULT_ENCRYPTION_KEY", read: () => env.vaultEncryptionKey, feature: "Brokerage connections" },
};

function key(name) {
  const { read, feature } = KEYS[name];
  const hex = read();
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) {
    throw new ServiceUnavailableError({ message: `${feature} is not configured on this server.` });
  }
  return Buffer.from(hex, "hex");
}

export function seal(plaintext, keyName = "twoFactor") {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(keyName), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const parts = [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url"));
  return `v1:${parts.join(":")}`;
}

export function open(sealed, keyName = "twoFactor") {
  const [version, iv, tag, data] = sealed.split(":");
  if (version !== "v1") throw new Error("Unknown sealed-secret format.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(keyName), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
