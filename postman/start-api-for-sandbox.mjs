// Starts the API against the REAL Flutterwave sandbox (the FLW_* keys in
// .env), for the live collection (vergepay-flutterwave-live.postman_collection.json).
//
//   npm run start:flw-sandbox
//
// Saved-card charges need FLW_REDIRECT_URL to be a public https address
// (Flutterwave refuses localhost). If .env doesn't set one, this uses a
// placeholder: after approving a charge the browser lands on example.com,
// which is harmless, and the payment still completes.
import dotenv from "dotenv";

dotenv.config({ quiet: true });
const current = process.env.FLW_REDIRECT_URL ?? "";
if (!/^https:\/\/(?!localhost|127\.)/.test(current)) {
  process.env.FLW_REDIRECT_URL = "https://example.com/vergepay/payments/complete";
  console.log("FLW_REDIRECT_URL isn't a public https address; using", process.env.FLW_REDIRECT_URL);
}
if (!process.env.FLW_SECRET_KEY) {
  console.error("FLW_SECRET_KEY is missing from .env; card calls will return 503.");
}
await import("../server.js");
