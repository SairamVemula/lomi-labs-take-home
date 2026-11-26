import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Repo functions accept either the top-level db or a transaction. */
export type Queryable = Db | Tx;

export function createDb(databaseUrl: string): { db: Db; close: () => Promise<void> } {
  const client = postgres(databaseUrl, { max: 10 });
  return { db: drizzle(client, { schema }), close: () => client.end() };
}

/** True for a Postgres unique_violation (23505), however the driver wraps it. */
export function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 4 && e && typeof e === "object"; i++) {
    if ((e as { code?: unknown }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** Run `fn` in a transaction, reusing the caller's transaction (savepoint) when given one. */
export function inTx<T>(db: Queryable, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (db as Db).transaction(fn);
}
