import { pool } from "../db/connectDB.js";

export const idempotency = async (req, res, next) => {
  const key = req.header("Idempotency-Key");

  if (!key) next();
  const existingIdemKey = pool.query(
    `
        SELECT *
        FROM idempotency_keys
        WHERE key = $1
        `,
    [key],
  );
  if (existingIdemKey.rowCount > 0) {
    return res
      .status(existing.rows[0].status_code)
      .json(existing.rows[0].response);
  }
  req.idempotencyKey = key;
  next();
};
