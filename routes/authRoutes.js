import express from "express";
import { registerUser, signUp } from "../controllers/authController.js";
import { idempotency } from "../utils/idempotency.js";

const authRouter = express.Router();

authRouter.post("/register", idempotency, registerUser);
authRouter.post("/sign-up", idempotency, signUp);
export default authRouter;
