import pg from "pg";
import dotenv from "dotenv";
import fs from "fs/promises";

dotenv.config();
async function loadSql(path) {
  return await fs.readFile(path, "utf8");
}

const { Pool } = pg;
const DB = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
});

const createCountries = await loadSql("db/migrations.db/countries.sql");
const createCurrencies = await loadSql("db/migrations.db/currencies.sql");
const createTimezones = await loadSql("db/migrations.db/timezones.sql");
const createUsers = await loadSql("db/migrations.db/users.sql");
const createAccount = await loadSql("db/migrations.db/account.sql");
const createAuditLog = await loadSql("db/migrations.db/audit_log.sql");
const createCardProvider = await loadSql("db/migrations.db/card_providers.sql");
const createCard = await loadSql("db/migrations.db/cards.sql");
const createexternalBrokerage = await loadSql(
  "db/migrations.db/external_brokerage_link.sql",
);
const createTransaction = await loadSql("db/migrations.db/transactions.sql");
const createHolding = await loadSql("db/migrations.db/holdings.sql");
const createInvoice = await loadSql("db/migrations.db/invoice.sql");
const createKycVerification = await loadSql(
  "db/migrations.db/kyc_verification.sql",
);
const createLedger = await loadSql("db/migrations.db/ledger_entries.sql");
const createLoanRepaymentSchedule = await loadSql(
  "db/migrations.db/loan_repayment_schedule.sql",
);
const createLoan = await loadSql("db/migrations.db/loan.sql");
const createSecurities = await loadSql("db/migrations.db/securities.sql");
const initCountries = await loadSql("db/seeds.db/countryseed.sql");
const initCurrency = await loadSql("db/seeds.db/currencyseed.sql");
const initTimezone = await loadSql("db/seeds.db/timezoneseed.sql");

export default async function initDB() {
  // await DB.query(createCountries);
  // await DB.query(createCurrencies);
  // await DB.query(createTimezones);
  // await DB.query(createUsers);
  // await DB.query(initCountries);
  // await DB.query(initCurrency);
  // await DB.query(initTimezone);
  // await DB.query(createKycVerification);
  // await DB.query(createAccount);
  // await DB.query(createAuditLog);
  // await DB.query(createCardProvider);
  // await DB.query(createCard);
  // await DB.query(createSecurities);
  // await DB.query(createexternalBrokerage);
  // await DB.query(createHolding);
  // await DB.query(createInvoice);
  // await DB.query(createTransaction);
  // await DB.query(createLoan);
  // await DB.query(createKycVerification);
  // await DB.query(createLedger);
  // await DB.query(createLoanRepaymentSchedule);
  await DB.query(createLoan);

  console.log("created... ");
}
