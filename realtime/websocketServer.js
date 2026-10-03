import jwt from "jsonwebtoken";
import { WebSocketServer } from "ws";
import env from "../env.js";
import logger from "../logger.js";
import { subscribeToUserEvents } from "../services/realtime.js";

// The live channel: GET /v1/ws, upgraded to a WebSocket. The server only
// pushes (see services/realtime.js for the events); anything the browser
// sends is ignored apart from keep-alive.
//
// Security:
//   - Origin must be the web app's (WS_ALLOWED_ORIGINS, default
//     CORS_ORIGIN), so another site can't
//     open a socket with the customer's cookies (cross-site WebSocket
//     hijacking). Browsers always send Origin; a request without one comes
//     from a non-browser client, which has to hold the cookie anyway.
//   - The same HttpOnly access_token cookie as every HTTP request, checked
//     the same way. A session still waiting for its 2FA code is refused.
//   - The access token is short-lived, so the socket is closed when it
//     expires (4401). The browser refreshes the session over HTTP and
//     reconnects, which re-checks everything.
//
// Close codes (application range 4000-4999):
//   4401  not signed in, or the session expired: refresh, then reconnect
//   4403  refused (2FA pending, or an invalid token): don't retry blindly
//   4429  too many open sockets for this user

export const WS_PATH = "/v1/ws";
const MAX_SOCKETS_PER_USER = 10;
const HEARTBEAT_MS = 30_000;
const jwtOptions = { issuer: "VergePay", audience: "vergepay-api" };

function readCookie(header, name) {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

// { payload } when the socket may open, { code, reason } when it must close.
export function authenticate(cookieHeader) {
  const token = readCookie(cookieHeader, "access_token");
  if (!token) return { code: 4401, reason: "Not signed in." };
  let payload;
  try {
    payload = jwt.verify(token, env.jwtdet.accessSecret, jwtOptions);
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) return { code: 4401, reason: "Session expired." };
    return { code: 4403, reason: "Invalid session." };
  }
  if (payload.tfa === "pending") return { code: 4403, reason: "Two-factor code required." };
  return { payload };
}

function refuseUpgrade(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** Serves /v1/ws on the given HTTP server. Returns { close, socketCount }. */
export function attachWebSocketServer(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const socketsByUser = new Map();
  const origins = new Set(env.wsAllowedOrigins);

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname !== WS_PATH) return refuseUpgrade(socket, 404, "Not Found");
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) {
      logger.warn({ message: "websocket refused: origin not allowed", origin });
      return refuseUpgrade(socket, 403, "Forbidden");
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws, req) => {
    // Auth failures are sent as close codes, not HTTP errors: a browser's
    // WebSocket can't see the HTTP status, only the close code.
    const auth = authenticate(req.headers.cookie);
    if (!auth.payload) return ws.close(auth.code, auth.reason);

    const userId = auth.payload.sub;
    const sockets = socketsByUser.get(userId) ?? new Set();
    if (sockets.size >= MAX_SOCKETS_PER_USER) return ws.close(4429, "Too many open connections.");
    sockets.add(ws);
    socketsByUser.set(userId, sockets);

    const expiry = setTimeout(() => ws.close(4401, "Session expired."), Math.max(0, auth.payload.exp * 1000 - Date.now()));
    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));
    ws.on("message", () => {}); // push-only channel
    ws.on("close", () => {
      clearTimeout(expiry);
      sockets.delete(ws);
      if (sockets.size === 0) socketsByUser.delete(userId);
    });
    ws.on("error", () => ws.terminate());

    ws.send(JSON.stringify({ type: "ready" }));
  });

  const unsubscribe = subscribeToUserEvents((userId, event) => {
    const sockets = socketsByUser.get(userId);
    if (!sockets) return;
    const message = JSON.stringify(event);
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(message);
    }
  });

  // drop connections that stopped answering pings (a closed laptop lid, a
  // dropped mobile network), so they don't pile up
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  return {
    socketCount: () => wss.clients.size,
    close: () => {
      clearInterval(heartbeat);
      unsubscribe();
      for (const ws of wss.clients) ws.close(1001, "Server shutting down.");
      wss.close();
    },
  };
}
