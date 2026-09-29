// Starts the API pointed at the Flutterwave and Alpaca stand-ins instead of
// the real providers, for the Postman suite.
//
//   npm run flw:stand-in  and  npm run alpaca:stand-in   (first)
//   npm run start:with-stand-in
//   npm run worker:with-stand-in                         (the background worker)
import "./stand-in-env.mjs";

console.log("API using the stand-ins: Flutterwave", process.env.FLW_BASE_URL, "· Alpaca", process.env.ALPACA_API_URL);
await import("../server.js");
