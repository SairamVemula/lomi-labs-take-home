import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { Queue } from "bullmq";
import { GenericContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import {
  QUEUE_NAME,
  createDocumentWithVersion,
  documents,
  documentVersions,
  ensureLocalUser,
  extractionRuns,
  getDocumentDetail,
  storePdf,
  users,
  type Db,
} from "@lomi/db";
import { LocalFileStorage } from "@lomi/storage";
import { cleanupIdleUsers, sweepOrphanFiles } from "../src/cleanup.js";
import { createEnqueue, createRedis } from "../src/queue.js";
import { reconcile } from "../src/reconciler.js";
import { startTestDb } from "./setup.js";

let db: Db;
let stopDb: () => Promise<void>;
let redisContainer: Awaited<ReturnType<GenericContainer["start"]>>;
let redis: Redis;
let queue: Queue;
let storageDir: string;
let storage: LocalFileStorage;
let userId: string;
let n = 0;

beforeAll(async () => {
  ({ db, stop: stopDb } = await startTestDb());
  redisContainer = await new GenericContainer("redis:7-alpine").withExposedPorts(6379).start();
  redis = createRedis(`redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`);
  queue = new Queue(QUEUE_NAME, { connection: redis });
  storageDir = await mkdtemp(join(tmpdir(), "lomi-reconciler-"));
  storage = new LocalFileStorage(storageDir);
  userId = (await ensureLocalUser(db)).id;
});

afterAll(async () => {
  await queue?.close();
  redis?.disconnect();
  await redisContainer?.stop();
  await stopDb?.();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

const enqueue = () => createEnqueue(queue);

async function newDoc(owner = userId) {
  const i = ++n;
  return createDocumentWithVersion(db, {
    userId: owner,
    type: "invoice",
    title: `doc ${i}`,
    file: {
      storageKey: `pdfs/doc-${i}.pdf`,
      originalFilename: `doc${i}.pdf`,
      sha256: String(i).padStart(64, "0"),
      sizeBytes: 1,
    },
  });
}

async function makeExtracting(runId: string, lease: "expired" | "live" | "null", attempt?: number) {
  await db
    .update(extractionRuns)
    .set({
      status: "extracting",
      leaseExpiresAt:
        lease === "expired" ? sql`now() - interval '5 minutes'` : lease === "live" ? sql`now() + interval '1 minute'` : null,
      startedAt: sql`now() - interval '10 minutes'`,
      ...(attempt ? { attempt } : {}),
    })
    .where(eq(extractionRuns.id, runId));
}

/** Isolate each test: finish every run left over from earlier tests and empty Redis. */
async function reset() {
  await db.update(extractionRuns).set({ status: "failed", leaseExpiresAt: null });
  await redis.flushall();
}

describe("reconcile", () => {
  it("re-adds queued runs after Redis FLUSHALL", async () => {
    await reset();
    const a = await newDoc();
    const b = await newDoc();
    await enqueue()(a.runId);
    await enqueue()(b.runId);
    await redis.flushall();
    expect(await queue.getJob(a.runId)).toBeUndefined();

    const res = await reconcile({ db, enqueue: enqueue() });
    expect(res.requeued.sort()).toEqual([a.runId, b.runId].sort());
    expect(await queue.getJob(a.runId)).toBeDefined();
    expect(await queue.getJob(b.runId)).toBeDefined();
  });

  it("is idempotent while jobs exist (jobId dedupe)", async () => {
    await reset();
    const a = await newDoc();
    await reconcile({ db, enqueue: enqueue() });
    const before = await queue.getJobCounts();
    await reconcile({ db, enqueue: enqueue() });
    await reconcile({ db, enqueue: enqueue() });
    expect(await queue.getJobCounts()).toEqual(before);
    expect(await queue.getJob(a.runId)).toBeDefined();
  });

  it("fails an expired extracting run and enqueues the next attempt (no job in Redis)", async () => {
    await reset();
    const d = await newDoc();
    await makeExtracting(d.runId, "expired");
    expect(await queue.getJob(d.runId)).toBeUndefined();

    const res = await reconcile({ db, enqueue: enqueue() });
    expect(res.expired).toEqual([d.runId]);
    const [failed] = await db.select().from(extractionRuns).where(eq(extractionRuns.id, d.runId));
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("worker lost lease");
    const [ver] = await db.select().from(documentVersions).where(eq(documentVersions.id, d.versionId));
    expect(ver?.activeRunId).toBeTruthy();
    expect(ver?.activeRunId).not.toBe(d.runId);
    const [next] = await db.select().from(extractionRuns).where(eq(extractionRuns.id, ver!.activeRunId!));
    expect(next).toMatchObject({ attempt: 2, status: "queued" });
    expect(await queue.getJob(next!.id)).toBeDefined();
  });

  it("fails the document at attempt 3 with no new run", async () => {
    await reset();
    const d = await newDoc();
    await makeExtracting(d.runId, "expired", 3);
    const res = await reconcile({ db, enqueue: enqueue() });
    expect(res.expired).toEqual([d.runId]);
    const runs = await db.select().from(extractionRuns).where(eq(extractionRuns.versionId, d.versionId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
    const detail = await getDocumentDetail(db, { userId, documentId: d.documentId });
    expect(detail?.status).toBe("failed");
  });

  it("leaves a live lease untouched", async () => {
    await reset();
    const d = await newDoc();
    await makeExtracting(d.runId, "live");
    const res = await reconcile({ db, enqueue: enqueue() });
    expect(res).toEqual({ requeued: [], expired: [] });
    const [run] = await db.select().from(extractionRuns).where(eq(extractionRuns.id, d.runId));
    expect(run?.status).toBe("extracting");
  });

  it("treats an old extracting run with NULL lease as expired, a fresh one as live", async () => {
    await reset();
    const old = await newDoc();
    const fresh = await newDoc();
    await makeExtracting(old.runId, "null");
    await db
      .update(extractionRuns)
      .set({ status: "extracting", leaseExpiresAt: null, startedAt: sql`now() - interval '5 seconds'` })
      .where(eq(extractionRuns.id, fresh.runId));
    const res = await reconcile({ db, enqueue: enqueue() });
    expect(res.expired).toEqual([old.runId]);
  });

  it("does not throw when enqueue fails, and keeps going", async () => {
    await reset();
    await newDoc();
    await newDoc();
    const logs: string[] = [];
    const res = await reconcile({
      db,
      enqueue: async () => {
        throw new Error("redis down");
      },
      log: (m) => logs.push(m),
    });
    expect(res.requeued).toEqual([]);
    expect(logs).toHaveLength(2);
  });
});

describe("cleanupIdleUsers", () => {
  it("deletes idle non-local users with their documents; keeps local and recent users", async () => {
    const now = new Date();
    const mk = async (hash: string, daysAgo: number, isLocal = false) => {
      const [u] = await db
        .insert(users)
        .values({ identityHash: hash, isLocal, lastSeenAt: new Date(now.getTime() - daysAgo * 86_400_000) })
        .returning({ id: users.id });
      return u!.id;
    };
    const idle = await mk("idle-8d", 8);
    const recent = await mk("recent-6d", 6);
    const local = await mk("local-30d", 30, true);
    const idleDoc = await newDoc(idle);
    await newDoc(recent);

    expect(await cleanupIdleUsers(db, now)).toBe(1);
    expect(await db.select().from(users).where(eq(users.id, idle))).toHaveLength(0);
    expect(await db.select().from(users).where(eq(users.id, recent))).toHaveLength(1);
    expect(await db.select().from(users).where(eq(users.id, local))).toHaveLength(1);
    expect(await db.select().from(documents).where(eq(documents.id, idleDoc.documentId))).toHaveLength(0);
    expect(await db.select().from(extractionRuns).where(eq(extractionRuns.id, idleDoc.runId))).toHaveLength(0);
  });
});

describe("sweepOrphanFiles", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  const backdate = (key: string, when: Date) => utimes(join(storageDir, key), when, when);

  it("deletes old unreferenced files only; deleted users' files go unless still referenced", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 2 * 3_600_000);
    const owner = (await db.insert(users).values({ identityHash: "sweep-owner" }).returning({ id: users.id }))[0]!.id;
    const idleUser = (
      await db
        .insert(users)
        .values({ identityHash: "sweep-idle", lastSeenAt: new Date(now.getTime() - 9 * 86_400_000) })
        .returning({ id: users.id })
    )[0]!.id;

    const orphanOld = await storePdf(storage, "orphan-old.pdf", bytes("orphan-old"));
    const orphanNew = await storePdf(storage, "orphan-new.pdf", bytes("orphan-new"));
    const referenced = await storePdf(storage, "ref.pdf", bytes("ref"));
    const shared = await storePdf(storage, "shared.pdf", bytes("shared"));
    const gone = await storePdf(storage, "gone.pdf", bytes("gone"));
    await createDocumentWithVersion(db, { userId: owner, type: "lease", title: "r", file: referenced });
    await createDocumentWithVersion(db, { userId: owner, type: "lease", title: "s", file: shared });
    await createDocumentWithVersion(db, { userId: idleUser, type: "lease", title: "s2", file: shared });
    await createDocumentWithVersion(db, { userId: idleUser, type: "lease", title: "g", file: gone });

    for (const f of [orphanOld, referenced, shared, gone]) await backdate(f.storageKey, old);
    await backdate(orphanNew.storageKey, new Date(now.getTime() - 10 * 60_000));

    expect(await cleanupIdleUsers(db, now)).toBe(1);
    const deleted = await sweepOrphanFiles(db, storage, now);
    expect(deleted.sort()).toEqual([orphanOld.storageKey, gone.storageKey].sort());
    const left = (await storage.list("pdfs/")).map((x) => x.key);
    expect(left).toContain(orphanNew.storageKey);
    expect(left).toContain(referenced.storageKey);
    expect(left).toContain(shared.storageKey);
    expect(left).not.toContain(gone.storageKey);
  });
});
