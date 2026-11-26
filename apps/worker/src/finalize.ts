import { and, desc, eq, ne, sql } from "drizzle-orm";
import {
  documentVersions,
  extractedValues,
  extractionRuns,
  inTx,
  latestReviews,
  lockDocumentOfRun,
  type Queryable,
  type Tx,
} from "@lomi/db";
import type { AssembledValue, BaselineValue, CarryDecision } from "@lomi/extraction";
import type { FieldValue } from "@lomi/shared";

/**
 * Baseline for carry-over: the most recent *other* version of the same document whose active run
 * is `extracted` (by version_number desc), as fieldName -> value + its latest review.
 */
export async function loadBaseline(db: Queryable, versionId: string): Promise<Map<string, BaselineValue> | null> {
  const [me] = await db
    .select({ documentId: documentVersions.documentId })
    .from(documentVersions)
    .where(eq(documentVersions.id, versionId));
  if (!me) return null;
  const [base] = await db
    .select({ id: documentVersions.id })
    .from(documentVersions)
    .innerJoin(extractionRuns, eq(extractionRuns.id, documentVersions.activeRunId))
    .where(
      and(
        eq(documentVersions.documentId, me.documentId),
        ne(documentVersions.id, versionId),
        eq(extractionRuns.status, "extracted"),
      ),
    )
    .orderBy(desc(documentVersions.versionNumber))
    .limit(1);
  if (!base) return null;

  const rows = await db.select().from(extractedValues).where(eq(extractedValues.versionId, base.id));
  const reviewsById = await latestReviews(
    db,
    rows.map((r) => r.id),
  );
  const out = new Map<string, BaselineValue>();
  for (const r of rows) {
    const rev = reviewsById.get(r.id);
    out.set(r.fieldName, {
      id: r.id,
      value: (r.value ?? null) as FieldValue | null,
      evidence: r.evidence,
      gapReason: r.gapReason,
      latestReview: rev
        ? {
            id: rev.id,
            action: rev.action,
            correctedValue: (rev.correctedValue ?? null) as FieldValue | null,
            note: rev.note,
          }
        : null,
    });
  }
  return out;
}

export type FinalizeArgs = {
  runId: string;
  values: AssembledValue[];
  decisions: CarryDecision[];
  prompt: unknown;
  raw: unknown;
};

/**
 * One transaction: insert all values + carried reviews and mark the run extracted.
 * Guarded by run.status = 'extracting' AND version.active_run_id = run.id (and the version has no
 * values yet). Returns false, writing no values, when the guard fails.
 */
class GuardLost extends Error {}

export async function finalizeRun(db: Queryable, args: FinalizeArgs): Promise<boolean> {
  try {
    return await inTx(db, (tx) => finalizeInTx(tx, args));
  } catch (e) {
    if (e instanceof GuardLost) return false; // rolled back: nothing written
    throw e;
  }
}

async function finalizeInTx(tx: Tx, args: FinalizeArgs): Promise<boolean> {
  // Lock the document first (same lock order as addVersion / insertReview / markFailed), then
  // read run state in a separate statement so it reflects anything committed while we waited.
  if (!(await lockDocumentOfRun(tx, args.runId))) return false;
  const [ctx] = await tx
    .select({
      status: extractionRuns.status,
      versionId: extractionRuns.versionId,
      activeRunId: documentVersions.activeRunId,
    })
    .from(extractionRuns)
    .innerJoin(documentVersions, eq(documentVersions.id, extractionRuns.versionId))
    .where(eq(extractionRuns.id, args.runId));
  if (!ctx || ctx.status !== "extracting" || ctx.activeRunId !== args.runId) return false;

  const [existing] = await tx
    .select({ runId: extractedValues.runId })
    .from(extractedValues)
    .where(eq(extractedValues.versionId, ctx.versionId))
    .limit(1);
  if (existing) {
    // A stray extra run for an already-extracted version: point the version back at the run
    // that produced its values, so the document keeps showing that run's outcome.
    // Only while this run is still the active one, so a newer active run is never hidden.
    await tx
      .update(documentVersions)
      .set({ activeRunId: existing.runId })
      .where(and(eq(documentVersions.id, ctx.versionId), eq(documentVersions.activeRunId, args.runId)));
    return false;
  }

  const decisionByField = new Map(args.decisions.map((d) => [d.fieldName, d]));
  const newIds = new Map<string, string>();
  if (args.values.length > 0) {
    const inserted = await tx
      .insert(extractedValues)
      .values(
        args.values.map((v) => {
          const d = decisionByField.get(v.fieldName);
          return {
            versionId: ctx.versionId,
            runId: args.runId,
            fieldName: v.fieldName,
            fieldType: v.fieldType,
            value: v.value,
            evidence: v.evidence,
            evidenceStart: v.evidenceStart,
            evidenceEnd: v.evidenceEnd,
            gapReason: v.gapReason,
            changeStatus: d?.changeStatus ?? "new",
            previousValueId: d?.previousValueId ?? null,
          };
        }),
      )
      .onConflictDoNothing({ target: [extractedValues.versionId, extractedValues.fieldName] })
      .returning({ id: extractedValues.id, fieldName: extractedValues.fieldName });
    for (const r of inserted) newIds.set(r.fieldName, r.id);
  }

  // Carried reviews point at the NEW value ids and copy the baseline value's latest review.
  for (const d of args.decisions) {
    const valueId = newIds.get(d.fieldName);
    if (!d.carryReviewId || !valueId) continue;
    await tx.execute(sql`
      INSERT INTO reviews (value_id, action, corrected_value, note, origin, carried_from_review_id)
      SELECT ${valueId}::uuid, action, corrected_value, note, 'carried_over', id
      FROM reviews WHERE id = ${d.carryReviewId}::uuid
    `);
  }

  const done = await tx
    .update(extractionRuns)
    .set({
      status: "extracted",
      finishedAt: sql`now()`,
      leaseExpiresAt: null,
      error: null,
      errorKind: null,
      prompt: args.prompt,
      rawResponse: args.raw,
    })
    .where(and(eq(extractionRuns.id, args.runId), eq(extractionRuns.status, "extracting")))
    .returning({ id: extractionRuns.id });
  // Belt and braces: never overwrite a run someone else already moved on (e.g. failed by the reconciler).
  if (done.length === 0) throw new GuardLost();
  return true;
}
