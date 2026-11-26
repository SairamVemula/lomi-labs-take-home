import { Inject, Injectable } from "@nestjs/common";
import {
  clearEncryptedKey,
  createSession,
  deleteSession,
  encryptKey,
  identityHash,
  saveLlmConfig,
  seedWorkspace,
  upsertUserByIdentity,
  type Db,
  type User,
} from "@lomi/db";
import { LlmError, SsrfBlockedError, type ClientOptions } from "@lomi/extraction";
import type { LoginRequest } from "@lomi/shared";
import type { FileStorage } from "@lomi/storage";
import type { ApiConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { RunEnqueuer } from "../queue.js";
import { CONFIG, DATABASE, PROVIDER_VERIFIER, STORAGE } from "../tokens.js";
import { SESSION_TTL_MS, hashToken, newSessionToken } from "./session-cookie.js";

export type ProviderVerifier = (opts: ClientOptions) => Promise<void>;

const isBlockedHost = (e: unknown): boolean =>
  e instanceof SsrfBlockedError ||
  (e instanceof LlmError && e.kind === "permanent" && /https required|blocked/i.test(e.message));

@Injectable()
export class AuthService {
  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(DATABASE) private readonly database: { db: Db },
    @Inject(STORAGE) private readonly storage: FileStorage,
    @Inject(PROVIDER_VERIFIER) private readonly verifier: ProviderVerifier,
    @Inject(RunEnqueuer) private readonly enqueuer: RunEnqueuer,
  ) {}

  /** One json_schema chat completion against the user's endpoint; failures become API errors. */
  async verifyProvider(body: LoginRequest): Promise<void> {
    try {
      await this.verifier({ ...body, allowPrivateHosts: this.config.authMode === "local" });
    } catch (e) {
      const message = (e instanceof Error ? e.message : String(e)).split(body.apiKey).join("[redacted]");
      if (isBlockedHost(e)) throw new ApiError(400, "INVALID_BASE_URL", message);
      throw new ApiError(401, "PROVIDER_REJECTED", message);
    }
  }

  /** byok login: returns the session token and the user. Seeds the workspace for a new user. */
  async login(body: LoginRequest): Promise<{ token: string; user: User }> {
    await this.verifyProvider(body);
    const { db } = this.database;
    const { user, created } = await upsertUserByIdentity(db, {
      identityHash: identityHash(this.config.sessionSecret!, body.baseUrl, body.apiKey),
      baseUrl: body.baseUrl,
      model: body.model,
      encryptedKey: encryptKey(body.apiKey, this.config.keyEncryptionKey!),
    });
    if (created) {
      const runIds = await seedWorkspace(db, this.storage, user.id, this.config.fixturesDir);
      await this.enqueuer.enqueue(runIds);
    }
    const token = newSessionToken();
    await createSession(db, {
      tokenHash: hashToken(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });
    return { token, user };
  }

  /** Drop the session and its user's stored key. Idempotent. */
  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    const userId = await deleteSession(this.database.db, hashToken(token));
    if (userId) await clearEncryptedKey(this.database.db, userId);
  }

  /** local mode: store the already-verified config for the local user. */
  async saveLocalConfig(userId: string, body: LoginRequest): Promise<void> {
    if (!this.config.keyEncryptionKey) {
      throw new ApiError(500, "NOT_CONFIGURED", "KEY_ENCRYPTION_KEY must be set to store an LLM key");
    }
    await saveLlmConfig(this.database.db, userId, {
      baseUrl: body.baseUrl,
      model: body.model,
      encryptedKey: encryptKey(body.apiKey, this.config.keyEncryptionKey),
    });
  }
}
