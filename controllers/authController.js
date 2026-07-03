import { pool } from "../db/connectDB.js";
import bcrypt from "bcrypt";
import z from "zod";
import logger from "../logger.js";
import crypto from "crypto";

export const registerUser = async (req, res, next) => {
  if (!req.body) {
    return res.status(400).json({
      mesage: "request body empty",
    });
  }

  const registerSchema = z.object({
    username: z
      .string()
      .trim()
      .min(3, "Username must be at least 3 characters.")
      .max(30, "Username cannot exceed 30 characters.")
      .regex(
        /^[a-zA-Z0-9_]+$/,
        "Username may only contain letters, numbers and underscores.",
      ),

    email: z.string().trim().toLowerCase().email("Invalid email address."),
    password: z
      .string()
      .min(12, "Password must be at least 12 characters.")
      .max(128)
      .regex(/[A-Z]/, "Password must contain an uppercase letter.")
      .regex(/[a-z]/, "Password must contain a lowercase letter.")
      .regex(/[0-9]/, "Password must contain a number.")
      .regex(
        /[!@#$%^&*(),.?":{}|<>_\-+=/\\[\]';`~]/,
        "Password must contain a special character.",
      ),

    first_name: z.string().trim().min(2).max(80),

    last_name: z.string().trim().min(2).max(80),

    date_of_birth: z.string().date(),

    present_addr: z.string().trim().min(5).max(255),

    permanent_addr: z.string().trim().min(5).max(255),

    city: z.string().trim().min(2).max(100),

    postal_code: z.string().trim().max(20).optional(),

    country_code: z
      .string()
      .trim()
      .length(2, "Country code must be ISO-3166 alpha-2.")
      .toUpperCase(),

    default_currency_code: z
      .string()
      .trim()
      .length(3, "Currency must be ISO-4217.")
      .toUpperCase(),

    timezone: z.string().trim().min(3).max(50),
  });

  const validation = registerSchema.safeParse(req.body);

  if (!validation.success) {
    logger.error(validation.error.flatten().fieldErrors);
    return res
      .status(400)
      .json({ success: false, errors: validation.error.flatten().fieldErrors });
  }
  const {
    username,
    email,
    password,
    first_name,
    last_name,
    present_addr,
    permanent_addr,
    date_of_birth,
    city,
    postal_code,
    country_code,
    default_currency_code,
    timezone,
  } = validation.data;
  const emailExist = await pool.query(
    `SELECT user_id
  FROM users
  WHERE email=$1`,
    [email],
  );
  if (emailExist.rowCount > 0) {
    return res.status(409).json({
      success: false,
      message: "An account with this email already exists.",
    });
  }
  const usernameExist = await pool.query(
    `SELECT user_id
  FROM users
  WHERE username=$1`,
    [username],
  );
  if (usernameExist.rowCount > 0) {
    return res.status(409).json({
      status: "failed",
      message: "An account with this username already exists",
    });
  }
  const hashedPassword = await bcrypt.hash(password, 12);

  try {
    const result = await pool.query(
      `
      INSERT INTO users (
          username,
          email,
          password_hash,
          first_name,
          last_name,
          date_of_birth,
          present_addr,
          permanent_addr,
          city,
          postal_code,
          country_code,
          default_currency_code,
          timezone
      )
      VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, $12, $13
      )
      RETURNING
          user_id,
          username,
          email,
          kyc_status,
          account_status,
          two_factor_enabled,
          created_at; `,
      [
        username,
        email,
        hashedPassword,
        first_name,
        last_name,
        date_of_birth,
        present_addr,
        permanent_addr,
        city,
        postal_code,
        country_code,
        default_currency_code,
        timezone,
      ],
    );
    logger.info("Registering user", {
      requestId: req.requestId,
      email,
    });

    const requestHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(req.body))
      .digest("hex");
    const response = await {
      user_id: result.rows[0].user_id,
      email: result.rows[0].email,
      kyc_status: result.rows[0].kyc_status,
      account_status: result.rows[0].account_status,
      two_factor_enabled: result.rows[0].two_factor_enabled,
      created_at: result.rows[0].created_at,
    };
    await pool.query(
      `
        INSERT INTO idempotency_keys
        (
        key,
        request_hash,
        response,
        status_code,
        expires_at
        )
        VALUES
        ($1,$2,$3,$4,NOW()+INTERVAL '24 HOURS')
        `,
      [req.idempotencyKey, requestHash, response, 201],
    );
    logger.info("Registering user", {
      idempotencyKey: req.idempotencyKey,
      email,
    });

    return res.status(201).json(response);
  } catch (err) {
    logger.info("Internal DB err", err.message);
    const requestHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(req.body))
      .digest("hex");
    await pool.query(
      `
        INSERT INTO idempotency_keys
        (
        key,
        request_hash,
        response,
        status_code,
        expires_at
        )
        VALUES
        ($1,$2,$3,$4,NOW()+INTERVAL '24 HOURS')
        `,
      [req.idempotencyKey, requestHash, JSON.stringify(err), 201],
    );
    res.status(501).json({
      status: message,
      message: "Internal Server Error",
    });
  }
  next();
};
