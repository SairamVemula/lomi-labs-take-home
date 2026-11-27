import { assertNoDevSecretsInByok } from "@lomi/shared";
export type AuthMode = "local" | "byok";
export type LlmEnv = { LLM_BASE_URL?: string; LLM_API_KEY?: string; LLM_MODEL?: string };

export type WorkerConfig = {
  databaseUrl: string;
  redisUrl: string;
  authMode: AuthMode;
  publicOrigin: string;
  keyEncryptionKey: string | undefined;
  llmEnv: LlmEnv;
  concurrency: number;
};

type Env = Record<string, string | undefined>;

const get = (env: Env, k: string): string | undefined => {
  const v = env[k]?.trim();
  return v ? v : undefined;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** Throws when AUTH_MODE=local (no login) would be served on a non-loopback origin. */
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
      `Refusing to start: AUTH_MODE=local has no login, but PUBLIC_ORIGIN host is "${host}" ` +
        `(allowed: localhost, 127.0.0.1). Use AUTH_MODE=byok for public deployments.`,
    );
  }
}

export function loadConfig(env: Env): WorkerConfig {
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

  if (mode === "byok") assertNoDevSecretsInByok({ sessionSecret: get(env, "SESSION_SECRET"), keyEncryptionKey });

  const llmEnv: LlmEnv = {};
  for (const k of ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"] as const) {
    const v = get(env, k);
    if (v) llmEnv[k] = v;
  }

  return { databaseUrl, redisUrl, authMode: mode, publicOrigin, keyEncryptionKey, llmEnv, concurrency: 4 };
}
