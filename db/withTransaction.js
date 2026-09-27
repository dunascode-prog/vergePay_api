import { pool } from "./connectDB.js";

// Runs fn(client) inside BEGIN/COMMIT on one pooled connection, rolling back
// if it throws. Every query that must succeed or fail together goes through
// the client passed to fn.
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
