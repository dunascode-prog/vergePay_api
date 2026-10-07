import express from "express";
import { getMe, updateMe } from "../controllers/userController.js";
import { cancelEmailChange, confirmEmailChange, startEmailChange } from "../controllers/emailChangeController.js";
import { emailChangeLimiter } from "../utils/rateLimiters.js";
import { verifyAccessToken } from "../utils/jwt.js";

const userRouter = express.Router();

// Only "/me": a user can read or change their own profile, never another
// user's by id (API doc 3.1).
userRouter.get("/me", verifyAccessToken, getMe);
userRouter.patch("/me", verifyAccessToken, updateMe);

// Changing the email: password (and a recent 2FA code if on), then a code
// sent to the new address.
userRouter.post("/me/email", verifyAccessToken, emailChangeLimiter, startEmailChange);
userRouter.post("/me/email/confirm", verifyAccessToken, emailChangeLimiter, confirmEmailChange);
userRouter.delete("/me/email", verifyAccessToken, cancelEmailChange);

export default userRouter;
