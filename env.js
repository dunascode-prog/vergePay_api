import dotenv from "dotenv";
dotenv.config();

const required = ["JWT_SECRET_KEY", "JWT_REFRESH_KEY", "DATABASE_URI"];

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
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    accessExpiry: process.env.JWT_ACCESS_EXPIRY || "15m",
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || "7d",
  },
  security: {
    maxFailedLoginAttempts:
      parseInt(process.env.MAX_FAILED_LOGIN_ATTEMPTS, 10) || 5,
    lockoutDurationMinutes:
      parseInt(process.env.LOCKOUT_DURATION_MINUTES, 10) || 15,
  },
  ai: {
    apiKey: process.env.OLLAMA_KEY,
    model: process.env.OLLAMA_MODEL || "claude-sonnet-4-6",
  },
  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:3000",
};
export default env;
