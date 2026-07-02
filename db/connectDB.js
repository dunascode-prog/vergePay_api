import { Pool } from "pg";
import env from "../env.js";

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
