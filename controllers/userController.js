import z from "zod";
import { pool } from "../db/connectDB.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../utils/errorStr.js";

// DATE is formatted in SQL so it is returned as "YYYY-MM-DD" rather than a
// timezone-shifted JS Date.
const PROFILE_COLUMNS = `
    user_id,
    username,
    email,
    first_name,
    last_name,
    to_char(date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
    present_address,
    permanent_address,
    city,
    postal_code,
    country_code,
    default_currency_code,
    timezone,
    kyc_status,
    two_factor_enabled,
    created_at,
    updated_at`;

// Identity fields are frozen once KYC is under review or verified, so the
// verified identity can't be edited afterwards.
const IDENTITY_FIELDS = ["first_name", "last_name", "date_of_birth"];
const KYC_LOCKED_STATUSES = ["pending", "verified"];

const MIN_AGE_YEARS = 18;

function isAtLeastAge(dateString, years) {
  const dob = new Date(`${dateString}T00:00:00Z`);
  // an unparseable date is already reported by the format check
  if (Number.isNaN(dob.getTime())) return true;
  const cutoff = new Date();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
  return dob <= cutoff;
}

// Email and password are deliberately absent: they get their own verified
// flows (API doc 3.1). Unknown keys are rejected rather than ignored.
const updateProfileSchema = z
  .strictObject({
    first_name: z.string().trim().min(1).max(80),
    last_name: z.string().trim().min(1).max(80),
    date_of_birth: z.iso
      .date("Use the format YYYY-MM-DD.")
      .refine((value) => isAtLeastAge(value, MIN_AGE_YEARS), {
        message: `You must be at least ${MIN_AGE_YEARS} years old.`,
      }),
    present_address: z.string().trim().min(1).max(255),
    permanent_address: z.string().trim().min(1).max(255),
    city: z.string().trim().min(1).max(100),
    postal_code: z.string().trim().min(1).max(20).nullable(),
    country_code: z.string().trim().toUpperCase().length(2),
    default_currency_code: z.string().trim().toUpperCase().length(3),
    timezone: z.string().trim().min(1).max(100),
  })
  .partial();

// Maps a failed foreign key back to the request field that caused it.
const FK_FIELDS = {
  fk_country: "country_code",
  fk_currency: "default_currency_code",
  fk_timezone: "timezone",
};

function validationDetails(error) {
  const details = { ...error.flatten().fieldErrors };
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        details[key] = ["This field cannot be updated here."];
      }
    }
  }
  return details;
}

export async function getMe(req, res) {
  const result = await pool.query(
    `SELECT ${PROFILE_COLUMNS} FROM users WHERE user_id = $1`,
    [req.user.sub],
  );

  if (result.rowCount === 0) {
    throw new NotFoundError({ message: "User not found." });
  }

  return res.status(200).json(result.rows[0]);
}

export async function updateMe(req, res) {
  if (!req.body || Object.keys(req.body).length === 0) {
    throw new BadRequestError({
      message: "Request body is empty.",
      details: { body: "Send at least one profile field to update." },
    });
  }

  const validation = updateProfileSchema.safeParse(req.body);
  if (!validation.success) {
    throw new ValidationError({ details: validationDetails(validation.error) });
  }
  const updates = validation.data;
  const fields = Object.keys(updates);

  const current = await pool.query(
    `SELECT kyc_status FROM users WHERE user_id = $1`,
    [req.user.sub],
  );
  if (current.rowCount === 0) {
    throw new NotFoundError({ message: "User not found." });
  }

  const lockedField = fields.find((field) => IDENTITY_FIELDS.includes(field));
  if (lockedField && KYC_LOCKED_STATUSES.includes(current.rows[0].kyc_status)) {
    throw new ConflictError({
      message:
        "Name and date of birth can't be changed after identity verification has started.",
      field: lockedField,
    });
  }

  // Column names come only from the schema's whitelist above; values are
  // always passed as parameters.
  const setClause = fields
    .map((field, index) => `${field} = $${index + 2}`)
    .join(", ");

  try {
    const result = await pool.query(
      `UPDATE users SET ${setClause} WHERE user_id = $1 RETURNING ${PROFILE_COLUMNS}`,
      [req.user.sub, ...fields.map((field) => updates[field])],
    );
    return res.status(200).json(result.rows[0]);
  } catch (err) {
    const field = err.code === "23503" && FK_FIELDS[err.constraint];
    if (field) {
      throw new ValidationError({
        details: { [field]: ["This value is not supported."] },
      });
    }
    throw err;
  }
}
