import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { QUEUE_NAME, enqueueRun, type ExtractionJobData } from "@lomi/db";

/** BullMQ needs maxRetriesPerRequest: null on worker connections (blocking commands). */
export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

export function createExtractionQueue(connection: Redis): Queue {
  return new Queue(QUEUE_NAME, { connection });
}

export function createEnqueue(queue: Queue): (runId: string) => Promise<void> {
  return (runId) => enqueueRun(queue, runId);
}

/** Redis only delivers run ids; every decision is made against Postgres inside `handle`. */
export function createExtractionWorker(
  connection: Redis,
  handle: (runId: string) => Promise<unknown>,
  concurrency: number,
): Worker<ExtractionJobData> {
  return new Worker<ExtractionJobData>(QUEUE_NAME, async (job) => handle(job.data.runId), {
    connection,
    concurrency,
  });
}
