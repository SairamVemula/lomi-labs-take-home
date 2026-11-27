import { createStorage } from "@lomi/storage";
import { createDb } from "./client.js";
import { migrateToLatest } from "./migrate.js";
import { ensureLocalUser } from "./repo/users.js";
import { seedWorkspace } from "./seed.js";

/**
 * Container entrypoint for the compose `migrate` service: migrate to latest, then (AUTH_MODE=local only)
 * create the local user and seed version 1 of the fixture documents. Idempotent; exits 0 when done.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  await migrateToLatest(url);
  console.log("migrate: migrations applied");

  const mode = process.env.AUTH_MODE?.trim() || "local";
  if (mode !== "local") {
    console.log(`migrate: AUTH_MODE=${mode}, skipping seed`);
    return;
  }
  const storage = createStorage(process.env);
  const fixturesDir = process.env.FIXTURES_DIR?.trim() || "/app/assignment/fixtures";
  const { db, close } = createDb(url);
  try {
    const user = await ensureLocalUser(db);
    const runs = await seedWorkspace(db, storage, user.id, fixturesDir);
    console.log(`migrate: seeded ${runs.length} new document(s) (storage: ${storage.kind})`);
  } finally {
    await close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
