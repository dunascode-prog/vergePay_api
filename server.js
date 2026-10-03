import env from "./env.js";
import app from "./app.js";
import { attachWebSocketServer } from "./realtime/websocketServer.js";

const server = app.listen(env.port, () => {
  console.log(`server listening at port ${env.port}...`);
});
// live updates for signed-in browsers at /v1/ws
attachWebSocketServer(server);
