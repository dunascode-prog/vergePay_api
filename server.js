import env from "./env.js";
import app from "./app.js";
import { attachWebSocketServer } from "./realtime/websocketServer.js";
import { warmUp } from "./services/assistant/matcher.js";

const server = app.listen(env.port, () => {
  console.log(`server listening at port ${env.port}...`);
  // load the assistant's small model in the background, so the first question is quick
  warmUp();
});
// live updates for signed-in browsers at /v1/ws
attachWebSocketServer(server);
