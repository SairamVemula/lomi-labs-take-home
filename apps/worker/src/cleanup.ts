import { and, eq, lt } from "drizzle-orm";
import { listReferencedStorageKeys, users, type Db } from "@lomi/db";
import type { FileStorage } from "@lomi/storage";

const DAY_MS = 86_400_000;
const IDLE_USER_MS = 7 * DAY_MS;
/** Files younger than this may belong to an upload whose DB row is not committed yet. */
const ORPHAN_MIN_AGE_MS = 60 * 60_000;

/**
 * Delete non-local users idle for more than 7 days; FK cascades remove their sessions, documents,
 * versions, runs, values and reviews. Returns the number of users deleted.
 */
export async function cleanupIdleUsers(db: Db, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - IDLE_USER_MS);
  const deleted = await db
    .delete(users)
    .where(and(eq(users.isLocal, false), lt(users.lastSeenAt, cutoff)))
    .returning({ id: users.id });
  return deleted.length;
}

/** Delete `pdfs/` files older than 1h that no document version references. Returns deleted keys. */
export async function sweepOrphanFiles(db: Db, storage: FileStorage, now: Date): Promise<string[]> {
  const cutoff = now.getTime() - ORPHAN_MIN_AGE_MS;
  const files = await storage.list("pdfs/");
  const candidates = files.filter((f) => f.lastModified.getTime() < cutoff);
  if (candidates.length === 0) return [];
  // Read references after listing: a file whose row committed in between is then seen as referenced.
  const referenced = await listReferencedStorageKeys(db);
  const deleted: string[] = [];
  for (const { key } of candidates) {
    if (referenced.has(key)) continue;
    await storage.delete(key);
    deleted.push(key);
  }
  return deleted;
}
