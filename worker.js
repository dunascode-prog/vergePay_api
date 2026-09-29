// The background worker: runs the jobs the API queues (services/queue.js).
//
//   npm run worker        (alongside the API; run several for more throughput)
//
// sync-link jobs are retried with exponential backoff when the brokerage is
// down or rate limiting; a refused token isn't retried, the link is marked
// expired instead. A scheduler queues a sync of every due link on a timer.
import { UnrecoverableError, Worker } from "bullmq";
import connectDB from "./db/connectDB.js";
import env from "./env.js";
import logger from "./logger.js";
import { BrokerageAuthError } from "./services/alpaca.js";
import { dueLinkIds, expireLink, setSyncStatus, syncLink } from "./services/brokerageSync.js";
import { BROKERAGE_QUEUE, brokerageQueue, enqueueLinkSync, redisConnection } from "./services/queue.js";

await connectDB();

async function runLinkSync(job) {
  const { linkId } = job.data;
  await setSyncStatus(linkId, "running");
  try {
    const result = await syncLink(linkId);
    logger.info({ message: "brokerage sync finished", linkId, ...result });
    return result;
  } catch (err) {
    if (err instanceof BrokerageAuthError) {
      await expireLink(linkId, err.message);
      // not worth retrying: only the user reconnecting can fix it
      throw new UnrecoverableError(err.message);
    }
    const attempts = job.opts.attempts ?? 1;
    const lastAttempt = job.attemptsMade + 1 >= attempts;
    await setSyncStatus(linkId, lastAttempt ? "failed" : "retrying", err.message);
    logger.error({ message: "brokerage sync attempt failed", linkId, attempt: job.attemptsMade + 1, of: attempts, error: err.message });
    throw err;
  }
}

async function queueDueSyncs() {
  const ids = await dueLinkIds(env.brokerage.syncIntervalMs);
  for (const linkId of ids) {
    await setSyncStatus(linkId, "queued");
    await enqueueLinkSync(linkId, "scheduled");
  }
  return { queued: ids.length };
}

const worker = new Worker(
  BROKERAGE_QUEUE,
  async (job) => {
    if (job.name === "sync-link") return runLinkSync(job);
    if (job.name === "sync-all-links") return queueDueSyncs();
    throw new UnrecoverableError(`Unknown job ${job.name}`);
  },
  {
    connection: redisConnection(),
    concurrency: 5,
    // An idle worker polls Redis; these keep the command count low enough
    // for a free hosted Redis (e.g. Upstash's monthly quota).
    drainDelay: 30,
    stalledInterval: 120_000,
  },
);

// Attached before any await, so the "ready" event isn't missed.
worker.on("ready", () => console.log(`worker ready: ${BROKERAGE_QUEUE}, syncing every ${env.brokerage.syncIntervalMs / 1000}s`));
worker.on("error", (err) => logger.error({ message: "worker error", error: err.message }));

// The recurring "sync everything that's due" job. Upserting keeps exactly
// one schedule no matter how many workers start.
await brokerageQueue().upsertJobScheduler(
  "sync-all-links",
  { every: env.brokerage.syncIntervalMs },
  { name: "sync-all-links", opts: { attempts: 1, removeOnComplete: true, removeOnFail: true } },
);

async function shutdown() {
  await worker.close();
  await brokerageQueue().close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
