import { and, eq, gt, sql } from "drizzle-orm";
import { sessions, users, type User } from "../schema.js";
import type { Queryable } from "../client.js";

export async function createSession(
  db: Queryable,
  args: { tokenHash: string; userId: string; expiresAt: Date },
): Promise<void> {
  await db.insert(sessions).values(args);
}

/**
 * Resolve a live session to its user and slide its expiry to `newExpiresAt` (also touches
 * users.last_seen_at). Returns null when the token is unknown or expired.
 */
export async function touchSession(
  db: Queryable,
  tokenHash: string,
  newExpiresAt: Date,
): Promise<User | null> {
  const [s] = await db
    .update(sessions)
    .set({ expiresAt: newExpiresAt })
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, sql`now()`)))
    .returning({ userId: sessions.userId });
  if (!s) return null;
  const [u] = await db.update(users).set({ lastSeenAt: sql`now()` }).where(eq(users.id, s.userId)).returning();
  return u ?? null;
}

/** Delete a session; returns the owning user id when it existed. */
export async function deleteSession(db: Queryable, tokenHash: string): Promise<string | null> {
  const [s] = await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash)).returning({ userId: sessions.userId });
  return s?.userId ?? null;
}
