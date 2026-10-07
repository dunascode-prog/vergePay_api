// The background worker: runs the jobs the API queues (services/queue.js).
//
//   npm run worker        (alongside the API; run several for more throughput)
//
// sync-link jobs are retried with exponential backoff when the brokerage is
// down or rate limiting; a refused token isn't retried, the link is marked
// expired instead. A scheduler queues a sync of every due link on a timer.
// Another sends the invoices recurring plans owe (services/recurring.js).
import { UnrecoverableError, Worker } from "bullmq";
import connectDB from "./db/connectDB.js";
import env from "./env.js";
import logger from "./logger.js";
import { BrokerageAuthError } from "./services/alpaca.js";
import { dueLinkIds, expireLink, setSyncStatus, syncLink } from "./services/brokerageSync.js";
import { deliverEmail } from "./services/email.js";
import { syncPendingWithdrawals } from "./services/payouts.js";
import {
  BROKERAGE_QUEUE,
  EMAIL_QUEUE,
  PAYOUT_QUEUE,
  RECURRING_QUEUE,
  brokerageQueue,
  enqueueLinkSync,
  payoutsQueue,
  recurringQueue,
  redisConnection,
} from "./services/queue.js";
import { billDuePlans } from "./services/recurring.js";

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

// Outgoing email: invoices, reminders and receipts (services/email.js).
const emailWorker = new Worker(
  EMAIL_QUEUE,
  async (job) => {
    if (job.name !== "send-email") throw new UnrecoverableError(`Unknown job ${job.name}`);
    const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    await deliverEmail(job.data.emailId, { lastAttempt });
  },
  { connection: redisConnection(), concurrency: 5, drainDelay: 30, stalledInterval: 120_000 },
);
emailWorker.on("ready", () => console.log(`worker ready: ${EMAIL_QUEUE}`));
emailWorker.on("error", (err) => logger.error({ message: "email worker error", error: err.message }));

// Recurring billing: one run at a time is plenty (each plan is locked while
// it's billed, so a second worker would only skip what the first is doing).
const billingWorker = new Worker(
  RECURRING_QUEUE,
  async (job) => {
    if (job.name !== "bill-due-plans") throw new UnrecoverableError(`Unknown job ${job.name}`);
    const result = await billDuePlans();
    if (result.invoices) logger.info({ message: "recurring invoices sent", ...result });
    return result;
  },
  { connection: redisConnection(), concurrency: 1, drainDelay: 30, stalledInterval: 120_000 },
);
billingWorker.on("ready", () => console.log(`worker ready: ${RECURRING_QUEUE}, every ${env.recurring.intervalMs / 1000}s`));
billingWorker.on("error", (err) => logger.error({ message: "billing worker error", error: err.message }));

await recurringQueue().upsertJobScheduler(
  "bill-due-plans",
  { every: env.recurring.intervalMs },
  { name: "bill-due-plans", opts: { attempts: 1, removeOnComplete: true, removeOnFail: true } },
);

// Withdrawals Flutterwave hasn't confirmed yet (no webhook, or a lost reply).
const payoutWorker = new Worker(
  PAYOUT_QUEUE,
  async (job) => {
    if (job.name !== "sync-pending-withdrawals") throw new UnrecoverableError(`Unknown job ${job.name}`);
    const result = await syncPendingWithdrawals();
    if (result.checked) logger.info({ message: "pending withdrawals checked", ...result });
    return result;
  },
  { connection: redisConnection(), concurrency: 1, drainDelay: 30, stalledInterval: 120_000 },
);
payoutWorker.on("ready", () => console.log(`worker ready: ${PAYOUT_QUEUE}, every ${env.withdrawals.syncIntervalMs / 1000}s`));
payoutWorker.on("error", (err) => logger.error({ message: "payout worker error", error: err.message }));

await payoutsQueue().upsertJobScheduler(
  "sync-pending-withdrawals",
  { every: env.withdrawals.syncIntervalMs },
  { name: "sync-pending-withdrawals", opts: { attempts: 1, removeOnComplete: true, removeOnFail: true } },
);

async function shutdown() {
  await Promise.all([worker.close(), emailWorker.close(), billingWorker.close(), payoutWorker.close()]);
  await Promise.all([brokerageQueue().close(), recurringQueue().close(), payoutsQueue().close()]);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
