import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import request from "supertest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { documents, documentVersions, extractedValues, extractionRuns, type Db } from "@lomi/db";
import { LocalFileStorage, S3FileStorage, type FileStorage } from "@lomi/storage";
import { createTestApp, type TestApp } from "./app.js";
import { startTestDb } from "./setup.js";

let db: Db;
let stop: () => Promise<void>;
let t: TestApp;
let storage: FileStorage;
let s3: StartedTestContainer;
let tS3: TestApp;
let s3Storage: S3FileStorage;

const pdf = (body = "hello") => Buffer.from(`%PDF-1.4\n${body}\n%%EOF`);
const keyFor = (n: string) => ({ baseUrl: "https://api.example.com/v1", apiKey: `sk-${n}`, model: "m" });
const http = () => t.app.getHttpServer();

async function login(app: TestApp, name: string): Promise<string> {
  const res = await request(app.app.getHttpServer()).post("/auth/login").send(keyFor(name));
  expect(res.status).toBe(200);
  const c = (res.headers["set-cookie"] as unknown as string[]).find((x) => x.startsWith("sid="))!;
  return c.split(";")[0]!;
}

/** A user with no seeded docs is not possible via login, so work with the seeded ones plus new uploads. */
async function upload(cookie: string, name = "Invoice 001.PDF", type = "invoice", bytes = pdf()) {
  return request(http())
    .post("/documents")
    .set("Cookie", cookie)
    .field("type", type)
    .attach("file", bytes, { filename: name, contentType: "application/pdf" });
}

/** Pretend the worker finished: give the document's current version two values. */
async function fakeExtract(documentId: string): Promise<{ money: string; date: string; versionId: string }> {
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
  const versionId = doc!.currentVersionId!;
  const [ver] = await db.select().from(documentVersions).where(eq(documentVersions.id, versionId));
  const runId = ver!.activeRunId!;
  await db.update(extractionRuns).set({ status: "extracted" }).where(eq(extractionRuns.id, runId));
  const rows = await db
    .insert(extractedValues)
    .values([
      { versionId, runId, fieldName: "total_amount", fieldType: "money", value: { amount: "10.00", currency: "USD" }, changeStatus: "new" },
      { versionId, runId, fieldName: "invoice_date", fieldType: "date", value: "2026-01-02", changeStatus: "new" },
    ])
    .returning();
  return {
    versionId,
    money: rows.find((r) => r.fieldType === "money")!.id,
    date: rows.find((r) => r.fieldType === "date")!.id,
  };
}

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  storage = new LocalFileStorage(await mkdtemp(join(tmpdir(), "docs-")));
  t = await createTestApp(
    db,
    { AUTH_MODE: "byok", PUBLIC_ORIGIN: "https://lomi.example.com", LOGIN_RATE_LIMIT: "1000" },
    { storage },
  );
  s3 = await new GenericContainer(process.env.S3_TEST_IMAGE ?? "rustfs/rustfs")
    .withExposedPorts(9000)
    .withEnvironment({ RUSTFS_ACCESS_KEY: "minioadmin", RUSTFS_SECRET_KEY: "minioadmin" })
    .withWaitStrategy(Wait.forHttp("/health", 9000))
    .start();
  const cfg = {
    endpoint: `http://${s3.getHost()}:${s3.getMappedPort(9000)}`,
    region: "us-east-1",
    bucket: "test-bucket",
    accessKeyId: "minioadmin",
    secretAccessKey: "minioadmin",
    forcePathStyle: true,
  };
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  await client.send(new CreateBucketCommand({ Bucket: cfg.bucket }));
  client.destroy();
  s3Storage = new S3FileStorage(cfg);
  tS3 = await createTestApp(
    db,
    { AUTH_MODE: "byok", PUBLIC_ORIGIN: "https://lomi.example.com", LOGIN_RATE_LIMIT: "1000" },
    { storage: s3Storage },
  );
}, 180_000);

afterAll(async () => {
  await t?.close();
  await tS3?.close();
  await s3?.stop();
  await stop?.();
});

describe("uploads", () => {
  it("returns 201 without waiting on anything and enqueues the run by id", async () => {
    const c = await login(t, "upload-a");
    t.queueAdd.mockClear();
    const started = Date.now();
    const res = await upload(c);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String), status: "queued", version: 1 });
    const [ver] = await db.select().from(documentVersions).where(eq(documentVersions.documentId, res.body.id));
    expect(t.queueAdd).toHaveBeenCalledTimes(1);
    expect(t.queueAdd.mock.calls[0]![2]).toMatchObject({ jobId: ver!.activeRunId });
    const [doc] = await db.select().from(documents).where(eq(documents.id, res.body.id));
    expect(doc!.title).toBe("Invoice 001");
  });

  it("uses an explicit title and stores the file under the slug+sha key", async () => {
    const c = await login(t, "upload-b");
    const res = await request(http())
      .post("/documents")
      .set("Cookie", c)
      .field("type", "lease")
      .field("title", "  My lease ")
      .attach("file", pdf("keys"), { filename: "Invoice 001.PDF", contentType: "application/pdf" });
    expect(res.status).toBe(201);
    const [doc] = await db.select().from(documents).where(eq(documents.id, res.body.id));
    expect(doc!.title).toBe("My lease");
    const [ver] = await db.select().from(documentVersions).where(eq(documentVersions.documentId, res.body.id));
    expect(ver!.storageKey).toMatch(/^pdfs\/invoice-001-[0-9a-f]{64}\.pdf$/);
    expect(await storage.exists(ver!.storageKey)).toBe(true);
    expect(ver!.originalFilename).toBe("Invoice 001.PDF");
  });

  it("still returns 201 and leaves the run queued when the queue (Redis) is down", async () => {
    const c = await login(t, "upload-c");
    t.queueAdd.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res = await upload(c, "down.pdf", "invoice", pdf("down"));
    expect(res.status).toBe(201);
    const [ver] = await db.select().from(documentVersions).where(eq(documentVersions.documentId, res.body.id));
    const [run] = await db.select().from(extractionRuns).where(eq(extractionRuns.id, ver!.activeRunId!));
    expect(run!.status).toBe("queued");
  });

  it("validates: missing file, not a pdf, bad type, too large", async () => {
    const c = await login(t, "validate");
    const noFile = await request(http()).post("/documents").set("Cookie", c).field("type", "invoice");
    expect(noFile.status).toBe(400);
    expect(noFile.body.code).toBe("FILE_REQUIRED");

    const txt = await upload(c, "fake.pdf", "invoice", Buffer.from("just some text"));
    expect(txt.status).toBe(400);
    expect(txt.body.code).toBe("NOT_A_PDF");

    const badType = await upload(c, "a.pdf", "receipt");
    expect(badType.status).toBe(400);
    expect(badType.body.code).toBe("INVALID_TYPE");
    const noType = await request(http())
      .post("/documents")
      .set("Cookie", c)
      .attach("file", pdf(), { filename: "a.pdf", contentType: "application/pdf" });
    expect(noType.body.code).toBe("INVALID_TYPE");

    const big = Buffer.concat([pdf(), Buffer.alloc(5 * 1024 * 1024)]);
    const tooBig = await upload(c, "big.pdf", "invoice", big);
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.code).toBe("FILE_TOO_LARGE");
  });

  it("returns 500 STORAGE_UNAVAILABLE and writes no rows when storage put fails", async () => {
    const c = await login(t, "storage-fail");
    const before = (await db.select().from(documents)).length;
    const spy = vi.spyOn(storage, "put").mockRejectedValueOnce(new Error("disk full"));
    const res = await upload(c, "x.pdf", "invoice", pdf("storage-fail"));
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("STORAGE_UNAVAILABLE");
    expect((await db.select().from(documents)).length).toBe(before);
  });

  it("limits: 429 at 5 in-flight runs, 409 at 25 documents", async () => {
    const c = await login(t, "limits");
    // 3 seeded docs are queued/extracting; two more fill the in-flight budget.
    expect((await upload(c, "l1.pdf", "invoice", pdf("l1"))).status).toBe(201);
    expect((await upload(c, "l2.pdf", "invoice", pdf("l2"))).status).toBe(201);
    const over = await upload(c, "l3.pdf", "invoice", pdf("l3"));
    expect(over.status).toBe(429);
    expect(over.body.code).toBe("TOO_MANY_IN_FLIGHT");

    await db.update(extractionRuns).set({ status: "extracted" });
    const list = await request(http()).get("/documents").set("Cookie", c);
    const have = list.body.length as number;
    for (let i = have; i < 25; i++) {
      await db.update(extractionRuns).set({ status: "extracted" });
      expect((await upload(c, `f${i}.pdf`, "invoice", pdf(`f${i}`))).status).toBe(201);
    }
    await db.update(extractionRuns).set({ status: "extracted" });
    const full = await upload(c, "extra.pdf", "invoice", pdf("extra"));
    expect(full.status).toBe(409);
    expect(full.body.code).toBe("DOCUMENT_LIMIT");
  });
});

describe("versions", () => {
  it("two concurrent uploads become versions 2 and 3; a v1 value is then not reviewable", async () => {
    const c = await login(t, "versions");
    const created = await upload(c, "v.pdf", "invoice", pdf("v1"));
    const id = created.body.id as string;
    const { money } = await fakeExtract(id);
    await db.update(extractionRuns).set({ status: "extracted" });

    const send = (body: string) =>
      request(http())
        .post(`/documents/${id}/versions`)
        .set("Cookie", c)
        .attach("file", pdf(body), { filename: "v.pdf", contentType: "application/pdf" });
    const [a, b] = await Promise.all([send("v2"), send("v3")]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect([a.body.version, b.body.version].sort()).toEqual([2, 3]);
    expect(a.body).toMatchObject({ id, status: "queued" });

    const review = await request(http()).post(`/values/${money}/review`).set("Cookie", c).send({ action: "approve" });
    expect(review.status).toBe(409);
    expect(review.body.code).toBe("VALUE_NOT_CURRENT");

    const detail = await request(http()).get(`/documents/${id}`).set("Cookie", c);
    expect(detail.body.currentVersion).toBe(3);
    expect(detail.body.versions).toHaveLength(3);
    const v1 = await request(http()).get(`/documents/${id}?version=1`).set("Cookie", c);
    expect(v1.status).toBe(200);
    expect(v1.body.viewingVersion).toBe(1);
    expect((await request(http()).get(`/documents/${id}?version=abc`).set("Cookie", c)).status).toBe(400);
    expect((await request(http()).get(`/documents/${id}?version=0`).set("Cookie", c)).status).toBe(400);
    expect((await request(http()).get(`/documents/${id}?version=9`).set("Cookie", c)).status).toBe(404);
  });
});

describe("reviews and progress", () => {
  it("rejects invalid corrections and records valid ones", async () => {
    const c = await login(t, "reviews");
    const created = await upload(c, "r.pdf", "invoice", pdf("r"));
    const id = created.body.id as string;
    const { money, date } = await fakeExtract(id);
    const post = (valueId: string, body: unknown) =>
      request(http()).post(`/values/${valueId}/review`).set("Cookie", c).send(body as object);

    const badMoney = await post(money, { action: "correct", value: "abc" });
    expect(badMoney.status).toBe(400);
    expect(badMoney.body.code).toBe("INVALID_VALUE");
    expect(badMoney.body.message).toContain("money");
    const badDate = await post(date, { action: "correct", value: "31/02/2026" });
    expect(badDate.status).toBe(400);
    expect(badDate.body.message).toContain("date");
    expect((await post(money, { action: "correct" })).body.code).toBe("INVALID_VALUE");
    expect((await post(money, { action: "bogus" })).status).toBe(400);

    const ok = await post(money, { action: "correct", value: "$1,234.50", note: "per page 2" });
    expect(ok.status).toBe(201);
    expect(ok.body.effectiveValue).toEqual({ amount: "1234.50", currency: "USD" });
    expect(ok.body.latestReview).toMatchObject({ action: "correct", note: "per page 2", origin: "manual" });
    const progress = await request(http()).get(`/documents/${id}/progress`).set("Cookie", c);
    expect(progress.status).toBe(200);
    expect(progress.body).toEqual({ pending: 1, approved: 0, corrected: 1, carried_over: 0, total: 2 });

    const approved = await post(date, { action: "approve" });
    expect(approved.status).toBe(201);
    expect(approved.body.latestReview.action).toBe("approve");
    expect((await request(http()).get(`/documents/${id}/progress`).set("Cookie", c)).body).toMatchObject({
      approved: 1,
      corrected: 1,
      pending: 0,
    });
  });
});

describe("retry", () => {
  it("202 for a failed run, 409 NOT_FAILED otherwise", async () => {
    const c = await login(t, "retry");
    const created = await upload(c, "t.pdf", "invoice", pdf("retry"));
    const id = created.body.id as string;
    const notFailed = await request(http()).post(`/documents/${id}/retry`).set("Cookie", c);
    expect(notFailed.status).toBe(409);
    expect(notFailed.body.code).toBe("NOT_FAILED");
    await db.update(extractionRuns).set({ status: "failed", error: "boom" });
    t.queueAdd.mockClear();
    const ok = await request(http()).post(`/documents/${id}/retry`).set("Cookie", c);
    expect(ok.status).toBe(202);
    expect(t.queueAdd).toHaveBeenCalledTimes(1);
    const detail = await request(http()).get(`/documents/${id}`).set("Cookie", c);
    expect(detail.body.status).toBe("queued");
  });
});

describe("ownership", () => {
  it("another user's document and values are 404 on every route; bad ids are 404", async () => {
    const owner = await login(t, "owner");
    const other = await login(t, "intruder");
    const created = await upload(owner, "o.pdf", "invoice", pdf("owned"));
    const id = created.body.id as string;
    const { money } = await fakeExtract(id);
    const pdfBytes = () => pdf("x");
    const checks = await Promise.all([
      request(http()).get(`/documents/${id}`).set("Cookie", other),
      request(http()).get(`/documents/${id}/progress`).set("Cookie", other),
      request(http()).get(`/documents/${id}/versions/1/file`).set("Cookie", other),
      request(http()).post(`/documents/${id}/retry`).set("Cookie", other),
      request(http())
        .post(`/documents/${id}/versions`)
        .set("Cookie", other)
        .attach("file", pdfBytes(), { filename: "a.pdf", contentType: "application/pdf" }),
      request(http()).post(`/values/${money}/review`).set("Cookie", other).send({ action: "approve" }),
      request(http()).get("/documents/not-a-uuid").set("Cookie", owner),
      request(http()).get(`/documents/${id}/versions/zz/file`).set("Cookie", owner),
      request(http()).post("/values/nope/review").set("Cookie", owner).send({ action: "approve" }),
    ]);
    for (const r of checks) {
      expect(r.status).toBe(404);
      expect(r.body.code).toBe("NOT_FOUND");
    }
    const list = await request(http()).get("/documents").set("Cookie", other);
    expect(list.body.some((d: { id: string }) => d.id === id)).toBe(false);
    // the owner's data is untouched
    expect((await request(http()).get(`/documents/${id}`).set("Cookie", owner)).status).toBe(200);
  });
});

describe("file route", () => {
  it("streams the pdf inline for the owner (local storage)", async () => {
    const c = await login(t, "file-local");
    const bytes = pdf("file-bytes");
    const created = await upload(c, 'we"ird\r\nname.pdf', "invoice", bytes);
    const res = await request(http())
      .get(`/documents/${created.body.id}/versions/1/file`)
      .set("Cookie", c)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (d: Buffer) => chunks.push(d));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/pdf/);
    expect(res.headers["content-disposition"]).toBe('inline; filename="we_ird__name.pdf"');
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect((res.body as Buffer).equals(bytes)).toBe(true);
    expect((await request(http()).get(`/documents/${created.body.id}/versions/1/file`)).status).toBe(401);
  });

  it("404 FILE_NOT_FOUND when the stored file is gone", async () => {
    const c = await login(t, "file-gone");
    const created = await upload(c, "gone.pdf", "invoice", pdf("gone"));
    const [ver] = await db.select().from(documentVersions).where(eq(documentVersions.documentId, created.body.id));
    await storage.delete(ver!.storageKey);
    const res = await request(http()).get(`/documents/${created.body.id}/versions/1/file`).set("Cookie", c);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("FILE_NOT_FOUND");
  });

  it("redirects to a signed URL with S3 storage", async () => {
    const c = await login(tS3, "file-s3");
    const bytes = pdf("s3-bytes");
    const created = await request(tS3.app.getHttpServer())
      .post("/documents")
      .set("Cookie", c)
      .field("type", "invoice")
      .attach("file", bytes, { filename: "s3.pdf", contentType: "application/pdf" });
    expect(created.status).toBe(201);
    const res = await request(tS3.app.getHttpServer())
      .get(`/documents/${created.body.id}/versions/1/file`)
      .set("Cookie", c)
      .redirects(0);
    expect(res.status).toBe(302);
    const fetched = await fetch(res.headers.location!);
    expect(fetched.status).toBe(200);
    expect(Buffer.from(await fetched.arrayBuffer()).equals(bytes)).toBe(true);
  });
});
