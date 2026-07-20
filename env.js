import dotenv from "dotenv";
dotenv.config();

const required = ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "DATABASE_URI"];

for (const key of required) {
  if (!process.env[key] || process.env[key].startsWith("replace_with")) {
    console.error(
      `[config] Missing or placeholder env var: ${key}. Check your .env file.`,
    );
  }
}

const env = {
  port: parseInt(process.env.PORT, 10) || 4000,
  nodeEnv: process.env.NODE_ENV || "development",
  databaseUrl: process.env.DATABASE_URI,
  jwtdet: {
    accessSecret: process.env.JWT_ACCESS_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    accessExpiry: process.env.JWT_ACCESS_EXPIRY || "15m",
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || "3d",
  },
  security: {
    maxFailedLoginAttemptsSignIn:
      parseInt(process.env.MAX_FAILED_LOGIN_ATTEMPTS_SIGNIN, 10) || 5,
    lockoutDurationMinutesSignIn:
      parseInt(process.env.LOCKOUT_DURATION_MINUTES_SIGNIN, 10) || 15,
    maxFailedLoginAttemptsSignUp:
      parseInt(process.env.MAX_FAILED_LOGIN_ATTEMPTS_SIGNUP, 10) || 5,
    lockoutDurationMinutesSignUp:
      parseInt(process.env.LOCKOUT_DURATION_MINUTES_SIGNUP, 10) || 15,
  },
  ai: {
    apiKey: process.env.OLLAMA_KEY,
    model: process.env.OLLAMA_MODEL || "claude-sonnet-4-6",
  },
  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:3000",
};
export default env;
