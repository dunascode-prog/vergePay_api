import express from "express";
import { getKycSubmission, listKycSubmissions, submitKyc } from "../controllers/kycController.js";
import { optionalIdempotency } from "../utils/idempotency.js";
import { verifyAccessToken } from "../utils/jwt.js";

// Identity verification (API doc 3.2)
const kycRouter = express.Router();

kycRouter.use(verifyAccessToken);
kycRouter.post("/submissions", optionalIdempotency, submitKyc);
kycRouter.get("/submissions", listKycSubmissions);
kycRouter.get("/submissions/:kycId", getKycSubmission);

export default kycRouter;
