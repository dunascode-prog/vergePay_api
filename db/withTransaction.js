import { pool } from "./connectDB.js";
import logger from "../logger.js";

// Runs fn(client) inside BEGIN/COMMIT on one pooled connection, rolling back
// if it throws. Every query that must succeed or fail together goes through
// the client passed to fn.
//
// client.afterCommit(callback) queues work that must only happen once the
// data is really committed, such as telling a browser "money arrived"
// (services/realtime.js). Callbacks run after COMMIT and are dropped on
// ROLLBACK; one failing never affects the transaction or the others.
export async function withTransaction(fn) {
  const client = await pool.connect();
  const afterCommit = [];
  client.afterCommit = (callback) => afterCommit.push(callback);
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    afterCommit.length = 0;
    await client.query("ROLLBACK");
    throw err;
  } finally {
    // pooled clients are reused, so don't leave the hook on for the next caller
    delete client.afterCommit;
    client.release();
    for (const callback of afterCommit) {
      Promise.resolve()
        .then(callback)
        .catch((err) => logger.error({ message: "after-commit callback failed", error: err.message }));
    }
  }
}
