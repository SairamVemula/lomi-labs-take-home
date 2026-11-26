import type { Queue } from "bullmq";

/** BullMQ queue shared by the API (producer) and the worker (consumer). It only delivers run ids. */
export const QUEUE_NAME = "extraction";

export type ExtractionJobData = { runId: string };

/**
 * jobId = runId makes re-adding a run a no-op while the job exists; attempts: 1 because retries are
 * owned by Postgres run rows, never by BullMQ.
 */
export async function enqueueRun(queue: Queue, runId: string): Promise<void> {
  await queue.add("extract", { runId } satisfies ExtractionJobData, {
    jobId: runId,
    attempts: 1,
    removeOnComplete: 1000,
    removeOnFail: 1000,
  });
}
