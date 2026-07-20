import authRouter from "./authRoutes.js";
import express from "express";
import { idempotency } from "../utils/idempotency.js";
import testRoute from "./testRoute.js";

export default function registerRoutes(app) {
  app.use("/v1/auth", authRouter);
  app.use("/v1/dashboard", testRoute);
}
//remove idempotency from here and place it in the exacts routes that would need it
