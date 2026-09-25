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
  NotFoundError,
  UnauthorizedError,
  DatabaseError,
  ServiceUnavailableError,
} from "../utils/errorStr.js";
import { verifyRefreshToken } from "../utils/jwt.js";
import { endSession, hashToken, issueSession } from "../utils/session.js";

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

    // Signup never creates a session: end any session already in this
    // browser so the new user must sign in explicitly.
    await endSession(req, res);

    return res.status(201).json(response);
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
    username,
    email,
    password_hash,
    kyc_status
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

  await issueSession(res, user);

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

  try {
    verifyRefreshToken(refreshToken);
  } catch (err) {
    throw new UnauthorizedError({
      message: "Refresh token expired or invalid.",
    });
  }

  // Consume the stored token in one statement so it can only be used once,
  // even if two refresh requests race each other.
  const consumed = await pool.query(
    `
    DELETE FROM refresh_tokens
    WHERE token_hash = $1
      AND revoked_at IS NULL
      AND expires_at > NOW()
    RETURNING user_id;
    `,
    [hashToken(refreshToken)],
  );

  if (consumed.rowCount === 0) {
    throw new UnauthorizedError({
      message: "Refresh token has been revoked or has expired.",
    });
  }

  const user = await pool.query(
    `SELECT user_id, email FROM users WHERE user_id = $1;`,
    [consumed.rows[0].user_id],
  );

  if (user.rowCount === 0) {
    throw new UnauthorizedError({ message: "User not found." });
  }

  await issueSession(res, user.rows[0]);

  res.status(200).json({
    success: true,
    message: "Access token refreshed successfully.",
  });
}

export async function logout(req, res, next) {
  // Works even when the access token has expired, so a user can always sign
  // out; calling it with no session is a harmless no-op.
  await endSession(req, res);

  return res.status(200).json({
    success: true,
    message: "Logged out.",
  });
}
