import { DEV_KEY_ENCRYPTION_KEY, DEV_SESSION_SECRET } from "@lomi/shared";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = { DATABASE_URL: "postgres://x/y", REDIS_URL: "redis://localhost:6379" };
const byok = { SESSION_SECRET: "s3cret", KEY_ENCRYPTION_KEY: "ab".repeat(32) };

describe("loadConfig", () => {
  it("defaults to local mode on localhost", () => {
    const c = loadConfig({ ...base });
    expect(c).toMatchObject({
      authMode: "local",
      publicOrigin: "http://localhost:3000",
      port: 3001,
      secureCookies: false,
      loginRateLimit: 10,
      llmEnv: {},
    });
  });

  it("refuses AUTH_MODE=local on a non-local origin", () => {
    expect(() => loadConfig({ ...base, AUTH_MODE: "local", PUBLIC_ORIGIN: "https://lomi.sairam.cc" })).toThrow(
      "AUTH_MODE=local is only allowed when PUBLIC_ORIGIN is localhost",
    );
    expect(() => loadConfig({ ...base, AUTH_MODE: "local", PUBLIC_ORIGIN: "http://localhost.evil.com" })).toThrow(
      /AUTH_MODE=local/,
    );
  });

  it.each(["http://localhost:3000", "http://127.0.0.1:3000"])("accepts local mode on %s", (origin) => {
    expect(loadConfig({ ...base, AUTH_MODE: "local", PUBLIC_ORIGIN: origin }).authMode).toBe("local");
  });

  it("byok accepts any origin, marks https cookies Secure, and requires secrets", () => {
    const env = { ...base, AUTH_MODE: "byok", PUBLIC_ORIGIN: "https://lomi.sairam.cc" };
    expect(() => loadConfig(env)).toThrow(/KEY_ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...env, KEY_ENCRYPTION_KEY: byok.KEY_ENCRYPTION_KEY })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ ...env, ...byok, KEY_ENCRYPTION_KEY: "abc" })).toThrow(/KEY_ENCRYPTION_KEY/);
    const c = loadConfig({ ...env, ...byok });
    expect(c).toMatchObject({ authMode: "byok", secureCookies: true });
    expect(loadConfig({ ...env, ...byok, PUBLIC_ORIGIN: "http://localhost:3000" }).secureCookies).toBe(false);
  });

  it("reads PORT, FIXTURES_DIR, LOGIN_RATE_LIMIT and LLM_*", () => {
    const c = loadConfig({
      ...base,
      PORT: "4000",
      FIXTURES_DIR: "/fx",
      LOGIN_RATE_LIMIT: "3",
      LLM_BASE_URL: "http://localhost:11434/v1",
      LLM_MODEL: "llama",
    });
    expect(c).toMatchObject({
      port: 4000,
      fixturesDir: "/fx",
      loginRateLimit: 3,
      llmEnv: { LLM_BASE_URL: "http://localhost:11434/v1", LLM_MODEL: "llama" },
    });
    expect(loadConfig({ ...base }).fixturesDir).toMatch(/assignment[\\/]fixtures$/);
  });

  it("rejects bad AUTH_MODE and missing urls", () => {
    expect(() => loadConfig({ ...base, AUTH_MODE: "guest" })).toThrow(/AUTH_MODE/);
    expect(() => loadConfig({ REDIS_URL: base.REDIS_URL })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: base.DATABASE_URL })).toThrow(/REDIS_URL/);
  });
});

describe("dev default secrets", () => {
  const e = { ...base, AUTH_MODE: "byok", PUBLIC_ORIGIN: "https://lomi.example.com" };
  const real = { SESSION_SECRET: "real-secret", KEY_ENCRYPTION_KEY: "ab".repeat(32) };

  it("byok rejects the dev defaults", () => {
    expect(() => loadConfig({ ...e, ...real, SESSION_SECRET: DEV_SESSION_SECRET })).toThrow(/dev defaults/);
    expect(() => loadConfig({ ...e, ...real, KEY_ENCRYPTION_KEY: DEV_KEY_ENCRYPTION_KEY })).toThrow(/dev defaults/);
  });
  it("byok accepts real values", () => {
    expect(loadConfig({ ...e, ...real }).authMode).toBe("byok");
  });
  it("local accepts the dev defaults", () => {
    const c = loadConfig({ ...base, SESSION_SECRET: DEV_SESSION_SECRET, KEY_ENCRYPTION_KEY: DEV_KEY_ENCRYPTION_KEY });
    expect(c.authMode).toBe("local");
  });
});
