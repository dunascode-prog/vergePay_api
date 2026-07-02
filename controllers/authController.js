import { pool } from "../db/connectDB.js";
import bcrypt from "bcrypt";

export const registerUser = async (req, res) => {
  if (!req.body) {
    return res.status(400).json({
      mesage: "request body empty",
    });
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
  } = await req.body;

  if (
    !username ||
    !email ||
    !password ||
    !first_name ||
    !last_name ||
    !present_addr ||
    !permanent_addr ||
    !date_of_birth ||
    !city ||
    !postal_code ||
    !country_code ||
    !default_currency_code ||
    !timezone
  ) {
    return res.status(400).json({
      status: "failed",
      message: "incomplete Body",
    });
  }
  const emailExist = await pool.query(
    `SELECT *
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
    return res.status(201).json({
      user_id: result.rows[0].user_id,
      email: result.rows[0].email,
      kyc_status: result.rows[0].kyc_status,
      account_status: result.rows[0].account_status,
      two_factor_enabled: result.rows[0].two_factor_enabled,
      created_at: result.rows[0].created_at,
    });
  } catch (err) {
    console.log(err);
  }
};
