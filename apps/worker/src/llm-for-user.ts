import { eq } from "drizzle-orm";
import { NO_LLM_ERROR, decryptKey, users, type Queryable } from "@lomi/db";
import { LlmError, createOpenAiCompatibleClient, type ClientOptions, type LlmClient } from "@lomi/extraction";
import type { AuthMode, LlmEnv } from "./config.js";

export type LlmForOptions = {
  db: Queryable;
  authMode: AuthMode;
  env: LlmEnv;
  keyEncryptionKey: string | undefined;
  makeClient?: (opts: ClientOptions) => LlmClient;
};

/**
 * Resolve the LLM client for a document owner.
 * Local user: env LLM_* -> stored config -> none. BYOK user: stored config only.
 * Missing config is a permanent failure ("No LLM configured").
 */
export function createLlmFor(o: LlmForOptions): (userId: string) => Promise<LlmClient> {
  const make = o.makeClient ?? createOpenAiCompatibleClient;
  const allowPrivateHosts = o.authMode === "local";
  return async (userId) => {
    const [u] = await o.db.select().from(users).where(eq(users.id, userId));
    if (!u) throw new LlmError("permanent", "document owner not found");
    if (u.isLocal && o.env.LLM_BASE_URL && o.env.LLM_MODEL) {
      return make({
        baseUrl: o.env.LLM_BASE_URL,
        // Local servers such as Ollama ignore the key, but the SDK requires a non-empty one.
        apiKey: o.env.LLM_API_KEY || "not-needed",
        model: o.env.LLM_MODEL,
        allowPrivateHosts,
      });
    }
    if (u.baseUrl && u.model && u.encryptedKey) {
      if (!o.keyEncryptionKey) throw new LlmError("permanent", "KEY_ENCRYPTION_KEY is not configured");
      return make({
        baseUrl: u.baseUrl,
        apiKey: decryptKey(u.encryptedKey, o.keyEncryptionKey),
        model: u.model,
        allowPrivateHosts,
      });
    }
    throw new LlmError("permanent", NO_LLM_ERROR);
  };
}
