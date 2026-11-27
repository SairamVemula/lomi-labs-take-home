import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import type { DocumentType } from "@lomi/shared";
import type { FileStorage } from "@lomi/storage";
import { isUniqueViolation, type Queryable } from "./client.js";
import { createDocumentWithVersion, storePdf } from "./repo/documents.js";
import { documents } from "./schema.js";

type ManifestEntry = {
  id: string;
  type: DocumentType;
  title: string;
  versions: { version: number; file: string }[];
};

/**
 * Seed the manifest documents (version 1 only) with queued runs.
 * Idempotent via unique(user_id, external_id). Returns the created run ids.
 */
export async function seedWorkspace(
  db: Queryable,
  storage: FileStorage,
  userId: string,
  fixturesDir: string,
): Promise<string[]> {
  const manifest = JSON.parse(await readFile(join(fixturesDir, "documents.json"), "utf8")) as ManifestEntry[];
  const runIds: string[] = [];
  for (const entry of manifest) {
    const [existing] = await db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.userId, userId), eq(documents.externalId, entry.id)));
    if (existing) continue;
    const v1 = entry.versions.find((v) => v.version === 1);
    if (!v1) continue;
    const bytes = new Uint8Array(await readFile(join(fixturesDir, v1.file)));
    const file = await storePdf(storage, v1.file.split("/").pop()!, bytes);
    try {
      const r = await createDocumentWithVersion(db, {
        userId,
        type: entry.type,
        title: entry.title,
        externalId: entry.id,
        file,
      });
      runIds.push(r.runId);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err; // lost a race with a concurrent seeder
    }
  }
  return runIds;
}
