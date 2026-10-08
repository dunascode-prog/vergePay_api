import express from "express";
import { getMe, updateMe } from "../controllers/userController.js";
import { cancelEmailChange, confirmEmailChange, startEmailChange } from "../controllers/emailChangeController.js";
import { getPhoto, removePhoto, uploadPhoto } from "../controllers/profilePhotoController.js";
import env from "../env.js";
import { emailChangeLimiter, photoLimiter } from "../utils/rateLimiters.js";
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

// Profile photo: the image itself is the body (JPG or PNG, 2 MB at most).
// Any other Content-Type leaves the body unparsed, and the controller says so.
userRouter.put(
  "/me/photo",
  verifyAccessToken,
  photoLimiter,
  express.raw({ type: ["image/jpeg", "image/png"], limit: env.photos.maxBytes }),
  uploadPhoto,
);
userRouter.delete("/me/photo", verifyAccessToken, photoLimiter, removePhoto);
// the photo itself, to its owner only (photo_url in the profile)
userRouter.get("/me/photo/:photoId", verifyAccessToken, getPhoto);

export default userRouter;
