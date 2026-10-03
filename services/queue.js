import { Queue } from "bullmq";
import env from "../env.js";
import { ServiceUnavailableError } from "../utils/errorStr.js";

// The background job queue (BullMQ on Redis). The API only ever adds jobs;
// they run in the separate worker process (worker.js), so a slow or
// rate-limited brokerage never ties up an HTTP request (API doc 9.2).
//
// Jobs on the brokerage-sync queue:
//   sync-link        sync one brokerage link's holdings; retried with
//                    exponential backoff on outages and rate limits
//   sync-all-links   scheduled every BROKERAGE_SYNC_INTERVAL_MS; queues a
//                    sync-link for every active link that is due

export const BROKERAGE_QUEUE = "brokerage-sync";
export const SYNC_ATTEMPTS = 5;

export function redisConnection() {
  if (!env.redisUrl) {
    throw new ServiceUnavailableError({ message: "The job queue isn't configured on this server (REDIS_URL is missing)." });
  }
  // BullMQ's blocking commands need maxRetriesPerRequest: null
  return { url: env.redisUrl, maxRetriesPerRequest: null };
}

let queue;
export function brokerageQueue() {
  queue ??= new Queue(BROKERAGE_QUEUE, {
    connection: redisConnection(),
    defaultJobOptions: {
      attempts: SYNC_ATTEMPTS,
      backoff: { type: "exponential", delay: env.brokerage.retryDelayMs },
      // the outcome is recorded on the link itself, so finished jobs needn't
      // stay in Redis; removing them also lets the next sync reuse the jobId
      removeOnComplete: true,
      removeOnFail: true,
    },
  });
  return queue;
}

// Queues a sync of one link. The jobId is fixed per link, so while a sync
// is waiting or running, asking again returns that job instead of queueing
// a duplicate. Returns { jobId, state }.
export async function enqueueLinkSync(linkId, reason) {
  const q = brokerageQueue();
  const job = await q.add("sync-link", { linkId, reason }, { jobId: `link-${linkId}` });
  return { jobId: job.id, state: await job.getState() };
}

// Removes a link's waiting sync (e.g. when the link is disconnected).
export async function cancelLinkSync(linkId) {
  const job = await brokerageQueue().getJob(`link-${linkId}`);
  if (job && ["waiting", "delayed", "prioritized"].includes(await job.getState())) await job.remove();
}

// Outgoing email (services/email.js). One job per saved email; a mail
// server that's down is retried with exponential backoff (about 15 minutes
// in all) before the email is marked failed.
export const EMAIL_QUEUE = "email";
export const EMAIL_ATTEMPTS = 6;

let mailQueue;
export function emailQueue() {
  mailQueue ??= new Queue(EMAIL_QUEUE, {
    connection: redisConnection(),
    defaultJobOptions: {
      attempts: EMAIL_ATTEMPTS,
      backoff: { type: "exponential", delay: 15_000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  });
  return mailQueue;
}

export async function closeQueue() {
  await Promise.all([queue?.close(), mailQueue?.close()]);
  queue = undefined;
  mailQueue = undefined;
}
