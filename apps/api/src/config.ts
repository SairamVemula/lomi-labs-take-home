import { resolve } from "node:path";

export type AuthMode = "local" | "byok";
export type LlmEnv = { LLM_BASE_URL?: string; LLM_API_KEY?: string; LLM_MODEL?: string };

export type ApiConfig = {
  databaseUrl: string;
  redisUrl: string;
  authMode: AuthMode;
  publicOrigin: string;
  /** Cookies get the Secure flag when the public origin is https. */
  secureCookies: boolean;
  sessionSecret: string | undefined;
  keyEncryptionKey: string | undefined;
  llmEnv: LlmEnv;
  fixturesDir: string;
  port: number;
  /** POST /auth/login attempts per minute per IP. */
  loginRateLimit: number;
  /** Reverse-proxy hops to trust for the client IP (the web app proxies /api/*). */
  trustProxyHops: number;
};

type Env = Record<string, string | undefined>;

const get = (env: Env, k: string): string | undefined => {
  const v = env[k]?.trim();
  return v ? v : undefined;
};

const int = (env: Env, k: string, dflt: number): number => {
  const v = get(env, k);
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${k} must be a non-negative integer, got "${v}"`);
  return n;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** Same guard as the worker: AUTH_MODE=local has no login, so it must only ever be served on loopback. */
export function assertLocalModeIsLocal(authMode: AuthMode, publicOrigin: string): void {
  if (authMode !== "local") return;
  let host: string;
  try {
    host = new URL(publicOrigin).hostname;
  } catch {
    throw new Error(`PUBLIC_ORIGIN is not a valid URL: ${publicOrigin}`);
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `AUTH_MODE=local is only allowed when PUBLIC_ORIGIN is localhost (got host "${host}"; allowed: localhost, 127.0.0.1). ` +
        `Use AUTH_MODE=byok for public deployments.`,
    );
  }
}

export function loadConfig(env: Env): ApiConfig {
  const databaseUrl = get(env, "DATABASE_URL");
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const redisUrl = get(env, "REDIS_URL");
  if (!redisUrl) throw new Error("REDIS_URL is required");

  const mode = get(env, "AUTH_MODE") ?? "local";
  if (mode !== "local" && mode !== "byok") throw new Error(`AUTH_MODE must be "local" or "byok", got "${mode}"`);
  const publicOrigin = get(env, "PUBLIC_ORIGIN") ?? "http://localhost:3000";
  assertLocalModeIsLocal(mode, publicOrigin);

  const keyEncryptionKey = get(env, "KEY_ENCRYPTION_KEY");
  if (mode === "byok" && !keyEncryptionKey) throw new Error("KEY_ENCRYPTION_KEY is required when AUTH_MODE=byok");
  if (keyEncryptionKey && !/^[0-9a-fA-F]{64}$/.test(keyEncryptionKey)) {
    throw new Error("KEY_ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
  }
  const sessionSecret = get(env, "SESSION_SECRET");
  if (mode === "byok" && !sessionSecret) throw new Error("SESSION_SECRET is required when AUTH_MODE=byok");

  const llmEnv: LlmEnv = {};
  for (const k of ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"] as const) {
    const v = get(env, k);
    if (v) llmEnv[k] = v;
  }

  return {
    databaseUrl,
    redisUrl,
    authMode: mode,
    publicOrigin,
    secureCookies: new URL(publicOrigin).protocol === "https:",
    sessionSecret,
    keyEncryptionKey,
    llmEnv,
    // dist/config.js and src/config.ts are both three levels below the repo root.
    fixturesDir: get(env, "FIXTURES_DIR") ?? resolve(import.meta.dirname, "../../../assignment/fixtures"),
    port: int(env, "PORT", 3001),
    loginRateLimit: int(env, "LOGIN_RATE_LIMIT", 10),
    trustProxyHops: int(env, "TRUST_PROXY_HOPS", 1),
  };
}

/** True when the .env LLM_* pair is set (it wins over stored settings in local mode). */
export function hasEnvLlm(c: ApiConfig): boolean {
  return Boolean(c.llmEnv.LLM_BASE_URL && c.llmEnv.LLM_MODEL);
}
