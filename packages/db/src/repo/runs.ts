import { and, eq, sql } from "drizzle-orm";
import { inTx, type Queryable } from "../client.js";
import { documents, documentVersions, extractionRuns } from "../schema.js";

/**
 * Queue a new attempt for the current version, only when its active run failed.
 * Locks the document row so concurrent retries/uploads serialize.
 */
export async function createRetryRun(
  db: Queryable,
  args: { documentId: string; userId: string },
): Promise<{ runId: string } | { error: "NOT_FAILED" | "NOT_FOUND" }> {
  return inTx(db, async (tx) => {
    const [doc] = await tx
      .select({ currentVersionId: documents.currentVersionId })
      .from(documents)
      .where(and(eq(documents.id, args.documentId), eq(documents.userId, args.userId)))
      .for("update");
    if (!doc?.currentVersionId) return { error: "NOT_FOUND" as const };

    const [ver] = await tx
      .select({ activeRunId: documentVersions.activeRunId })
      .from(documentVersions)
      .where(eq(documentVersions.id, doc.currentVersionId));
    const [active] = ver?.activeRunId
      ? await tx.select({ status: extractionRuns.status }).from(extractionRuns).where(eq(extractionRuns.id, ver.activeRunId))
      : [];
    if (active?.status !== "failed") return { error: "NOT_FAILED" as const };

    const [{ next }] = (await tx
      .select({ next: sql<number>`coalesce(max(${extractionRuns.attempt}), 0) + 1` })
      .from(extractionRuns)
      .where(eq(extractionRuns.versionId, doc.currentVersionId))) as [{ next: number }];
    const [run] = await tx
      .insert(extractionRuns)
      .values({ versionId: doc.currentVersionId, attempt: next, status: "queued" })
      .returning({ id: extractionRuns.id });
    await tx.update(documentVersions).set({ activeRunId: run!.id }).where(eq(documentVersions.id, doc.currentVersionId));
    return { runId: run!.id };
  });
}
