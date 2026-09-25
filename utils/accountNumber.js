import crypto from "crypto";

// NUBAN (Nigeria Uniform Bank Account Number): a 9-digit serial followed by
// a check digit computed together with the bank's code. VergePay has no CBN
// bank code, so a placeholder code is used; swap it in once one is assigned.
const BANK_CODE = "999";
const WEIGHTS = [3, 7, 3, 3, 7, 3, 3, 7, 3, 3, 7, 3];

export function nubanCheckDigit(bankCode, serial) {
  const digits = `${bankCode}${serial}`.split("").map(Number);
  const sum = digits.reduce((total, digit, i) => total + digit * WEIGHTS[i], 0);
  return (10 - (sum % 10)) % 10;
}

export function isValidNuban(accountNumber, bankCode = BANK_CODE) {
  if (!/^\d{10}$/.test(accountNumber)) return false;
  const serial = accountNumber.slice(0, 9);
  return nubanCheckDigit(bankCode, serial) === Number(accountNumber[9]);
}

// Random, not sequential, so account numbers don't reveal how many accounts
// exist. Uniqueness is enforced by the database; callers retry on collision.
export function generateAccountNumber() {
  const serial = String(crypto.randomInt(0, 1_000_000_000)).padStart(9, "0");
  return `${serial}${nubanCheckDigit(BANK_CODE, serial)}`;
}
