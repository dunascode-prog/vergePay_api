import { open, seal } from "../utils/secretBox.js";

// A minimal secrets vault in the database (data model 4.14: store "a
// reference/handle into a secrets vault", never the token itself). Secrets
// are AES-256-GCM encrypted with VAULT_ENCRYPTION_KEY, and callers only
// ever hold the reference. Swapping this for a managed vault (AWS Secrets
// Manager, HashiCorp Vault) would change only this file.
//
// Pass the DB client when the write must commit with other changes.

export async function storeSecret(db, purpose, plaintext) {
  const result = await db.query(
    `INSERT INTO vault_secrets (purpose, ciphertext) VALUES ($1, $2) RETURNING secret_ref`,
    [purpose, seal(plaintext, "vault")],
  );
  return `vault:${result.rows[0].secret_ref}`;
}

export async function readSecret(db, reference) {
  const result = await db.query(`SELECT ciphertext FROM vault_secrets WHERE secret_ref = $1`, [
    reference.replace(/^vault:/, ""),
  ]);
  if (result.rowCount === 0) return null;
  return open(result.rows[0].ciphertext, "vault");
}

// Destroys the secret for good: there is nothing left to decrypt. A
// reference that isn't a vault one (e.g. a shared test link's) holds nothing.
export async function destroySecret(db, reference) {
  if (!reference?.startsWith("vault:")) return;
  await db.query(`DELETE FROM vault_secrets WHERE secret_ref = $1`, [reference.replace(/^vault:/, "")]);
}
