// Starts the background worker pointed at the stand-ins, for the Postman
// suite (the investments folder needs it to run brokerage syncs).
//
//   npm run worker:with-stand-in
import "./stand-in-env.mjs";

console.log("worker using the Alpaca stand-in at", process.env.ALPACA_API_URL);
await import("../worker.js");
