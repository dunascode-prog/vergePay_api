import winston from "winston";
import env from "./env.js";

const SENSITIVE_KEYS = [
  "password",
  "passwordHash",
  "token",
  "accessToken",
  "refreshToken",
  "authorization",
];

function redact(info) {
  if (Array.isArray(info)) {
    return info.map(redact);
  }

  if (info && typeof info === "object") {
    for (const [key, value] of Object.entries(info)) {
      if (SENSITIVE_KEYS.includes(key)) {
        info[key] = "[REDACTED]";
      } else {
        info[key] = redact(value);
      }
    }
  }

  return info;
}

const logger = winston.createLogger({
  level: env.nodeEnv === "production" ? "info" : "debug",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format((info) => {
      return redact(info);
    })(),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "logs/error.log", level: "error" }),
    new winston.transports.File({ filename: "logs/combined.log" }),
  ],
});

export default logger;
