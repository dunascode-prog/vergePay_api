import express from "express";
import { registerUser } from "../controllers/authController.js";
import { idempotency } from "../utils/idempotency.js";

const authRouter = express.Router();

authRouter.get("/register", idempotency, registerUser);
export default authRouter;
