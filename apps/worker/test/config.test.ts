import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = { DATABASE_URL: "postgres://x/y", REDIS_URL: "redis://localhost:6379" };

describe("loadConfig", () => {
  it("defaults to local mode on localhost", () => {
    const c = loadConfig({ ...base });
    expect(c).toMatchObject({ authMode: "local", publicOrigin: "http://localhost:3000", concurrency: 4, llmEnv: {} });
  });

  it.each(["http://localhost:3000", "http://127.0.0.1:8080", "https://localhost"])(
    "accepts AUTH_MODE=local with PUBLIC_ORIGIN %s",
    (origin) => {
      expect(loadConfig({ ...base, AUTH_MODE: "local", PUBLIC_ORIGIN: origin }).authMode).toBe("local");
    },
  );

  it.each(["https://lomi.example.com", "http://0.0.0.0:3000", "http://localhost.evil.com"])(
    "refuses AUTH_MODE=local with PUBLIC_ORIGIN %s",
    (origin) => {
      expect(() => loadConfig({ ...base, AUTH_MODE: "local", PUBLIC_ORIGIN: origin })).toThrow(/AUTH_MODE=local/);
    },
  );

  it("byok mode allows a public origin but requires a valid KEY_ENCRYPTION_KEY", () => {
    const env = { ...base, AUTH_MODE: "byok", PUBLIC_ORIGIN: "https://lomi.example.com" };
    expect(() => loadConfig(env)).toThrow(/KEY_ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...env, KEY_ENCRYPTION_KEY: "abc" })).toThrow(/KEY_ENCRYPTION_KEY/);
    expect(loadConfig({ ...env, KEY_ENCRYPTION_KEY: "ab".repeat(32) }).authMode).toBe("byok");
  });

  it("rejects unknown AUTH_MODE and missing urls", () => {
    expect(() => loadConfig({ ...base, AUTH_MODE: "guest" })).toThrow(/AUTH_MODE/);
    expect(() => loadConfig({ REDIS_URL: base.REDIS_URL })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: base.DATABASE_URL })).toThrow(/REDIS_URL/);
  });

  it("passes LLM_* through", () => {
    const c = loadConfig({ ...base, LLM_BASE_URL: "http://localhost:11434/v1", LLM_MODEL: "llama", LLM_API_KEY: "k" });
    expect(c.llmEnv).toEqual({ LLM_BASE_URL: "http://localhost:11434/v1", LLM_MODEL: "llama", LLM_API_KEY: "k" });
  });
});
