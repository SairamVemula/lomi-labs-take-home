import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import type { Queue } from "bullmq";
import { createDb, type Db } from "@lomi/db";
import { verifyProvider } from "@lomi/extraction";
import { createStorage, type FileStorage } from "@lomi/storage";
import { LocalUserResolver } from "./auth/local-user.resolver.js";
import { SessionUserResolver } from "./auth/session-user.resolver.js";
import type { UserResolver } from "./auth/user-resolver.js";
import { loadConfig, type ApiConfig } from "./config.js";
import { RunEnqueuer, createExtractionQueue } from "./queue.js";
import { CONFIG, DATABASE, PROVIDER_VERIFIER, QUEUE, STORAGE, USER_RESOLVER } from "./tokens.js";

type DbHandle = { db: Db; close: () => Promise<void> };

@Injectable()
class Shutdown implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE) private readonly database: DbHandle,
    @Inject(QUEUE) private readonly queue: Queue,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close().catch(() => undefined);
    await this.database.close();
  }
}

/** Infrastructure shared by every feature module; tests replace these tokens. */
@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: (): ApiConfig => loadConfig(process.env) },
    { provide: DATABASE, useFactory: (c: ApiConfig): DbHandle => createDb(c.databaseUrl), inject: [CONFIG] },
    { provide: STORAGE, useFactory: (): FileStorage => createStorage(process.env) },
    { provide: QUEUE, useFactory: (c: ApiConfig): Queue => createExtractionQueue(c.redisUrl), inject: [CONFIG] },
    { provide: PROVIDER_VERIFIER, useValue: verifyProvider },
    {
      provide: USER_RESOLVER,
      useFactory: (c: ApiConfig, d: DbHandle): UserResolver =>
        c.authMode === "local" ? new LocalUserResolver(d) : new SessionUserResolver(d, c),
      inject: [CONFIG, DATABASE],
    },
    RunEnqueuer,
    Shutdown,
  ],
  exports: [CONFIG, DATABASE, STORAGE, QUEUE, PROVIDER_VERIFIER, USER_RESOLVER, RunEnqueuer],
})
export class CoreModule {}
