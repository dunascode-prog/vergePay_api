import express from "express";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "../controllers/notificationController.js";
import { verifyAccessToken } from "../utils/jwt.js";

// In-app alerts. Live delivery is the WebSocket at /v1/ws
// (realtime/websocketServer.js); these endpoints are the durable copy.
const notificationRouter = express.Router();

notificationRouter.use(verifyAccessToken);
notificationRouter.get("/", listNotifications);
notificationRouter.post("/read-all", markAllNotificationsRead);
notificationRouter.post("/:notificationId/read", markNotificationRead);

export default notificationRouter;
