import express from "express";
import { test } from "../controllers/authController.js";
import { verifyAccessToken } from "../utils/jwt.js";

const testRoute = express.Router();

testRoute.get("/test", verifyAccessToken, test);

export default testRoute;
