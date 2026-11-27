import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addVersion,
  createDocumentWithVersion,
  ensureLocalUser,
  extractedValues,
  getDocumentDetail,
  getProgress,
  insertReview,
  listDocuments,
  reviews,
  type Db,
  type StoredFile,
} from "../src/index.js";
import { startTestDb } from "./setup.js";

let db: Db;
let stop: () => Promise<void>;
let userId: string;
const file: StoredFile = { storageKey: "pdfs/p-x.pdf", originalFilename: "p.pdf", sha256: "x", sizeBytes: 1 };
const NIL = "00000000-0000-0000-0000-000000000000";

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  userId = (await ensureLocalUser(db)).id;
});
afterAll(async () => stop?.());

async function seedValues(versionId: string, runId: string, names: string[]) {
  return db
    .insert(extractedValues)
    .values(
      names.map((fieldName) => ({
        versionId,
        runId,
        fieldName,
        fieldType: "string" as const,
        value: "v",
        changeStatus: "new" as const,
      })),
    )
    .returning({ id: extractedValues.id });
}

describe("progress & reviews", () => {
  it("buckets are exclusive and sum to total", async () => {
    const r = await createDocumentWithVersion(db, { userId, type: "invoice", title: "P", file });
    const v = await seedValues(r.versionId, r.runId, ["a", "b", "c", "d", "e"]);
    // a: none; b: approved; c: corrected; d: carried; e: approved then corrected
    await insertReview(db, { valueId: v[1]!.id, userId, action: "approved", correctedValue: null, note: null });
    await insertReview(db, { valueId: v[2]!.id, userId, action: "corrected", correctedValue: "fix", note: "n" });
    await db.insert(reviews).values({ valueId: v[3]!.id, action: "approved", origin: "carried_over" });
    await insertReview(db, { valueId: v[4]!.id, userId, action: "approved", correctedValue: null, note: null });
    await insertReview(db, { valueId: v[4]!.id, userId, action: "corrected", correctedValue: "fix2", note: null });

    const expected = { pending: 1, approved: 1, corrected: 2, carried_over: 1, total: 5 };
    expect(await getProgress(db, { documentId: r.documentId, userId })).toEqual(expected);
    const listed = (await listDocuments(db, userId)).find((d) => d.id === r.documentId);
    expect(listed!.progress).toEqual(expected);
    expect(await getProgress(db, { documentId: NIL, userId })).toBeNull();
  });

  it("detail exposes effective value, latest review and previous", async () => {
    const r = await createDocumentWithVersion(db, { userId, type: "invoice", title: "D", file });
    const [v1] = await seedValues(r.versionId, r.runId, ["vendor"]);
    await insertReview(db, { valueId: v1!.id, userId, action: "corrected", correctedValue: "Fixed", note: "typo" });
    const v2 = await addVersion(db, { documentId: r.documentId, userId, file });
    await db.insert(extractedValues).values({
      versionId: v2.versionId,
      runId: v2.runId,
      fieldName: "vendor",
      fieldType: "string",
      value: "Raw2",
      changeStatus: "changed",
      previousValueId: v1!.id,
    });
    const d = (await getDocumentDetail(db, { documentId: r.documentId, userId }))!;
    const val = d.values[0]!;
    expect(val).toMatchObject({
      fieldName: "vendor",
      value: "Raw2",
      effectiveValue: "Raw2",
      latestReview: null,
      changeStatus: "changed",
    });
    expect(val.previous).toMatchObject({
      versionNumber: 1,
      value: "v",
      latestReview: { action: "correct", correctedValue: "Fixed", note: "typo", origin: "manual" },
    });
    const old = (await getDocumentDetail(db, { documentId: r.documentId, userId, versionNumber: 1 }))!;
    expect(old.values[0]).toMatchObject({ effectiveValue: "Fixed", latestReview: { action: "correct" }, previous: null });
  });

  it("insertReview rejects non-current and foreign values", async () => {
    const r = await createDocumentWithVersion(db, { userId, type: "invoice", title: "N", file });
    const [v] = await seedValues(r.versionId, r.runId, ["a"]);
    await addVersion(db, { documentId: r.documentId, userId, file });
    const approve = (valueId: string, uid: string) =>
      insertReview(db, { valueId, userId: uid, action: "approved", correctedValue: null, note: null });
    expect(await approve(v!.id, userId)).toEqual({ error: "VALUE_NOT_CURRENT" });
    expect(await approve(v!.id, NIL)).toEqual({ error: "NOT_FOUND" });
    expect(await approve(NIL, userId)).toEqual({ error: "NOT_FOUND" });
  });
});
