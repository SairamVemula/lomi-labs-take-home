import { Inject, Injectable, Logger } from "@nestjs/common";
import { Queue } from "bullmq";
import { QUEUE_NAME, enqueueRun } from "@lomi/db";
import { QUEUE } from "./tokens.js";

/** Producer-only queue; BullMQ owns (and closes) its Redis connection. */
export function createExtractionQueue(redisUrl: string): Queue {
  const u = new URL(redisUrl);
  const queue = new Queue(QUEUE_NAME, {
    connection: {
      host: u.hostname,
      port: u.port ? Number(u.port) : 6379,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined,
      tls: u.protocol === "rediss:" ? {} : undefined,
      // Fail a request fast when Redis is down instead of hanging it; the reconciler covers the run.
      maxRetriesPerRequest: 2,
    },
  });
  const logger = new Logger("Queue");
  queue.on("error", (e) => logger.warn(`queue error: ${e.message}`));
  return queue;
}

/**
 * Queue runs after their rows are committed. Postgres is the outbox: a failure here is only
 * logged, the worker's reconciler re-adds any run still `queued`.
 */
@Injectable()
export class RunEnqueuer {
  private readonly logger = new Logger("RunEnqueuer");

  constructor(@Inject(QUEUE) private readonly queue: Queue) {}

  async enqueue(runIds: string[]): Promise<void> {
    for (const id of runIds) {
      try {
        await enqueueRun(this.queue, id);
      } catch (err) {
        this.logger.warn(`enqueue of run ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
