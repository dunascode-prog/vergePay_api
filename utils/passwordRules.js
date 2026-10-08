import z from "zod";

// One set of password rules for signing up and resetting a password.
export const passwordSchema = z
  .string()
  .min(12, "Password must be at least 12 characters.")
  .max(128)
  .regex(/[A-Z]/, "Password must contain an uppercase letter.")
  .regex(/[a-z]/, "Password must contain a lowercase letter.")
  .regex(/[0-9]/, "Password must contain a number.")
  .regex(/[!@#$%^&*(),.?":{}|<>_\-+=/\\[\]';`~]/, "Password must contain a special character.");

export const BCRYPT_ROUNDS = 12;
