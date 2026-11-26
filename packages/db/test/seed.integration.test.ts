import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalFileStorage } from "@lomi/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { documentVersions, documents, ensureLocalUser, extractionRuns, seedWorkspace, type Db } from "../src/index.js";
import { startTestDb } from "./setup.js";

let db: Db;
let stop: () => Promise<void>;
const fixtures = resolve(import.meta.dirname, "../../../assignment/fixtures");

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
});
afterAll(async () => stop?.());

describe("seedWorkspace", () => {
  it("seeds 3 documents at v1 with queued runs, idempotently", async () => {
    const storage = new LocalFileStorage(await mkdtemp(join(tmpdir(), "seed-")));
    const user = await ensureLocalUser(db);
    const runIds = await seedWorkspace(db, storage, user.id, fixtures);
    expect(runIds).toHaveLength(3);
    const docs = await db.select().from(documents);
    expect(docs).toHaveLength(3);
    expect(docs.map((d) => d.externalId).sort()).toEqual(["doc-invoice-001", "doc-lease-001", "doc-report-001"]);
    const versions = await db.select().from(documentVersions);
    expect(versions).toHaveLength(3);
    expect(versions.every((v) => v.versionNumber === 1)).toBe(true);
    const runs = await db.select().from(extractionRuns);
    expect(runs.map((r) => r.status)).toEqual(["queued", "queued", "queued"]);
    const inv = versions.find((v) => v.originalFilename === "invoice-001.pdf")!;
    expect(inv.storageKey).toBe(`pdfs/invoice-001-${inv.sha256}.pdf`);
    for (const v of versions) expect(await storage.exists(v.storageKey)).toBe(true);

    expect(await seedWorkspace(db, storage, user.id, fixtures)).toEqual([]);
    expect(await db.select().from(documents)).toHaveLength(3);
  });
});
