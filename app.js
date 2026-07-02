import express from "express";
import registerRoutes from "./routes/index.js";
import connectDB from "./db/connectDB.js";
import logger from "./logger.js";

const app = express();
app.use(express.json());
await connectDB();
registerRoutes(app);
//note logging is used only to classify the bugs mainly so developers can classify errors to developer or production
export default app;
