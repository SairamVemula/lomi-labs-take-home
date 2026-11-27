import { asc, eq, getTableColumns, sql } from "drizzle-orm";
import { documents, users, type User } from "../schema.js";
import type { Queryable } from "../client.js";
import { createRetryRun } from "./runs.js";

export type { User };

/** Idempotent upsert of the built-in local user (identity_hash = 'local'). */
export async function ensureLocalUser(db: Queryable): Promise<User> {
  const [row] = await db
    .insert(users)
    .values({ identityHash: "local", isLocal: true, baseUrl: null, model: null, encryptedKey: null })
    .onConflictDoUpdate({ target: users.identityHash, set: { isLocal: true } })
    .returning();
  return row!;
}

/** Store (or replace) a user's LLM config; the key must already be encrypted. */
export async function saveLlmConfig(
  db: Queryable,
  userId: string,
  cfg: { baseUrl: string; model: string; encryptedKey: Buffer },
): Promise<void> {
  await db
    .update(users)
    .set({ baseUrl: cfg.baseUrl, model: cfg.model, encryptedKey: cfg.encryptedKey })
    .where(eq(users.id, userId));
}

/**
 * Upsert a BYOK user by identity hash, refreshing endpoint, model and encrypted key.
 * `created` is true only for the call that inserted the row.
 */
export async function upsertUserByIdentity(
  db: Queryable,
  args: { identityHash: string; baseUrl: string; model: string; encryptedKey: Buffer },
): Promise<{ user: User; created: boolean }> {
  const [row] = await db
    .insert(users)
    .values({
      identityHash: args.identityHash,
      baseUrl: args.baseUrl,
      model: args.model,
      encryptedKey: args.encryptedKey,
      isLocal: false,
    })
    .onConflictDoUpdate({
      target: users.identityHash,
      set: { baseUrl: args.baseUrl, model: args.model, encryptedKey: args.encryptedKey, lastSeenAt: sql`now()` },
    })
    .returning({ ...getTableColumns(users), created: sql<boolean>`(xmax = 0)` });
  const { created, ...user } = row!;
  return { user, created };
}

/** Wipe a user's stored key (logout). */
export async function clearEncryptedKey(db: Queryable, userId: string): Promise<void> {
  await db.update(users).set({ encryptedKey: null }).where(eq(users.id, userId));
}

/**
 * Queue a fresh attempt for every document of the user whose current version's active run
 * has failed (with `onlyError`: failed with exactly that error). Returns the new run ids
 * (callers enqueue them).
 */
export async function retryFailedRunsForUser(
  db: Queryable,
  userId: string,
  opts: { onlyError?: string } = {},
): Promise<string[]> {
  const docs = await db
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.userId, userId))
    .orderBy(asc(documents.createdAt), asc(documents.id));
  const runIds: string[] = [];
  for (const d of docs) {
    const r = await createRetryRun(db, { documentId: d.id, userId, onlyError: opts.onlyError });
    if ("runId" in r) runIds.push(r.runId);
  }
  return runIds;
}
