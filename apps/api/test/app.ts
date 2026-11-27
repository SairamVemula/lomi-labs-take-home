import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { LocalFileStorage, type FileStorage } from "@lomi/storage";
import type { Db } from "@lomi/db";
import { vi, type Mock } from "vitest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/configure-app.js";
import { loadConfig } from "../src/config.js";
import { CONFIG, DATABASE, PROVIDER_VERIFIER, QUEUE, STORAGE } from "../src/tokens.js";

export const KEK = "11".repeat(32);
export const fixturesDir = resolve(import.meta.dirname, "../../../assignment/fixtures");

export type TestApp = {
  app: INestApplication;
  verifier: Mock<(o: unknown) => Promise<void>>;
  queueAdd: Mock<(...args: unknown[]) => Promise<unknown>>;
  close: () => Promise<void>;
};

/** Boots the real AppModule against a test db; provider verification, queue and storage are replaced. */
export async function createTestApp(
  db: Db,
  env: Record<string, string>,
  opts: { queueAdd?: () => Promise<unknown>; storage?: FileStorage } = {},
): Promise<TestApp> {
  const config = loadConfig({
    DATABASE_URL: "postgres://unused/unused",
    REDIS_URL: "redis://unused:6379",
    SESSION_SECRET: "test-session-secret",
    KEY_ENCRYPTION_KEY: KEK,
    FIXTURES_DIR: fixturesDir,
    ...env,
  });
  const verifier = vi.fn<(o: unknown) => Promise<void>>(async () => undefined);
  const queueAdd = vi.fn<(...args: unknown[]) => Promise<unknown>>(opts.queueAdd ?? (async () => ({})));
  const storage = opts.storage ?? new LocalFileStorage(await mkdtemp(join(tmpdir(), "lomi-api-")));
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CONFIG)
    .useValue(config)
    .overrideProvider(DATABASE)
    .useValue({ db, close: async () => undefined })
    .overrideProvider(STORAGE)
    .useValue(storage)
    .overrideProvider(QUEUE)
    .useValue({ add: queueAdd, close: async () => undefined })
    .overrideProvider(PROVIDER_VERIFIER)
    .useValue(verifier)
    .compile();
  const app = mod.createNestApplication<NestExpressApplication>();
  configureApp(app, config);
  await app.init();
  return { app, verifier, queueAdd, close: () => app.close() };
}
