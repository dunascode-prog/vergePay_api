import { pool } from "../db/connectDB.js";
import { BadRequestError } from "./errorStr.js";

export const idempotency = async (req, res, next) => {
  const key = req.header("Idempotency-Key");

  if (!key) {
    throw new BadRequestError({
      message: "Idempotency-Key header is required.",
    });
  }

  const existingIdemKey = await pool.query(
    `
        SELECT status_code, response
        FROM idempotency_keys
        WHERE key = $1
          AND expires_at > NOW()
        `,
    [key],
  );
  if (existingIdemKey.rowCount > 0) {
    return res
      .status(existingIdemKey.rows[0].status_code)
      .json(existingIdemKey.rows[0].response);
  }
  req.idempotencyKey = key;
  next();
};
