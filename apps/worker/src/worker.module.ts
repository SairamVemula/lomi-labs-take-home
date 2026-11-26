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
import { loadConfig, type WorkerConfig } from "./config.js";
import { createLlmFor } from "./llm-for-user.js";
import { processRun, type ProcessRunDeps } from "./process-run.js";
import { createEnqueue, createExtractionQueue, createExtractionWorker, createRedis } from "./queue.js";

export const CONFIG = Symbol("CONFIG");
export const DATABASE = Symbol("DATABASE");
export const STORAGE = Symbol("STORAGE");

type DbHandle = { db: Db; close: () => Promise<void> };

/** How long shutdown waits for in-flight runs; anything still running is left to the reconciler. */
const SHUTDOWN_GRACE_MS = 8_000;

@Injectable()
export class ExtractionWorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger("ExtractionWorker");
  private redis?: Redis;
  private queue?: Queue;
  private worker?: Worker;

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
   * Task 9 hook: run the reconciler once now and every 30s (re-add queued runs, fail expired
   * leases). Scheduling lives here so it shares the worker's db, queue and lifecycle.
   */
  private startReconciler(): void {
    // Reconciler not implemented yet (Task 9): needs this.database.db, this.queue and deps.enqueue.
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`shutting down (${signal ?? "close"})`);
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
