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

/**
 * Like createEnqueue, but first drops a finished (completed/failed) job with the same id: BullMQ
 * `add` is a silent no-op for an existing jobId in any state, so a run still `queued` in Postgres
 * whose job already finished (e.g. claimRun hit a DB error) would otherwise never be redelivered.
 * Waiting/active/delayed jobs are left alone.
 */
export function createRequeue(queue: Queue): (runId: string) => Promise<void> {
  return async (runId) => {
    const job = await queue.getJob(runId);
    if (job) {
      const state = await job.getState();
      if (state === "completed" || state === "failed") await job.remove();
    }
    await enqueueRun(queue, runId);
  };
}
