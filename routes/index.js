import authRouter from "./authRoutes.js";
import express from "express";
import { idempotency } from "../utils/idempotency.js";
import { registerLimiter } from "../utils/rateLimiters.js";
export default function registerRoutes(app) {
  app.use("/v1/auth", registerLimiter, authRouter);
}
//remove idempotency from here and place it in the exacts routes that would need it
