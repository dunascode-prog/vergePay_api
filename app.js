import express from "express";
import registerRoutes from "./routes/index.js";
import connectDB from "./db/connectDB.js";
import logger from "./logger.js";
import { addRequestId } from "./utils/addRequestId.js";
import { handleErrors } from "./controllers/handleErrors.js";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: "http://localhost:3000",
    methods: ["GET", "POST", "DELETE", "PUT"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
  }),
);
await connectDB();
app.use(addRequestId);
registerRoutes(app);
app.use(handleErrors);
//note logging is used only to classify the bugs mainly so developers can classify errors to developer or production
export default app;
