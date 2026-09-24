import pg from "pg";
import fs from "fs/promises";
import env from "../env.js";

// Order matters: every table must come after the tables its foreign keys
// reference. Every file is safe to re-run (IF NOT EXISTS / ON CONFLICT).
const files = [
  "migrations.db/countries.sql",
  "migrations.db/currencies.sql",
  "migrations.db/timezones.sql",
  "seeds.db/countryseed.sql",
  "seeds.db/currencyseed.sql",
  "seeds.db/timezoneseed.sql",
  "migrations.db/users.sql",
  "migrations.db/refresh_tokens.sql",
  "migrations.db/idempotency_keys.sql",
  "migrations.db/kyc_verification.sql",
  "migrations.db/account.sql",
  "migrations.db/audit_log.sql",
  "migrations.db/card_providers.sql",
  "migrations.db/cards.sql",
  "migrations.db/securities.sql",
  "migrations.db/external_brokerage_link.sql",
  "migrations.db/holdings.sql",
  "migrations.db/loan.sql",
  "migrations.db/transactions.sql",
  "migrations.db/loan_repayment_schedule.sql",
  "migrations.db/ledger_entries.sql",
  "migrations.db/invoice.sql",
];

const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  ssl: { rejectUnauthorized: false },
});

const client = await pool.connect();
try {
  await client.query("BEGIN");
  for (const file of files) {
    const sql = await fs.readFile(new URL(file, import.meta.url), "utf8");
    await client.query(sql);
    console.log(`applied ${file}`);
  }
  await client.query("COMMIT");
  console.log("database initialised.");
} catch (err) {
  await client.query("ROLLBACK");
  console.error("database init failed, rolled back:", err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
