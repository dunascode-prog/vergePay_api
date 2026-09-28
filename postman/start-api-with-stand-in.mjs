// Starts the API pointed at the Flutterwave stand-in (postman/flutterwave-stand-in.mjs)
// instead of the real Flutterwave, for the Postman suite.
//
//   npm run flw:stand-in           (first, in its own terminal)
//   npm run start:with-stand-in
//
// Variables set here win over .env (dotenv never overrides them), so your
// real Flutterwave keys in .env are left alone and never used by this run.
process.env.FLW_BASE_URL = `http://localhost:${process.env.FLW_STAND_IN_PORT || 9999}`;
process.env.FLW_SECRET_KEY = "FLWSECK_TEST-stand-in-X";
// must match the collection's flwSecretHash variable
process.env.FLW_SECRET_HASH = "stand-in-secret-hash";
// saved-card charges need a public https redirect (Flutterwave refuses localhost)
process.env.FLW_REDIRECT_URL = "https://example.com/vergepay/payments/complete";

console.log("API using the Flutterwave stand-in at", process.env.FLW_BASE_URL);
await import("../server.js");
