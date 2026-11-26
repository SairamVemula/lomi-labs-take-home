import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addVersion,
  createDocumentWithVersion,
  createRetryRun,
  documentVersions,
  documents,
  ensureLocalUser,
  extractedValues,
  extractionRuns,
  getDocumentDetail,
  getVersionFile,
  isUniqueViolation,
  listDocuments,
  listReferencedStorageKeys,
  users,
  type Db,
  type StoredFile,
} from "../src/index.js";
import { startTestDb } from "./setup.js";

let db: Db;
let stop: () => Promise<void>;
let userA: string;
let userB: string;

const file = (n: string): StoredFile => ({
  storageKey: `pdfs/${n}-${"a".repeat(64)}.pdf`,
  originalFilename: `${n}.pdf`,
  sha256: "a".repeat(64),
  sizeBytes: 10,
});

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  userA = (await ensureLocalUser(db)).id;
  const [b] = await db.insert(users).values({ identityHash: "other", isLocal: false }).returning({ id: users.id });
  userB = b!.id;
});
afterAll(async () => stop?.());

describe("documents", () => {
  it("ensureLocalUser is idempotent", async () => {
    const a = await ensureLocalUser(db);
    const b = await ensureLocalUser(db);
    expect(a.id).toBe(b.id);
    expect(a).toMatchObject({ identityHash: "local", isLocal: true, baseUrl: null, model: null, encryptedKey: null });
  });

  it("createDocumentWithVersion yields a queued v1 with active run", async () => {
    const r = await createDocumentWithVersion(db, { userId: userA, type: "invoice", title: "T", file: file("one") });
    const detail = await getDocumentDetail(db, { documentId: r.documentId, userId: userA });
    expect(detail).toMatchObject({ status: "queued", currentVersion: 1, viewingVersion: 1, title: "T", type: "invoice" });
    expect(detail!.versions).toEqual([
      expect.objectContaining({
        number: 1,
        status: "queued",
        originalFilename: "one.pdf",
        fileUrl: `/api/documents/${r.documentId}/versions/1/file`,
      }),
    ]);
    expect(detail!.latestRun).toMatchObject({ status: "queued", attempt: 1 });
    const [v] = await db.select().from(documentVersions).where(eq(documentVersions.id, r.versionId));
    expect(v!.activeRunId).toBe(r.runId);
    const [d] = await db.select().from(documents).where(eq(documents.id, r.documentId));
    expect(d!.currentVersionId).toBe(r.versionId);
  });

  it("concurrent addVersion calls get distinct numbers", async () => {
    const r = await createDocumentWithVersion(db, { userId: userA, type: "lease", title: "C", file: file("conc") });
    const [x, y] = await Promise.all([
      addVersion(db, { documentId: r.documentId, userId: userA, file: file("conc2") }),
      addVersion(db, { documentId: r.documentId, userId: userA, file: file("conc3") }),
    ]);
    expect([x.versionNumber, y.versionNumber].sort()).toEqual([2, 3]);
    const detail = await getDocumentDetail(db, { documentId: r.documentId, userId: userA });
    expect(detail!.currentVersion).toBe(3);
    expect(detail!.versions.map((v) => [v.number, v.status])).toEqual([
      [1, "superseded"],
      [2, "superseded"],
      [3, "queued"],
    ]);
    const old = await getDocumentDetail(db, { documentId: r.documentId, userId: userA, versionNumber: 1 });
    expect(old).toMatchObject({ viewingVersion: 1, currentVersion: 3, status: "queued" });
  });

  it("addVersion rejects another user's document", async () => {
    const r = await createDocumentWithVersion(db, { userId: userA, type: "lease", title: "O", file: file("own") });
    await expect(addVersion(db, { documentId: r.documentId, userId: userB, file: file("x") })).rejects.toThrow(/not found/i);
  });

  it("returns null for another user's document", async () => {
    const r = await createDocumentWithVersion(db, { userId: userA, type: "invoice", title: "P", file: file("priv") });
    expect(await getDocumentDetail(db, { documentId: r.documentId, userId: userB })).toBeNull();
    expect(await getVersionFile(db, { documentId: r.documentId, userId: userB, versionNumber: 1 })).toBeNull();
    expect(await getVersionFile(db, { documentId: r.documentId, userId: userA, versionNumber: 1 })).toEqual(file("priv"));
    expect(await getVersionFile(db, { documentId: r.documentId, userId: userA, versionNumber: 9 })).toBeNull();
  });

  it("rejects duplicate (version_id, field_name) values", async () => {
    const r = await createDocumentWithVersion(db, { userId: userA, type: "invoice", title: "U", file: file("uniq") });
    const row = {
      versionId: r.versionId,
      runId: r.runId,
      fieldName: "vendor",
      fieldType: "string" as const,
      value: "x",
      changeStatus: "new" as const,
    };
    await db.insert(extractedValues).values(row);
    const err = await db.insert(extractedValues).values(row).catch((e: unknown) => e);
    expect(isUniqueViolation(err)).toBe(true);
  });

  it("createRetryRun only works for a failed current run", async () => {
    const r = await createDocumentWithVersion(db, { userId: userA, type: "invoice", title: "R", file: file("retry") });
    expect(await createRetryRun(db, { documentId: r.documentId, userId: userA })).toEqual({ error: "NOT_FAILED" });
    await db
      .update(extractionRuns)
      .set({ status: "failed", error: "boom", errorKind: "permanent" })
      .where(eq(extractionRuns.id, r.runId));
    expect((await getDocumentDetail(db, { documentId: r.documentId, userId: userA }))!.status).toBe("failed");
    const res = await createRetryRun(db, { documentId: r.documentId, userId: userA });
    expect(res).toEqual({ runId: expect.any(String) });
    const detail = await getDocumentDetail(db, { documentId: r.documentId, userId: userA });
    expect(detail!.status).toBe("queued");
    expect(detail!.latestRun).toMatchObject({ attempt: 2, status: "queued" });
    expect(await createRetryRun(db, { documentId: r.documentId, userId: userB })).toEqual({ error: "NOT_FOUND" });
  });

  it("listDocuments is scoped to the user; storage keys are listed", async () => {
    expect(await listDocuments(db, userB)).toEqual([]);
    const a = await listDocuments(db, userA);
    expect(a.length).toBeGreaterThan(3);
    expect(a[0]).toMatchObject({ currentVersion: 1, status: "queued", progress: { total: 0, pending: 0 } });
    const keys = await listReferencedStorageKeys(db);
    expect(keys.has(file("one").storageKey)).toBe(true);
  });
});
