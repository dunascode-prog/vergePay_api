import { pool } from "../db/connectDB.js";
import logger from "../logger.js";
export const idempotency = async (req, res, next) => {
  const key = req.header("Idempotency-Key");

  try {
    if (!key) {
      const err = new Error("Idempotency Key Missing");
      logger.info("missing Idempotency Key", err);
      throw err;
    }
  } catch (err) {
    next(err);
  }
  const existingIdemKey = await pool.query(
    `
        SELECT *
        FROM idempotency_keys
        WHERE key = $1
        `,
    [key],
  );
  if (existingIdemKey.rowCount > 0) {
    return res
      .status(parseInt(existingIdemKey.rows[0].status_code))
      .json(existingIdemKey.rows[0].response);
  }
  req.idempotencyKey = key;
  next();
};
