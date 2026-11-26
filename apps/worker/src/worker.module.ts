import {
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { createDb, type Db } from "@lomi/db";
import { createStorage, type FileStorage } from "@lomi/storage";
import { cleanupIdleUsers, sweepOrphanFiles } from "./cleanup.js";
import { loadConfig, type WorkerConfig } from "./config.js";
import { createLlmFor } from "./llm-for-user.js";
import { processRun, type ProcessRunDeps } from "./process-run.js";
import { reconcile } from "./reconciler.js";
import { createEnqueue, createRequeue, createExtractionQueue, createExtractionWorker, createRedis } from "./queue.js";

export const CONFIG = Symbol("CONFIG");
export const DATABASE = Symbol("DATABASE");
export const STORAGE = Symbol("STORAGE");

type DbHandle = { db: Db; close: () => Promise<void> };

/** How long shutdown waits for in-flight runs; anything still running is left to the reconciler. */
const SHUTDOWN_GRACE_MS = 8_000;
const RECONCILE_INTERVAL_MS = 30_000;
const HOURLY_MS = 3_600_000;

@Injectable()
export class ExtractionWorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger("ExtractionWorker");
  private redis?: Redis;
  private queue?: Queue;
  private worker?: Worker;
  private readonly timers: NodeJS.Timeout[] = [];
  private stopped = false;

  constructor(
    @Inject(CONFIG) private readonly config: WorkerConfig,
    @Inject(DATABASE) private readonly database: DbHandle,
    @Inject(STORAGE) private readonly storage: FileStorage,
  ) {}

  onApplicationBootstrap(): void {
    this.redis = createRedis(this.config.redisUrl);
    this.queue = createExtractionQueue(this.redis);
    const deps: ProcessRunDeps = {
      db: this.database.db,
      storage: this.storage,
      llmFor: createLlmFor({
        db: this.database.db,
        authMode: this.config.authMode,
        env: this.config.llmEnv,
        keyEncryptionKey: this.config.keyEncryptionKey,
      }),
      enqueue: createEnqueue(this.queue),
      log: (m) => this.logger.warn(m),
    };
    this.worker = createExtractionWorker(
      this.redis,
      async (runId) => {
        const result = await processRun(deps, runId);
        this.logger.log(`run ${runId}: ${result}`);
        return result;
      },
      this.config.concurrency,
    );
    this.worker.on("error", (e) => this.logger.error(`worker error: ${e.message}`));
    this.logger.log(`listening on queue with concurrency ${this.config.concurrency} (auth ${this.config.authMode})`);

    this.startReconciler();
  }

  /**
   * Reconcile once now and every 30s (re-add queued runs, fail expired leases); sweep orphan files
   * hourly and, in byok mode, delete idle users hourly. A tick is skipped while the previous run
   * of the same job is still going. Timers are cleared on shutdown.
   */
  private startReconciler(): void {
    const enqueue = createEnqueue(this.queue!);
    const schedule = (name: string, everyMs: number, job: () => Promise<unknown>, runNow: boolean): void => {
      let running = false;
      const tick = async (): Promise<void> => {
        if (running || this.stopped) return;
        running = true;
        try {
          await job();
        } catch (err) {
          this.logger.error(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          running = false;
        }
      };
      this.timers.push(setInterval(() => void tick(), everyMs).unref());
      if (runNow) void tick();
    };

    schedule(
      "reconcile",
      RECONCILE_INTERVAL_MS,
      async () => {
        const r = await reconcile({
          db: this.database.db,
          enqueue,
          requeue: createRequeue(this.queue!),
          now: () => new Date(),
          log: (m) => this.logger.warn(m),
        });
        if (r.requeued.length || r.expired.length) {
          this.logger.log(`reconcile: requeued ${r.requeued.length}, expired ${r.expired.length}`);
        }
      },
      true,
    );
    schedule(
      "orphan sweep",
      HOURLY_MS,
      async () => {
        const deleted = await sweepOrphanFiles(this.database.db, this.storage, new Date());
        if (deleted.length) this.logger.log(`orphan sweep: deleted ${deleted.length} file(s)`);
      },
      false,
    );
    if (this.config.authMode === "byok") {
      schedule(
        "idle user cleanup",
        HOURLY_MS,
        async () => {
          const n = await cleanupIdleUsers(this.database.db, new Date());
          if (n) this.logger.log(`idle user cleanup: deleted ${n} user(s)`);
        },
        false,
      );
    }
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`shutting down (${signal ?? "close"})`);
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    // Stop taking jobs; give in-flight runs a short grace period. Runs still extracting after that
    // keep their lease and are recovered by the reconciler once it expires.
    if (this.worker) {
      await Promise.race([
        this.worker.close(),
        new Promise((r) => setTimeout(r, SHUTDOWN_GRACE_MS).unref()),
      ]);
    }
    await this.queue?.close().catch(() => undefined);
    this.redis?.disconnect();
    await this.database.close();
  }
}

@Module({
  providers: [
    { provide: CONFIG, useFactory: (): WorkerConfig => loadConfig(process.env) },
    { provide: DATABASE, useFactory: (c: WorkerConfig): DbHandle => createDb(c.databaseUrl), inject: [CONFIG] },
    { provide: STORAGE, useFactory: (): FileStorage => createStorage(process.env) },
    ExtractionWorkerService,
  ],
})
export class WorkerModule {}
