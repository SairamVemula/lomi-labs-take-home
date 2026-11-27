import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalFileStorage, type FileStorage } from "@lomi/storage";
import { NO_LLM_ERROR, decryptKey, documentVersions, documents, extractionRuns, sessions, users, type Db } from "@lomi/db";
import { LlmError, SsrfBlockedError } from "@lomi/extraction";
import { KEK, createTestApp, type TestApp } from "./app.js";
import { startTestDb } from "./setup.js";

let db: Db;
let stop: () => Promise<void>;
let t: TestApp;

const keyA = { baseUrl: "https://api.example.com/v1", apiKey: "sk-secret-A", model: "gpt-x" };
const keyB = { baseUrl: "https://api.example.com/v1", apiKey: "sk-secret-B", model: "gpt-x" };
const setCookies = (res: request.Response): string[] => (res.headers["set-cookie"] as unknown as string[] | undefined) ?? [];
const sid = (res: request.Response): string => setCookies(res).find((c) => c.startsWith("sid="))?.split(";")[0] ?? "";
const byokUsers = async () => (await db.select().from(users)).filter((u) => !u.isLocal);

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  t = await createTestApp(db, { AUTH_MODE: "byok", PUBLIC_ORIGIN: "https://lomi.example.com", LOGIN_RATE_LIMIT: "1000" });
});
afterAll(async () => {
  await t?.close();
  await stop?.();
});

describe("AUTH_MODE=byok", () => {
  it("rejects unauthenticated requests with 401 and the standard error body", async () => {
    const res = await request(t.app.getHttpServer()).get("/documents");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ code: "UNAUTHENTICATED", message: expect.any(String) });
    expect((await request(t.app.getHttpServer()).get("/health")).status).toBe(200);
    expect((await request(t.app.getHttpServer()).get("/auth/me")).status).toBe(401);
  });

  it("login sets an HttpOnly SameSite=Lax Secure cookie, seeds, enqueues, and never echoes the key", async () => {
    const res = await request(t.app.getHttpServer()).post("/auth/login").send(keyA);
    expect(res.status).toBe(200);
    const cookie = setCookies(res).find((c) => c.startsWith("sid="))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Secure/);
    expect(res.body).toEqual({ mode: "byok", model: "gpt-x", baseUrl: keyA.baseUrl });
    expect(JSON.stringify(res.body)).not.toContain("sk-secret");
    expect(t.verifier).toHaveBeenLastCalledWith({ ...keyA, allowPrivateHosts: false });
    expect(t.queueAdd).toHaveBeenCalledTimes(3);

    const [u] = await byokUsers();
    expect(decryptKey(u!.encryptedKey!, KEK)).toBe("sk-secret-A");
    const [s] = await db.select().from(sessions);
    expect(s!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(cookie).not.toContain(s!.tokenHash);

    const docs = await request(t.app.getHttpServer()).get("/documents").set("Cookie", sid(res));
    expect(docs.status).toBe(200);
    expect(docs.body).toHaveLength(3);
    expect(JSON.stringify(docs.body)).not.toContain("sk-secret");
    const cfg = await request(t.app.getHttpServer()).get("/auth/config").set("Cookie", sid(res));
    expect(cfg.body).toMatchObject({ mode: "byok", llmConfigured: true, llmSource: "settings" });
    expect(JSON.stringify(cfg.body)).not.toContain("sk-secret");
  });

  it("same key twice -> same user, still 3 documents; different key -> different user", async () => {
    const http = t.app.getHttpServer();
    const adds = t.queueAdd.mock.calls.length;
    const a1 = await request(http).post("/auth/login").send(keyA);
    const a2 = await request(http).post("/auth/login").send({ ...keyA, model: "gpt-y" });
    const [ua] = await byokUsers();
    expect(await db.select().from(documents).where(eq(documents.userId, ua!.id))).toHaveLength(3);
    expect(t.queueAdd.mock.calls.length).toBe(adds); // no reseed, nothing to enqueue
    expect((await request(http).get("/auth/me").set("Cookie", sid(a2))).body.model).toBe("gpt-y");
    expect(sid(a1)).not.toBe(sid(a2));

    const b = await request(http).post("/auth/login").send(keyB);
    expect(await byokUsers()).toHaveLength(2);
    const docsB = await request(http).get("/documents").set("Cookie", sid(b));
    expect(docsB.body).toHaveLength(3);
    const idsA: string[] = (await request(http).get("/documents").set("Cookie", sid(a1))).body.map((d: { id: string }) => d.id);
    expect(docsB.body.some((d: { id: string }) => idsA.includes(d.id))).toBe(false);
  });

  it("validates the body (400) and maps provider failures", async () => {
    const http = t.app.getHttpServer();
    expect((await request(http).post("/auth/login").send({ baseUrl: "x" })).status).toBe(400);

    t.verifier.mockRejectedValueOnce(new LlmError("permanent", "https required"));
    const ssrf = await request(http).post("/auth/login").send({ ...keyA, baseUrl: "http://10.0.0.5/v1" });
    expect(ssrf.status).toBe(400);
    expect(ssrf.body).toMatchObject({ code: "INVALID_BASE_URL" });
    expect(ssrf.body.message).toMatch(/https required|blocked/);

    t.verifier.mockRejectedValueOnce(new LlmError("permanent", "blocked address 10.0.0.5"));
    expect((await request(http).post("/auth/login").send(keyA)).body.code).toBe("INVALID_BASE_URL");

    t.verifier.mockRejectedValueOnce(new SsrfBlockedError("blocked address 10.0.0.5"));
    expect((await request(http).post("/auth/login").send(keyA)).body.code).toBe("INVALID_BASE_URL");

    t.verifier.mockRejectedValueOnce(new LlmError("permanent", "401 Incorrect API key", 401));
    const rejected = await request(http).post("/auth/login").send(keyA);
    expect(rejected.status).toBe(401);
    expect(rejected.body.code).toBe("PROVIDER_REJECTED");
    expect(setCookies(rejected)).toHaveLength(0);

    t.verifier.mockRejectedValueOnce(new LlmError("transient", "Connection error."));
    const unreachable = await request(http).post("/auth/login").send(keyA);
    expect(unreachable.status).toBe(400);
    expect(unreachable.body.code).toBe("PROVIDER_UNREACHABLE");
  });

  it("byok login still requires an API key", async () => {
    const res = await request(t.app.getHttpServer()).post("/auth/login").send({ ...keyA, apiKey: "" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("API_KEY_REQUIRED");
    expect(t.verifier).not.toHaveBeenCalledWith(expect.objectContaining({ apiKey: "" }));
  });

  it("settings are local-only: PUT /settings/llm is 404", async () => {
    const login = await request(t.app.getHttpServer()).post("/auth/login").send(keyA);
    const res = await request(t.app.getHttpServer()).put("/settings/llm").set("Cookie", sid(login)).send(keyA);
    expect(res.status).toBe(404);
  });

  it("logout deletes the session, clears the stored key and invalidates the cookie", async () => {
    const http = t.app.getHttpServer();
    const login = await request(http).post("/auth/login").send(keyB);
    const cookie = sid(login);
    const out = await request(http).post("/auth/logout").set("Cookie", cookie);
    expect(out.status).toBe(200);
    expect(setCookies(out)[0]).toMatch(/^sid=;/);
    expect((await request(http).get("/documents").set("Cookie", cookie)).status).toBe(401);
    const all = await byokUsers();
    expect(all.filter((u) => u.encryptedKey === null)).toHaveLength(1); // only keyB's user lost its key
  });

  it("re-login retries runs that failed with 'No LLM configured', but not genuine failures", async () => {
    const http = t.app.getHttpServer();
    const keyC = { ...keyA, apiKey: "sk-secret-C" };
    const login = await request(http).post("/auth/login").send(keyC);
    const [user] = (await byokUsers()).filter((u) => u.encryptedKey !== null && decryptKey(u.encryptedKey, KEK) === "sk-secret-C");
    const docs = (await db.select().from(documents)).filter((d) => d.userId === user!.id);
    expect(docs.length).toBeGreaterThanOrEqual(2);
    const runs = await Promise.all(
      docs.map(async (d) => {
        const [v] = await db.select().from(documentVersions).where(eq(documentVersions.id, d.currentVersionId!));
        return v!.activeRunId!;
      }),
    );
    await request(http).post("/auth/logout").set("Cookie", sid(login));
    await db.update(extractionRuns).set({ status: "failed", error: NO_LLM_ERROR, errorKind: "permanent" }).where(eq(extractionRuns.id, runs[0]!));
    await db.update(extractionRuns).set({ status: "failed", error: "provider exploded", errorKind: "permanent" }).where(eq(extractionRuns.id, runs[1]!));
    t.queueAdd.mockClear();
    const again = await request(http).post("/auth/login").send(keyC);
    expect(again.status).toBe(200);
    const fresh = await db.select().from(extractionRuns).where(eq(extractionRuns.versionId, docs[0]!.currentVersionId!));
    expect(fresh.filter((r) => r.status === "queued")).toHaveLength(1);
    const other = await db.select().from(extractionRuns).where(eq(extractionRuns.versionId, docs[1]!.currentVersionId!));
    expect(other.filter((r) => r.status === "queued")).toHaveLength(0);
    expect(t.queueAdd).toHaveBeenCalledTimes(1);
  });

  it("expired sessions are rejected and a live one slides its expiry", async () => {
    const http = t.app.getHttpServer();
    const login = await request(http).post("/auth/login").send(keyA);
    const cookie = sid(login);
    await db.update(sessions).set({ expiresAt: new Date(Date.now() + 60_000) });
    expect((await request(http).get("/documents").set("Cookie", cookie)).status).toBe(200);
    const rows = await db.select().from(sessions);
    expect(rows.filter((r) => r.expiresAt.getTime() > Date.now() + 120_000)).toHaveLength(1);
    expect(Math.max(...rows.map((r) => r.expiresAt.getTime()))).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await request(http).get("/documents").set("Cookie", cookie)).status).toBe(401);
  });

  it("throttles POST /auth/login per IP", async () => {
    const limited = await createTestApp(db, {
      AUTH_MODE: "byok",
      PUBLIC_ORIGIN: "https://lomi.example.com",
      LOGIN_RATE_LIMIT: "2",
    });
    try {
      const http = limited.app.getHttpServer();
      expect((await request(http).post("/auth/login").send(keyA)).status).toBe(200);
      expect((await request(http).post("/auth/login").send(keyA)).status).toBe(200);
      const third = await request(http).post("/auth/login").send(keyA);
      expect(third.status).toBe(429);
      expect(third.body).toMatchObject({ code: "RATE_LIMITED" });
      expect((await request(http).get("/health")).status).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it("heals a failed first seeding: the next login with the same key seeds the workspace", async () => {
    const real = new LocalFileStorage(await mkdtemp(join(tmpdir(), "heal-")));
    let failures = 1;
    const flaky: FileStorage = {
      kind: real.kind,
      put: async (key, bytes, contentType) => {
        if (failures-- > 0) throw new Error("storage blip");
        void contentType;
        return real.put(key, bytes);
      },
      get: (k) => real.get(k),
      exists: (k) => real.exists(k),
      delete: (k) => real.delete(k),
      list: (p) => real.list(p),
      signedGetUrl: () => real.signedGetUrl(),
    };
    const app = await createTestApp(
      db,
      { AUTH_MODE: "byok", PUBLIC_ORIGIN: "https://lomi.example.com", LOGIN_RATE_LIMIT: "100" },
      { storage: flaky },
    );
    try {
      const http = app.app.getHttpServer();
      const key = { baseUrl: "https://heal.example.com/v1", apiKey: "sk-heal", model: "m" };
      const first = await request(http).post("/auth/login").send(key);
      expect(first.status).toBe(500);
      expect(sid(first)).toBe("");
      const second = await request(http).post("/auth/login").send(key);
      expect(second.status).toBe(200);
      const docs = await request(http).get("/documents").set("Cookie", sid(second));
      expect(docs.body).toHaveLength(3);
      expect(app.queueAdd).toHaveBeenCalledTimes(3);
    } finally {
      await app.close();
    }
  });

  it("throttles per client IP behind two proxies (TRUST_PROXY_HOPS=2)", async () => {
    const app = await createTestApp(db, {
      AUTH_MODE: "byok",
      PUBLIC_ORIGIN: "https://lomi.example.com",
      TRUST_PROXY_HOPS: "2",
      LOGIN_RATE_LIMIT: "10",
    });
    try {
      const http = app.app.getHttpServer();
      const post = (client: string) =>
        request(http).post("/auth/login").set("X-Forwarded-For", `${client}, 172.18.0.5`).send({});
      for (let i = 0; i < 10; i++) expect((await post("203.0.113.1")).status).not.toBe(429);
      expect((await post("203.0.113.1")).status).toBe(429);
      expect((await post("203.0.113.2")).status).not.toBe(429);
    } finally {
      await app.close();
    }
  });
});
