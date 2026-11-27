import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Progress } from "@lomi/shared";
import { inTx, type Queryable } from "../client.js";
import { documents, documentVersions, extractedValues, reviews } from "../schema.js";

export type ReviewRow = typeof reviews.$inferSelect;

export const EMPTY_PROGRESS: Progress = { pending: 0, approved: 0, corrected: 0, carried_over: 0, total: 0 };

/**
 * The single source of truth for progress buckets, used by getProgress and listDocuments.
 * Buckets are exclusive: no review -> pending; latest review carried_over -> carried_over;
 * else by the latest manual review's action.
 */
export async function progressByVersion(db: Queryable, versionIds: string[]): Promise<Map<string, Progress>> {
  const out = new Map<string, Progress>();
  if (versionIds.length === 0) return out;
  const ids = sql.join(
    versionIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = await db.execute<{
    version_id: string;
    total: number;
    pending: number;
    approved: number;
    corrected: number;
    carried_over: number;
  }>(sql`
    SELECT ev.version_id,
           count(*)::int AS total,
           (count(*) FILTER (WHERE r.id IS NULL))::int AS pending,
           (count(*) FILTER (WHERE r.origin = 'carried_over'))::int AS carried_over,
           (count(*) FILTER (WHERE r.origin = 'manual' AND r.action = 'approved'))::int AS approved,
           (count(*) FILTER (WHERE r.origin = 'manual' AND r.action = 'corrected'))::int AS corrected
    FROM extracted_values ev
    LEFT JOIN LATERAL (
      SELECT id, action, origin FROM reviews
      WHERE value_id = ev.id
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ) r ON true
    WHERE ev.version_id IN (${ids})
    GROUP BY ev.version_id
  `);
  for (const r of rows) {
    out.set(r.version_id, {
      pending: r.pending,
      approved: r.approved,
      corrected: r.corrected,
      carried_over: r.carried_over,
      total: r.total,
    });
  }
  return out;
}

/** Latest review per value (DISTINCT ON value_id, newest first). */
export async function latestReviews(db: Queryable, valueIds: string[]): Promise<Map<string, ReviewRow>> {
  const out = new Map<string, ReviewRow>();
  if (valueIds.length === 0) return out;
  const rows = await db
    .selectDistinctOn([reviews.valueId])
    .from(reviews)
    .where(inArray(reviews.valueId, valueIds))
    .orderBy(reviews.valueId, desc(reviews.createdAt), desc(reviews.id));
  for (const r of rows) out.set(r.valueId, r);
  return out;
}

export async function getProgress(
  db: Queryable,
  args: { documentId: string; userId: string },
): Promise<Progress | null> {
  const [doc] = await db
    .select({ currentVersionId: documents.currentVersionId })
    .from(documents)
    .where(and(eq(documents.id, args.documentId), eq(documents.userId, args.userId)));
  if (!doc) return null;
  if (!doc.currentVersionId) return { ...EMPTY_PROGRESS };
  const map = await progressByVersion(db, [doc.currentVersionId]);
  return map.get(doc.currentVersionId) ?? { ...EMPTY_PROGRESS };
}

/**
 * Append a manual review. Callers pass an already-normalized correctedValue; this does not normalize.
 * Locks the owning document so a concurrent addVersion cannot flip "current" mid-check.
 */
export async function insertReview(
  db: Queryable,
  args: {
    valueId: string;
    userId: string;
    action: "approved" | "corrected";
    correctedValue: unknown;
    note: string | null;
  },
): Promise<{ id: string } | { error: "NOT_FOUND" | "VALUE_NOT_CURRENT" }> {
  return inTx(db, async (tx) => {
    const [owner] = await tx
      .select({ documentId: documents.id })
      .from(extractedValues)
      .innerJoin(documentVersions, eq(documentVersions.id, extractedValues.versionId))
      .innerJoin(documents, eq(documents.id, documentVersions.documentId))
      .where(and(eq(extractedValues.id, args.valueId), eq(documents.userId, args.userId)));
    if (!owner) return { error: "NOT_FOUND" as const };

    const [row] = await tx
      .select({ versionId: extractedValues.versionId, currentVersionId: documents.currentVersionId })
      .from(documents)
      .innerJoin(extractedValues, eq(extractedValues.id, args.valueId))
      .where(eq(documents.id, owner.documentId))
      .for("update", { of: documents });
    if (!row || row.versionId !== row.currentVersionId) return { error: "VALUE_NOT_CURRENT" as const };

    const [inserted] = await tx
      .insert(reviews)
      .values({
        valueId: args.valueId,
        action: args.action,
        correctedValue: args.action === "approved" ? null : args.correctedValue,
        note: args.note,
        origin: "manual",
      })
      .returning({ id: reviews.id });
    return { id: inserted!.id };
  });
}
