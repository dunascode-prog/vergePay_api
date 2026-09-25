import express from "express";
import { getMe, updateMe } from "../controllers/userController.js";
import { verifyAccessToken } from "../utils/jwt.js";

const userRouter = express.Router();

// Only "/me": a user can read or change their own profile, never another
// user's by id (API doc 3.1).
userRouter.get("/me", verifyAccessToken, getMe);
userRouter.patch("/me", verifyAccessToken, updateMe);

export default userRouter;
