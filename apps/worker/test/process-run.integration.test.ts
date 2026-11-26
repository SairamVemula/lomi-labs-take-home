import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  addVersion,
  claimRun,
  createDocumentWithVersion,
  markFailed,
  documentVersions,
  encryptKey,
  ensureLocalUser,
  extractedValues,
  extractionRuns,
  getDocumentDetail,
  getProgress,
  insertReview,
  reviews,
  storePdf,
  users,
  type Db,
} from "@lomi/db";
import {
  LlmError,
  assembleValues,
  diffAgainstBaseline,
  extractPdfText,
  type ClientOptions,
  type LlmClient,
} from "@lomi/extraction";
import { FakeLlmClient } from "@lomi/extraction/testing";
import { LocalFileStorage } from "@lomi/storage";
import { finalizeRun } from "../src/finalize.js";
import { createLlmFor } from "../src/llm-for-user.js";
import { processRun, type ProcessRunDeps } from "../src/process-run.js";
import { startTestDb } from "./setup.js";

const fixtures = resolve(import.meta.dirname, "../../../assignment/fixtures/documents");
const KEK = "11".repeat(32);

let db: Db;
let stop: () => Promise<void>;
let storageDir: string;
let storage: LocalFileStorage;
let userId: string;

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  storageDir = await mkdtemp(join(tmpdir(), "lomi-worker-"));
  storage = new LocalFileStorage(storageDir);
  userId = (await ensureLocalUser(db)).id;
});
afterAll(async () => {
  await stop?.();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

const f = (value: unknown, evidence: string | null, gap_reason: string | null = null) => ({ value, evidence, gap_reason });

const V1_OUTPUT = {
  invoice_number: f("INV-2025-0847", "Invoice Number: INV-2025-0847"),
  issue_date: f("2025-09-14", "Issue Date: 2025-09-14"),
  due_date: f("2025-10-14", "Due Date: 2025-10-14"),
  vendor_name: f("MERIDIAN OFFICE SUPPLIES LLC", "MERIDIAN OFFICE SUPPLIES LLC"),
  total_amount: f({ amount: "5230.29", currency: "USD" }, "Total Due: $5,230.29"),
};
const V2_OUTPUT = {
  ...V1_OUTPUT,
  due_date: f("2025-11-13", "Due Date: 2025-11-13"),
  total_amount: f({ amount: "6126.45", currency: "USD" }, "Total Due: $6,126.45"),
};

async function stored(file: string) {
  return storePdf(storage, file, new Uint8Array(await readFile(join(fixtures, file))));
}

async function newInvoice() {
  return createDocumentWithVersion(db, { userId, type: "invoice", title: "Invoice", file: await stored("invoice-001.pdf") });
}

function deps(llm: LlmClient, over: Partial<ProcessRunDeps> = {}): ProcessRunDeps & { enqueue: ReturnType<typeof vi.fn> } {
  const enqueue = vi.fn(async () => {});
  return { db, storage, llmFor: async () => llm, enqueue, ...over } as ProcessRunDeps & {
    enqueue: ReturnType<typeof vi.fn>;
  };
}

/** Values + decisions as processRun would compute them for invoice v1 (no baseline). */
async function assembled() {
  const text = await extractPdfText(new Uint8Array(await readFile(join(fixtures, "invoice-001.pdf"))));
  const values = assembleValues("invoice", text, V1_OUTPUT);
  return { values, decisions: diffAgainstBaseline(values, null) };
}

const run = async (id: string) => (await db.select().from(extractionRuns).where(eq(extractionRuns.id, id)))[0]!;
const valuesOf = (versionId: string) => db.select().from(extractedValues).where(eq(extractedValues.versionId, versionId));
const detail = (documentId: string, versionNumber?: number) =>
  getDocumentDetail(db, { documentId, userId, ...(versionNumber ? { versionNumber } : {}) });

describe("processRun", () => {
  it("happy path: extracts 5 values and stores prompt + raw response", async () => {
    const doc = await newInvoice();
    const llm = new FakeLlmClient(() => V1_OUTPUT);
    expect(await processRun(deps(llm), doc.runId)).toBe("extracted");
    expect(await valuesOf(doc.versionId)).toHaveLength(5);
    const d = await detail(doc.documentId);
    expect(d!.status).toBe("extracted");
    expect(d!.values.every((v) => v.gapReason === null && v.changeStatus === "new")).toBe(true);
    const r = await run(doc.runId);
    expect(r.prompt).not.toBeNull();
    expect(r.rawResponse).not.toBeNull();
    expect(r.finishedAt).not.toBeNull();
    const [ver] = await db.select().from(documentVersions).where(eq(documentVersions.id, doc.versionId));
    expect(ver!.parsedText).toContain("Total Due: $5,230.29");
  });

  it("duplicate delivery: one extracts, one is skipped", async () => {
    const doc = await newInvoice();
    const llm = new FakeLlmClient(() => V1_OUTPUT);
    const results = await Promise.all([processRun(deps(llm), doc.runId), processRun(deps(llm), doc.runId)]);
    expect(results.sort()).toEqual(["extracted", "skipped"]);
    expect(await valuesOf(doc.versionId)).toHaveLength(5);
    expect(llm.calls).toHaveLength(1);
  });

  it("retry after success: a second run for the same version writes nothing", async () => {
    const doc = await newInvoice();
    const llm = new FakeLlmClient(() => V1_OUTPUT);
    expect(await processRun(deps(llm), doc.runId)).toBe("extracted");

    // finalizing an already-extracted run is refused
    expect(
      await finalizeRun(db, { runId: doc.runId, values: [], decisions: [], prompt: {}, raw: {} }),
    ).toBe(false);

    const [r2] = await db
      .insert(extractionRuns)
      .values({ versionId: doc.versionId, attempt: 2, status: "queued" })
      .returning({ id: extractionRuns.id });
    await db.update(documentVersions).set({ activeRunId: r2!.id }).where(eq(documentVersions.id, doc.versionId));

    expect(await processRun(deps(llm), r2!.id)).not.toBe("extracted");
    const vals = await valuesOf(doc.versionId);
    expect(vals).toHaveLength(5);
    expect(vals.every((v) => v.runId === doc.runId)).toBe(true);
    expect((await run(r2!.id)).status).not.toBe("extracting");
    expect((await detail(doc.documentId))!.status).toBe("extracted");
  });

  it("finalize after the reconciler failed the run (lease lost) is refused", async () => {
    const doc = await newInvoice();
    expect(await claimRun(db, doc.runId)).not.toBeNull();
    await db
      .update(extractionRuns)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(extractionRuns.id, doc.runId));
    const next = await markFailed(db, doc.runId, { kind: "transient", message: "worker lost lease" });
    expect(next).not.toBeNull();

    expect(await finalizeRun(db, { runId: doc.runId, ...(await assembled()), prompt: {}, raw: {} })).toBe(false);
    expect(await valuesOf(doc.versionId)).toHaveLength(0);
    expect((await run(doc.runId)).status).toBe("failed");
    const [ver] = await db.select().from(documentVersions).where(eq(documentVersions.id, doc.versionId));
    expect(ver!.activeRunId).toBe(next);
    expect(await run(next!)).toMatchObject({ status: "queued", attempt: 2 });
  });

  it("finalize waiting on the document lock re-reads run state after the reconciler commits", async () => {
    const doc = await newInvoice();
    expect(await claimRun(db, doc.runId)).not.toBeNull();
    const args = { runId: doc.runId, ...(await assembled()), prompt: {}, raw: {} };
    let finalizing!: Promise<boolean>;
    let next: string | null = null;
    await db.transaction(async (tx) => {
      // The "reconciler" fails the run and holds the document lock until commit.
      next = await markFailed(tx, doc.runId, { kind: "transient", message: "worker lost lease" });
      finalizing = finalizeRun(db, args); // other connection: blocks on the document lock
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(await finalizing).toBe(false);
    expect(await valuesOf(doc.versionId)).toHaveLength(0);
    expect((await run(doc.runId)).status).toBe("failed");
    const [ver] = await db.select().from(documentVersions).where(eq(documentVersions.id, doc.versionId));
    expect(ver!.activeRunId).toBe(next);
    expect(await run(next!)).toMatchObject({ status: "queued", attempt: 2 });
  });

  it("supersede before LLM:an old version's run stops without calling the model", async () => {
    const doc = await newInvoice();
    await addVersion(db, { documentId: doc.documentId, userId, file: await stored("invoice-001.v2.pdf") });
    const llm = new FakeLlmClient(() => V1_OUTPUT);
    expect(await processRun(deps(llm), doc.runId)).toBe("superseded");
    expect(llm.calls).toHaveLength(0);
    expect((await run(doc.runId)).status).toBe("superseded");
  });

  it("transient failures retry up to attempt 3, then the document is failed", async () => {
    const doc = await newInvoice();
    const llm = new FakeLlmClient(() => {
      throw new LlmError("transient", "upstream 503", 503);
    });
    const d = deps(llm);
    expect(await processRun(d, doc.runId)).toBe("failed");
    const r1 = await run(doc.runId);
    expect(r1).toMatchObject({ status: "failed", errorKind: "transient", error: "upstream 503" });
    expect(r1.prompt).not.toBeNull();

    const [ver] = await db.select().from(documentVersions).where(eq(documentVersions.id, doc.versionId));
    const run2 = await run(ver!.activeRunId!);
    expect(run2).toMatchObject({ status: "queued", attempt: 2 });
    expect(d.enqueue).toHaveBeenCalledWith(run2.id);

    expect(await processRun(d, run2.id)).toBe("failed");
    const [ver2] = await db.select().from(documentVersions).where(eq(documentVersions.id, doc.versionId));
    const run3 = await run(ver2!.activeRunId!);
    expect(run3).toMatchObject({ status: "queued", attempt: 3 });

    expect(await processRun(d, run3.id)).toBe("failed");
    expect(d.enqueue).toHaveBeenCalledTimes(2);
    const all = await db.select().from(extractionRuns).where(eq(extractionRuns.versionId, doc.versionId));
    expect(all).toHaveLength(3);
    expect((await detail(doc.documentId))!.status).toBe("failed");
  });

  it("permanent failure: document failed with the error stored", async () => {
    const doc = await newInvoice();
    const llm = new FakeLlmClient(() => {
      throw new LlmError("permanent", "401 invalid api key", 401);
    });
    const d = deps(llm);
    expect(await processRun(d, doc.runId)).toBe("failed");
    expect(d.enqueue).not.toHaveBeenCalled();
    const dd = await detail(doc.documentId);
    expect(dd!.status).toBe("failed");
    expect(dd!.latestRun!.error).toBe("401 invalid api key");
    expect((await run(doc.runId)).errorKind).toBe("permanent");
  });

  it("unexpected exceptions fail the run permanently instead of leaving it extracting", async () => {
    const doc = await newInvoice();
    const llm = new FakeLlmClient(() => {
      throw new Error("kaboom");
    });
    expect(await processRun(deps(llm), doc.runId)).toBe("failed");
    expect(await run(doc.runId)).toMatchObject({ status: "failed", errorKind: "permanent", error: "kaboom" });
  });

  it("missing source file: permanent failure, model never called", async () => {
    const doc = await newInvoice();
    const empty = new LocalFileStorage(await mkdtemp(join(tmpdir(), "lomi-empty-")));
    const llm = new FakeLlmClient(() => V1_OUTPUT);
    expect(await processRun(deps(llm, { storage: empty }), doc.runId)).toBe("failed");
    expect(llm.calls).toHaveLength(0);
    expect(await run(doc.runId)).toMatchObject({ status: "failed", errorKind: "permanent", error: "source file missing" });
  });

  it("a quote not in the text becomes a gap", async () => {
    const doc = await newInvoice();
    const llm = new FakeLlmClient(() => ({
      ...V1_OUTPUT,
      total_amount: f({ amount: "5230.29", currency: "USD" }, "Grand total: 5230.29 dollars"),
    }));
    expect(await processRun(deps(llm), doc.runId)).toBe("extracted");
    const [total] = (await valuesOf(doc.versionId)).filter((v) => v.fieldName === "total_amount");
    expect(total).toMatchObject({ value: null, gapReason: "evidence not found verbatim in document text" });
  });

  it("missing and unexpected fields: due_date gap, extras ignored, 5 values", async () => {
    const doc = await newInvoice();
    const { due_date: _omit, ...rest } = V1_OUTPUT;
    void _omit;
    const llm = new FakeLlmClient(() => ({ ...rest, foo: f("bar", "bar") }));
    expect(await processRun(deps(llm), doc.runId)).toBe("extracted");
    const vals = await valuesOf(doc.versionId);
    expect(vals).toHaveLength(5);
    expect(vals.find((v) => v.fieldName === "foo")).toBeUndefined();
    expect(vals.find((v) => v.fieldName === "due_date")).toMatchObject({
      value: null,
      gapReason: "field missing from model output",
    });
  });

  it("heartbeat extends the lease while the model call is in flight", async () => {
    const doc = await newInvoice();
    const leases: Date[] = [];
    const llm = new FakeLlmClient(async () => {
      leases.push((await run(doc.runId)).leaseExpiresAt!);
      await new Promise((r) => setTimeout(r, 150));
      leases.push((await run(doc.runId)).leaseExpiresAt!);
      return V1_OUTPUT;
    });
    expect(await processRun(deps(llm, { heartbeatMs: 20, leaseMs: 60_000 }), doc.runId)).toBe("extracted");
    expect(leases[1]!.getTime()).toBeGreaterThan(leases[0]!.getTime());
  });

  it("re-extraction: only the 2 changed fields are pending, the rest carry their reviews", async () => {
    const doc = await newInvoice();
    expect(await processRun(deps(new FakeLlmClient(() => V1_OUTPUT)), doc.runId)).toBe("extracted");

    const v1Values = await valuesOf(doc.versionId);
    const v1ReviewIds = new Map<string, string>();
    for (const v of v1Values) {
      const corrected = v.fieldName === "vendor_name";
      const res = await insertReview(db, {
        valueId: v.id,
        userId,
        action: corrected ? "corrected" : "approved",
        correctedValue: corrected ? "Meridian Office Supplies LLC" : null,
        note: corrected ? "title case" : null,
      });
      if (!("id" in res)) throw new Error("review failed");
      v1ReviewIds.set(v.fieldName, res.id);
    }

    const v2 = await addVersion(db, { documentId: doc.documentId, userId, file: await stored("invoice-001.v2.pdf") });
    expect(await processRun(deps(new FakeLlmClient(() => V2_OUTPUT)), v2.runId)).toBe("extracted");

    const d = (await detail(doc.documentId))!;
    expect(d.currentVersion).toBe(2);
    const byField = new Map(d.values.map((v) => [v.fieldName, v]));
    for (const name of ["due_date", "total_amount"]) {
      const v = byField.get(name)!;
      expect(v.latestReview).toBeNull();
      expect(v.changeStatus).toBe("changed");
      expect(v.previous).not.toBeNull();
    }
    for (const name of ["invoice_number", "issue_date", "vendor_name"]) {
      const v = byField.get(name)!;
      expect(v.changeStatus).toBe("unchanged");
      expect(v.latestReview!.origin).toBe("carried_over");
    }
    expect(byField.get("vendor_name")!.latestReview).toMatchObject({
      action: "correct",
      correctedValue: "Meridian Office Supplies LLC",
      note: "title case",
    });
    expect(byField.get("vendor_name")!.effectiveValue).toBe("Meridian Office Supplies LLC");

    const v2Values = await valuesOf(v2.versionId);
    const v1ById = new Map(v1Values.map((v) => [v.fieldName, v.id]));
    for (const v of v2Values.filter((x) => x.changeStatus === "changed")) {
      expect(v.previousValueId).toBe(v1ById.get(v.fieldName));
    }
    const carried = await db.select().from(reviews).where(eq(reviews.origin, "carried_over"));
    const v2Ids = new Map(v2Values.map((v) => [v.id, v.fieldName]));
    const mine = carried.filter((r) => v2Ids.has(r.valueId));
    expect(mine).toHaveLength(3);
    for (const r of mine) expect(r.carriedFromReviewId).toBe(v1ReviewIds.get(v2Ids.get(r.valueId)!));

    expect(await getProgress(db, { documentId: doc.documentId, userId })).toEqual({
      pending: 2,
      approved: 0,
      corrected: 0,
      carried_over: 3,
      total: 5,
    });

    const old = (await detail(doc.documentId, 1))!;
    expect(old.values).toHaveLength(5);
    expect(old.values.every((v) => v.latestReview?.origin === "manual")).toBe(true);
  });
});

describe("llmFor", () => {
  it("local user with no env and no stored config: run fails with 'No LLM configured'", async () => {
    const doc = await newInvoice();
    const llmFor = createLlmFor({ db, authMode: "local", env: {}, keyEncryptionKey: undefined });
    expect(await processRun({ db, storage, llmFor, enqueue: async () => {} }, doc.runId)).toBe("failed");
    expect(await run(doc.runId)).toMatchObject({ status: "failed", errorKind: "permanent", error: "No LLM configured" });
  });

  it("local user: env LLM_* wins over stored config; stored config is decrypted otherwise", async () => {
    const made: ClientOptions[] = [];
    const makeClient = (o: ClientOptions): LlmClient => {
      made.push(o);
      return new FakeLlmClient(() => ({}));
    };
    await db
      .update(users)
      .set({ baseUrl: "http://localhost:11434/v1", model: "stored-model", encryptedKey: encryptKey("stored-key", KEK) })
      .where(eq(users.id, userId));
    try {
      const env = { LLM_BASE_URL: "http://localhost:8080/v1", LLM_API_KEY: "env-key", LLM_MODEL: "env-model" };
      await createLlmFor({ db, authMode: "local", env, keyEncryptionKey: KEK, makeClient })(userId);
      await createLlmFor({ db, authMode: "local", env: {}, keyEncryptionKey: KEK, makeClient })(userId);
    } finally {
      await db.update(users).set({ baseUrl: null, model: null, encryptedKey: null }).where(eq(users.id, userId));
    }
    expect(made[0]).toMatchObject({ baseUrl: "http://localhost:8080/v1", apiKey: "env-key", model: "env-model", allowPrivateHosts: true });
    expect(made[1]).toMatchObject({ baseUrl: "http://localhost:11434/v1", apiKey: "stored-key", model: "stored-model", allowPrivateHosts: true });
  });

  it("byok user: stored key is decrypted and private hosts are not allowed", async () => {
    const [u] = await db
      .insert(users)
      .values({
        identityHash: "byok-user",
        isLocal: false,
        baseUrl: "https://api.example.com/v1",
        model: "m",
        encryptedKey: encryptKey("sk-byok", KEK),
      })
      .returning({ id: users.id });
    const made: ClientOptions[] = [];
    const env = { LLM_BASE_URL: "http://localhost:8080/v1", LLM_API_KEY: "env-key", LLM_MODEL: "env-model" };
    await createLlmFor({
      db,
      authMode: "byok",
      env,
      keyEncryptionKey: KEK,
      makeClient: (o) => {
        made.push(o);
        return new FakeLlmClient(() => ({}));
      },
    })(u!.id);
    expect(made[0]).toMatchObject({ baseUrl: "https://api.example.com/v1", apiKey: "sk-byok", model: "m", allowPrivateHosts: false });
    await db.delete(users).where(and(eq(users.id, u!.id)));
  });
});
