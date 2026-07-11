import { pool } from "../db/connectDB.js";
import bcrypt from "bcrypt";
import z from "zod";
import logger from "../logger.js";
import crypto from "crypto";
import AppError from "../utils/appError.js";
import {
  BadRequestError,
  ValidationError,
  ConflictError,
  ForbiddenError,
} from "../utils/errorStr.js";

export const registerUser = async (req, res, next) => {
  if (!req.body) {
    const err = new BadRequestError({
      message: "Request body is empty.",
      details: {
        body: "Request body cannot be empty. Expected a JSON payload.",
      },
    });
    throw err;
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
    const err = new ValidationError({
      details: validation.error.flatten().fieldErrors,
    });
    throw err;
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
    const err = new ConflictError({
      message: "A user with this email already exists",
    });
    throw err;
  }
  const usernameExist = await pool.query(
    `SELECT user_id
  FROM users
  WHERE username=$1`,
    [username],
  );
  if (usernameExist.rowCount > 0) {
    const err = new ConflictError({
      message: "A user with this username already exists",
    });
    throw err;
  }
  const hashedPassword = await bcrypt.hash(password, 12);
  const requestHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(req.body))
    .digest("hex");

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
    requestId: req.requestId,
    email,
  });

  return res.status(201).json(response);
  next();
};

export const signUp = async (req, res, nex) => {
  if (!req.body) {
    const err = new BadRequestError({
      message: "Request body is empty.",
      details: {
        body: "Request body cannot be empty. Expected a JSON payload.",
      },
    });
    throw err;
  }

  const registerSchema = z
    .object({
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
      confirmPassword: z.string(),
    })
    .refine((data) => data.password === data.confirmPassword, {
      message: "Passwords do not match.",
      path: ["confirmPassword"],
    });
  const validation = registerSchema.safeParse(req.body);
  if (!validation.success) {
    const err = new ValidationError({
      details: validation.error.flatten().fieldErrors,
    });
    throw err;
  }
  const { username, email, password } = validation.data;
  // const emailExist = await pool.query(
  //   `SELECT user_id
  // FROM users
  // WHERE email=$1`,
  //   [email],
  // );
  // if (emailExist.rowCount > 0) {
  //   const err = new ConflictError({
  //     message: "A user with this email already exists",
  //   });
  //   throw err;
  // }
  // const usernameExist = await pool.query(
  //   `SELECT user_id
  // FROM users
  // WHERE username=$1`,
  //   [username],
  // );
  // if (usernameExist.rowCount > 0) {
  //   const err = new ConflictError({
  //     message: "A user with this username already exists",
  //   });
  //   throw err;
  // }
  const hashedPassword = await bcrypt.hash(password, 12);
  const requestHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(req.body))
    .digest("hex");

  try {
    const result = await pool.query(
      `
      INSERT INTO users (
          username,
          email,
          password_hash
      )
      VALUES (
          $1, $2, $3
      )
      RETURNING
          user_id,
          username,
          email `,
      [username, email, hashedPassword],
    );

    const response = await {
      user_id: result.rows[0].user_id,
      username: result.rows[0].username,
      email: result.rows[0].email,
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

    logger.info("account created", {
      idempotencyKey: req.idempotencyKey,
      requestId: req.requestId,
      email,
    });

    return res.status(201).json(response);
    next();
  } catch (err) {
    switch (err.code) {
      case "23505":
        const match = err.constraint.match(/users_(.+?)_key/);
        if (match) {
          const fieldName = match[1];
          throw new ConflictError({
            message: `${fieldName} already exists`,
            field: `${fieldName}`,
          });
        }
        throw new ConflictError({
          message: "A resource with the same unique value already exists.",
        });

      case "23503":
        throw new BadRequestError({
          message: "Referenced resource does not exist.",
        });

      case "23502":
        throw new ValidationError({
          message: "One or more required fields are missing.",
        });

      case "23514":
        throw new ValidationError({
          message: "One or more values violate business rules.",
        });

      case "23P01":
        throw new ConflictError({
          message: "Operation conflicts with an existing record.",
        });

      case "22P02":
        throw new BadRequestError({ message: "Invalid input format." });

      case "22001":
        throw new ValidationError({
          message: "One or more fields exceed the maximum length.",
        });

      case "22003":
        throw new ValidationError({
          message: "Numeric value is out of range.",
        });

      case "22007":
        throw new ValidationError({ message: "Invalid date or time format." });

      case "22008":
        throw new ValidationError({
          message: "Date or time value is invalid.",
        });

      case "40001":
        throw new DatabaseError({
          message: "Transaction could not be completed. Please retry.",
        });

      case "40P01":
        throw new DatabaseError({ message: "Database deadlock detected." });

      case "08000":
      case "08003":
      case "08006":
      case "08001":
        throw new ServiceUnavailableError({
          message: "Database connection unavailable.",
        });

      case "42501":
        throw new ForbiddenError({ message: "Database permission denied." });

      default:
        throw err;
    }
  }
};
