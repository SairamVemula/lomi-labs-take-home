import { users, type User } from "../schema.js";
import type { Queryable } from "../client.js";

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
