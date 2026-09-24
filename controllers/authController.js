import { pool } from "../db/connectDB.js";
import bcrypt from "bcrypt";
import z from "zod";
import logger from "../logger.js";
import crypto from "crypto";
import AppError from "../utils/appError.js";
import env from "../env.js";
import {
  BadRequestError,
  ValidationError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  DatabaseError,
  ServiceUnavailableError,
} from "../utils/errorStr.js";
import { createAccessToken, createRefreshToken } from "../utils/jwt.js";
import jwt from "jsonwebtoken";

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
          email,
          created_at `,
      [username, email, hashedPassword],
    );

    const response = await {
      user_id: result.rows[0].user_id,
      username: result.rows[0].username,
      email: result.rows[0].email,
      created_at: result.rows[0].created_at,
    };
    // await pool.query(
    //   `
    //     INSERT INTO idempotency_keys
    //     (
    //     key,
    //     request_hash,
    //     response,
    //     status_code,
    //     expires_at
    //     )
    //     VALUES
    //     ($1,$2,$3,$4,NOW()+INTERVAL '24 HOURS')
    //     `,
    //   [req.idempotencyKey, requestHash, response, 201],
    // );

    // logger.info("account created", {
    //   idempotencyKey: req.idempotencyKey,
    //   requestId: req.requestId,
    //   email,
    // });

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

export const signIn = async (req, res, next) => {
  if (!req.body) {
    const err = new BadRequestError({
      message: "Request body is empty.",
      details: {
        body: "Request body cannot be empty. Expected a JSON payload.",
      },
    });
    throw err;
  }

  const signinSchema = z.object({
    email: z.string().trim().toLowerCase().email("Invalid email address."),
    password: z.string().min(1, "Password is required."),
  });
  const validation = signinSchema.safeParse(req.body);
  if (!validation.success) {
    const err = new ValidationError({
      details: validation.error.flatten().fieldErrors,
    });
    throw err;
  }
  const { email, password } = validation.data;

  let user = await pool.query(
    `SELECT
    user_id,
    email,
    password_hash
    FROM users
    WHERE email = $1
    `,
    [email.toLowerCase()],
  );

  if (user.rowCount === 0) {
    throw new UnauthorizedError({
      message: "Invalid email or password",
    });
  }

  user = user.rows[0];

  const verify = await bcrypt.compare(password, user.password_hash);
  if (!verify) {
    throw new UnauthorizedError({
      message: "Invalid email or password",
    });
  }

  const payload = { sub: user.user_id, email: user.email };
  const { accessSecret, refreshSecret, accessExpiry, refreshExpiry } =
    env.jwtdet;
  const accessToken = createAccessToken(payload, accessSecret, accessExpiry);
  const refreshToken = createRefreshToken(
    payload,
    refreshSecret,
    refreshExpiry,
  );

  const tokenHash = crypto
    .createHash("sha256")
    .update(refreshToken)
    .digest("hex");

  await pool.query(
    `
    INSERT INTO refresh_tokens (
        user_id,
        token_hash,
        expires_at
    )
    VALUES ($1, $2, NOW() + INTERVAL '30 days')
  `,
    [user.user_id, tokenHash],
  );

  res.cookie("access_token", accessToken, {
    httpOnly: true,
    secure: env.nodeEnv === "production",
    sameSite: "strict",
    maxAge: 15 * 60 * 1000,
  });

  res.cookie("refresh_token", refreshToken, {
    httpOnly: true,
    secure: env.nodeEnv === "production",
    sameSite: "strict",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });

  return res.status(200).json({
    success: true,
    message: "Login successful.",
    user: {
      user_id: user.user_id,
      username: user.username,
      email: user.email,
      kyc_status: user.kyc_status,
    },
  });
};

export function test(req, res, next) {
  console.log("test");
  return res.status(200).json(req.user);
}

export async function refreshToken(req, res, next) {
  const refreshToken = req.cookies["refresh_token"];

  if (!refreshToken) {
    throw new UnauthorizedError({ message: "Refresh token missing." });
  }

  let payload;

  try {
    payload = jwt.verify(refreshToken, env.jwtdet.refreshSecret);
  } catch (err) {
    console.log(err);
    throw new UnauthorizedError({
      message: "Refresh token expired or invalid.",
    });
  }

  const tokenHash = crypto
    .createHash("sha256")
    .update(refreshToken)
    .digest("hex");

  const storedToken = await pool.query(
    `
    SELECT
        refresh_token_id,
        user_id,
        expires_at,
        revoked_at
    FROM refresh_tokens
    WHERE token_hash = $1
    LIMIT 1;
    `,
    [tokenHash],
  );

  if (storedToken.rowCount === 0) {
    throw new ForbiddenError({ message: "Refresh token has been revoked." });
  }
  const user = await pool.query(
    `SELECT
    user_id,
    email
FROM users
WHERE user_id = $1;
  `,
    [storedToken.rows[0].user_id],
  );

  if (user.rowCount === 0) {
    throw new UnauthorizedError({ message: "User not found." });
  }

  const pay_l = user.rows[0];

  const newAccessToken = createAccessToken(
    {
      sub: pay_l.user_id,
      email: pay_l.email,
    },
    env.jwtdet.accessSecret,
    env.jwtdet.accessExpiry,
  );

  const newRefreshToken = createRefreshToken(
    {
      sub: pay_l.user_id,
      email: pay_l.email,
    },
    env.jwtdet.refreshSecret,
    env.jwtdet.refreshExpiry,
  );

  await pool.query(
    `
  DELETE FROM refresh_tokens
  WHERE token_hash = $1;
  `,
    [tokenHash],
  );

  const newRefreshHash = crypto
    .createHash("sha256")
    .update(newRefreshToken)
    .digest("hex");

  const result = await pool.query(
    `
  INSERT INTO refresh_tokens (
      user_id,
      token_hash,
      expires_at
  )
  VALUES (
      $1,
      $2,
      NOW() + INTERVAL '30 days'
  )
  RETURNING *;
  `,
    [pay_l.user_id, newRefreshHash],
  );

  res.cookie("access_token", newAccessToken, {
    httpOnly: true,
    secure: env.nodeEnv === "production",
    sameSite: "strict",
    maxAge: 15 * 60 * 1000,
  });

  res.cookie("refresh_token", newRefreshToken, {
    httpOnly: true,
    secure: env.nodeEnv === "production",
    sameSite: "strict",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });

  res.status(200).json({
    success: true,
    message: "Access token refreshed successfully.",
  });
}
