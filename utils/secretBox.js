import crypto from "crypto";
import env from "../env.js";
import { ServiceUnavailableError } from "./errorStr.js";

// Encrypts small secrets at rest (currently TOTP secrets) with AES-256-GCM
// under TWO_FACTOR_ENCRYPTION_KEY (64 hex characters = 32 bytes). Stored as
// "v1:<iv>:<tag>:<ciphertext>", all base64url.

function key() {
  const hex = env.twoFactorEncryptionKey;
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) {
    throw new ServiceUnavailableError({
      message: "Two-factor authentication is not configured on this server.",
    });
  }
  return Buffer.from(hex, "hex");
}

export function seal(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const parts = [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url"));
  return `v1:${parts.join(":")}`;
}

export function open(sealed) {
  const [version, iv, tag, data] = sealed.split(":");
  if (version !== "v1") throw new Error("Unknown sealed-secret format.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
