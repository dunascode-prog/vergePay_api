import authRouter from "./authRoutes.js";
import express from "express";

export default function registerRoutes(app) {
  app.use("/v1/auth", authRouter);
}
