import express from "express";
import { askAssistant, assistantSuggestions, dismissRecommendation, listRecommendations } from "../controllers/assistantController.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { assistantLimiter } from "../utils/rateLimiters.js";

// "Ask VergePay" and the recommendations (controllers/assistantController.js).
export const assistantRouter = express.Router();
assistantRouter.post("/ask", verifyAccessToken, assistantLimiter, askAssistant);
assistantRouter.get("/suggestions", verifyAccessToken, assistantSuggestions);

export const recommendationRouter = express.Router();
recommendationRouter.get("/", verifyAccessToken, listRecommendations);
recommendationRouter.post("/:key/dismiss", verifyAccessToken, dismissRecommendation);
