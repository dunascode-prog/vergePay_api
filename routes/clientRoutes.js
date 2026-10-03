import express from "express";
import { archiveClient, createClient, getClient, listClients, updateClient } from "../controllers/clientController.js";
import { verifyAccessToken } from "../utils/jwt.js";

// The client book: who a customer invoices.
const clientRouter = express.Router();

clientRouter.use(verifyAccessToken);
clientRouter.post("/", createClient);
clientRouter.get("/", listClients);
clientRouter.get("/:clientId", getClient);
clientRouter.patch("/:clientId", updateClient);
clientRouter.delete("/:clientId", archiveClient);

export default clientRouter;
