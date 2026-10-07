// Runs the full Postman suite with Newman and prints a summary.
//
//   npm run test:postman
//
// Needs, in other terminals: npm run flw:stand-in, npm run alpaca:stand-in,
// npm run s3:stand-in and npm run start:with-stand-in.
// Reads INTERNAL_API_KEY from .env and passes it to the collection, so the
// key never has to be pasted into the collection file.
import { spawnSync } from "child_process";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config({ quiet: true });
const collection = new URL("./vergepay-api.postman_collection.json", import.meta.url);
const report = new URL("./last-run.json", import.meta.url);

if (!process.env.INTERNAL_API_KEY) {
  console.error("INTERNAL_API_KEY is missing from .env; the back-office requests will fail.");
}

const args = [
  "-y",
  "newman",
  "run",
  decodeURIComponent(collection.pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "--env-var",
  `internalApiKey=${process.env.INTERNAL_API_KEY ?? ""}`,
  "--reporters",
  "cli,json",
  "--reporter-json-export",
  decodeURIComponent(report.pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "--timeout-script",
  "120000",
  ...process.argv.slice(2),
];
const result = spawnSync("npx", args, { stdio: "inherit", shell: process.platform === "win32" });

// A short summary, grouped by folder, from the JSON report. Requests fired
// from test scripts (the "Concurrent:" checks) show up as extra executions of
// the request that fired them, repeating its assertions, so each collection
// request is counted once, with the assertions from its fullest execution.
try {
  const { run, collection: reportCollection } = JSON.parse(fs.readFileSync(report, "utf8"));
  const perItem = new Map();
  for (const execution of run.executions) {
    const previous = perItem.get(execution.item.id);
    if (!previous || (execution.assertions ?? []).length >= (previous.assertions ?? []).length) {
      perItem.set(execution.item.id, execution);
    }
  }
  let requests = 0;
  let assertions = 0;
  let failures = 0;
  console.log("\nSummary by folder");
  for (const folder of reportCollection.item) {
    const entry = { requests: 0, assertions: 0, failed: [] };
    for (const item of folder.item ?? []) {
      const execution = perItem.get(item.id);
      if (!execution) continue;
      entry.requests += 1;
      for (const assertion of execution.assertions ?? []) {
        entry.assertions += 1;
        if (assertion.error) entry.failed.push(`${item.name}: ${assertion.assertion} (${assertion.error.message})`);
      }
    }
    requests += entry.requests;
    assertions += entry.assertions;
    failures += entry.failed.length;
    console.log(`  ${entry.failed.length ? "FAIL" : "ok  "} ${folder.name}: ${entry.requests} requests, ${entry.assertions - entry.failed.length}/${entry.assertions} assertions`);
    for (const f of entry.failed) console.log(`         - ${f}`);
  }
  console.log(`\nTotal: ${requests} requests, ${assertions - failures}/${assertions} assertions passed. Compare with postman/EXPECTED_RESULTS.md.`);
} catch (err) {
  console.log(`(couldn't summarise ${report.pathname}: ${err.message})`);
}

process.exitCode = result.status ?? 1;
