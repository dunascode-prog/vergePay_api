import express from "express";
import registerRoutes from "./routes/index.js";
import connectDB from "./db/connectDB.js";
import logger from "./logger.js";
import { addRequestId } from "./utils/addRequestId.js";
import { idempotency } from "./utils/idempotency.js";

const app = express();
app.use(express.json());
await connectDB();
app.use(addRequestId);
app.use(idempotency);
registerRoutes(app);

//note logging is used only to classify the bugs mainly so developers can classify errors to developer or production
export default app;
