import pg, { Pool } from "pg";
import env from "../env.js";

// BIGINT (int8) comes back from pg as a string. Money is stored as BIGINT
// minor units, so return it as a number, and fail loudly rather than lose
// precision past Number.MAX_SAFE_INTEGER (about 90 trillion naira).
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`BIGINT value ${value} exceeds the safe integer range.`);
  }
  return number;
});

let pool;
export default async () => {
  try {
    pool = await new Pool({
      connectionString: env.databaseUrl,
      ssl: {
        rejectUnauthorized: false,
      },
    });
    await pool.query("");
    console.log("DB connection successful...");
  } catch (err) {
    console.log(err);
  }
};

export { pool };
