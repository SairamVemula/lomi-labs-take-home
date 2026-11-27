import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalFileStorage } from "@lomi/storage";
import {
  claimRun,
  decryptKey,
  ensureLocalUser,
  extractionRuns,
  markFailed,
  seedWorkspace,
  sessions,
  users,
  type Db,
} from "@lomi/db";
import { LlmError } from "@lomi/extraction";
import { KEK, createTestApp, fixturesDir, type TestApp } from "./app.js";
import { startTestDb } from "./setup.js";

let db: Db;
let stop: () => Promise<void>;
let t: TestApp;
let tEnv: TestApp;

const body = { baseUrl: "http://localhost:11434/v1", apiKey: "sk-local-secret", model: "llama3" };

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const user = await ensureLocalUser(db);
  const storage = new LocalFileStorage(await mkdtemp(join(tmpdir(), "seed-")));
  const runIds = await seedWorkspace(db, storage, user.id, fixturesDir);
  // Every seeded run fails permanently, like a stack started with no LLM configured.
  for (const id of runIds) {
    await claimRun(db, id);
    await markFailed(db, id, { kind: "permanent", message: "No LLM configured" });
  }
  t = await createTestApp(db, { AUTH_MODE: "local", PUBLIC_ORIGIN: "http://localhost:3000" });
  tEnv = await createTestApp(db, {
    AUTH_MODE: "local",
    PUBLIC_ORIGIN: "http://localhost:3000",
    LLM_BASE_URL: "http://localhost:11434/v1",
    LLM_MODEL: "llama3",
  });
});
afterAll(async () => {
  await t?.close();
  await tEnv?.close();
  await stop?.();
});

describe("AUTH_MODE=local", () => {
  it("serves the 3 seeded documents without a cookie and never sets one", async () => {
    const res = await request(t.app.getHttpServer()).get("/documents");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.headers["set-cookie"]).toBeUndefined();
    const health = await request(t.app.getHttpServer()).get("/health");
    expect(health.body).toEqual({ ok: true });
    expect(health.headers["set-cookie"]).toBeUndefined();
  });

  it("has no login: POST /auth/login and /auth/logout are 404, no session rows", async () => {
    const res = await request(t.app.getHttpServer()).post("/auth/login").send(body);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "NOT_FOUND" });
    expect((await request(t.app.getHttpServer()).post("/auth/logout")).status).toBe(404);
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it("GET /auth/me describes the local user", async () => {
    const res = await request(t.app.getHttpServer()).get("/auth/me");
    expect(res.body).toEqual({ mode: "local", model: null, baseUrl: null });
  });

  it("without env LLM: unconfigured, then PUT /settings/llm requeues failed runs", async () => {
    const http = t.app.getHttpServer();
    const before = await request(http).get("/auth/config");
    expect(before.body).toMatchObject({ mode: "local", llmConfigured: false, llmSource: null });
    expect(before.body.presets.map((p: { name: string }) => p.name)).toEqual(
      expect.arrayContaining(["OpenAI", "Anthropic", "OpenRouter", "Groq", "Ollama", "LM Studio"]),
    );
    const lmStudio = before.body.presets.find((p: { name: string }) => p.name === "LM Studio");
    expect(lmStudio.baseUrl).toBe("http://host.docker.internal:1234/v1");

    // A keyless local server that can't be reached is "unreachable", not a rejected key, and the
    // message points at the Docker localhost pitfall.
    t.verifier.mockRejectedValueOnce(new LlmError("transient", "Connection error."));
    const unreachable = await request(http)
      .put("/settings/llm")
      .send({ baseUrl: "http://localhost:1234/v1", model: "qwen3-8b" });
    expect(unreachable.status).toBe(400);
    expect(unreachable.body.code).toBe("PROVIDER_UNREACHABLE");
    expect(unreachable.body.message).toContain("host.docker.internal");
    expect(unreachable.body.message).not.toContain("[redacted]");

    const bad = await request(http).put("/settings/llm").send({ baseUrl: "nope" });
    expect(bad.status).toBe(400);

    t.verifier.mockRejectedValueOnce(new LlmError("permanent", "401 invalid api key", 401));
    const rejected = await request(http).put("/settings/llm").send(body);
    expect(rejected.status).toBe(401);
    expect(rejected.body).toMatchObject({ code: "PROVIDER_REJECTED" });
    expect(t.queueAdd).not.toHaveBeenCalled();

    const ok = await request(http).put("/settings/llm").send(body);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ llmConfigured: true, retried: 3 });
    expect(JSON.stringify(ok.body)).not.toContain(body.apiKey);
    expect(t.verifier).toHaveBeenLastCalledWith({ ...body, allowPrivateHosts: true });
    expect(t.queueAdd).toHaveBeenCalledTimes(3);

    const runs = await db.select().from(extractionRuns).where(eq(extractionRuns.attempt, 2));
    expect(runs.map((r) => r.status)).toEqual(["queued", "queued", "queued"]);

    const after = await request(http).get("/auth/config");
    expect(after.body).toMatchObject({ llmConfigured: true, llmSource: "settings" });
    expect(JSON.stringify(after.body)).not.toContain(body.apiKey);
    const me = await request(http).get("/auth/me");
    expect(me.body).toEqual({ mode: "local", model: "llama3", baseUrl: body.baseUrl });

    const [local] = await db.select().from(users).where(eq(users.isLocal, true));
    expect(decryptKey(local!.encryptedKey!, KEK)).toBe(body.apiKey);

    // Keyless local servers (LM Studio, Ollama): saving without an API key works.
    const keyless = await request(http)
      .put("/settings/llm")
      .send({ baseUrl: "http://host.docker.internal:1234/v1", model: "qwen3-8b" });
    expect(keyless.status).toBe(200);
    expect(t.verifier).toHaveBeenLastCalledWith({
      baseUrl: "http://host.docker.internal:1234/v1",
      apiKey: "",
      model: "qwen3-8b",
      allowPrivateHosts: true,
    });
    const [after2] = await db.select().from(users).where(eq(users.isLocal, true));
    expect(decryptKey(after2!.encryptedKey!, KEK)).toBe("");
  });

  it("enqueue failures never fail the request", async () => {
    const failing = await createTestApp(db, { AUTH_MODE: "local" }, { queueAdd: () => Promise.reject(new Error("redis down")) });
    try {
      const res = await request(failing.app.getHttpServer()).put("/settings/llm").send(body);
      expect(res.status).toBe(200);
    } finally {
      await failing.close();
    }
  });

  it("with env LLM set: source is env and PUT /settings/llm is 409 ENV_CONFIGURED", async () => {
    const http = tEnv.app.getHttpServer();
    const cfg = await request(http).get("/auth/config");
    expect(cfg.body).toMatchObject({ llmConfigured: true, llmSource: "env" });
    const res = await request(http).put("/settings/llm").send(body);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "ENV_CONFIGURED" });
  });
});
