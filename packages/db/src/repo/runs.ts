import { and, eq, isNull, sql } from "drizzle-orm";
import type { DocumentType } from "@lomi/shared";
import { inTx, type Queryable, type Tx } from "../client.js";
import { documents, documentVersions, extractionRuns } from "../schema.js";

/** Error text of a run that failed because the owner had no LLM configured (worker `llmFor`). */
export const NO_LLM_ERROR = "No LLM configured";

/**
 * Queue a new attempt for the current version, only when its active run failed
 * (and, with `onlyError`, only when it failed with exactly that error).
 * Locks the document row so concurrent retries/uploads serialize.
 */
export async function createRetryRun(
  db: Queryable,
  args: { documentId: string; userId: string; onlyError?: string },
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
      ? await tx.select({ status: extractionRuns.status, error: extractionRuns.error }).from(extractionRuns).where(eq(extractionRuns.id, ver.activeRunId))
      : [];
    if (active?.status !== "failed") return { error: "NOT_FAILED" as const };
    if (args.onlyError !== undefined && active.error !== args.onlyError) return { error: "NOT_FAILED" as const };

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

export const DEFAULT_LEASE_MS = 60_000;
export const MAX_ATTEMPTS = 3;

export type ClaimedRun = {
  id: string;
  versionId: string;
  attempt: number;
  documentId: string;
  documentType: DocumentType;
  userId: string;
  storageKey: string;
  parsedText: string | null;
};

/**
 * Atomically move a queued run to extracting with a fresh lease.
 * null = not queued any more (duplicate delivery, already done, or gone): ack and drop.
 */
export async function claimRun(db: Queryable, runId: string, leaseMs = DEFAULT_LEASE_MS): Promise<ClaimedRun | null> {
  const [claimed] = await db
    .update(extractionRuns)
    .set({
      status: "extracting",
      startedAt: sql`now()`,
      leaseExpiresAt: sql`now() + make_interval(secs => ${leaseMs / 1000}::double precision)`,
    })
    .where(and(eq(extractionRuns.id, runId), eq(extractionRuns.status, "queued")))
    .returning({ id: extractionRuns.id, versionId: extractionRuns.versionId, attempt: extractionRuns.attempt });
  if (!claimed) return null;
  const [ctx] = await db
    .select({
      documentId: documents.id,
      documentType: documents.type,
      userId: documents.userId,
      storageKey: documentVersions.storageKey,
      parsedText: documentVersions.parsedText,
    })
    .from(documentVersions)
    .innerJoin(documents, eq(documents.id, documentVersions.documentId))
    .where(eq(documentVersions.id, claimed.versionId));
  if (!ctx) throw new Error(`version ${claimed.versionId} of run ${runId} not found`);
  return { ...claimed, ...ctx };
}

/** Extend the lease of a run this worker still holds. */
export async function heartbeat(db: Queryable, runId: string, leaseMs = DEFAULT_LEASE_MS): Promise<void> {
  await db
    .update(extractionRuns)
    .set({ leaseExpiresAt: sql`now() + make_interval(secs => ${leaseMs / 1000}::double precision)` })
    .where(and(eq(extractionRuns.id, runId), eq(extractionRuns.status, "extracting")));
}

/** True when the run's version is still its document's current version. */
export async function isCurrentVersion(db: Queryable, versionId: string): Promise<boolean> {
  const [row] = await db
    .select({ current: documents.currentVersionId })
    .from(documentVersions)
    .innerJoin(documents, eq(documents.id, documentVersions.documentId))
    .where(eq(documentVersions.id, versionId));
  return row?.current === versionId;
}

/** Store the version's parsed text once; returns whichever text won (first writer). */
export async function saveParsedText(db: Queryable, versionId: string, text: string): Promise<string> {
  await db
    .update(documentVersions)
    .set({ parsedText: text })
    .where(and(eq(documentVersions.id, versionId), isNull(documentVersions.parsedText)));
  const [row] = await db
    .select({ parsedText: documentVersions.parsedText })
    .from(documentVersions)
    .where(eq(documentVersions.id, versionId));
  return row?.parsedText ?? text;
}

/**
 * Lock the document that owns a run, in a statement of its own. Every run/version state read that
 * a decision depends on must come from a LATER statement: at READ COMMITTED a statement's snapshot
 * predates its own lock wait, so reading run rows in the locking statement can see stale state.
 * Returns false when the run does not exist.
 */
export async function lockDocumentOfRun(tx: Tx, runId: string): Promise<boolean> {
  const rows = await tx.execute(sql`
    SELECT d.id FROM documents d
    WHERE d.id = (
      SELECT v.document_id FROM extraction_runs r
      JOIN document_versions v ON v.id = r.version_id
      WHERE r.id = ${runId}::uuid
    )
    FOR UPDATE
  `);
  return rows.length > 0;
}

/** extracting -> superseded. False when the run was no longer extracting. */
export async function markSuperseded(db: Queryable, runId: string): Promise<boolean> {
  const rows = await db
    .update(extractionRuns)
    .set({ status: "superseded", finishedAt: sql`now()`, leaseExpiresAt: null })
    .where(and(eq(extractionRuns.id, runId), eq(extractionRuns.status, "extracting")))
    .returning({ id: extractionRuns.id });
  return rows.length > 0;
}

/**
 * extracting -> failed, in one transaction with the retry decision. A transient failure queues
 * attempt+1 (and makes it the version's active run) only while attempt < MAX_ATTEMPTS, the run is
 * still the version's active run, and the version is still the document's current version.
 * Returns the queued retry's id (caller enqueues it after commit), or null.
 */
export async function markFailed(
  db: Queryable,
  runId: string,
  failure: { kind: "transient" | "permanent"; message: string; prompt?: unknown; raw?: unknown },
): Promise<string | null> {
  return inTx(db, async (tx) => {
    if (!(await lockDocumentOfRun(tx, runId))) return null;
    // Fresh statement after the lock: sees whatever a concurrent finalize/markFailed committed.
    const [ctx] = await tx
      .select({
        documentId: documents.id,
        currentVersionId: documents.currentVersionId,
        versionId: documentVersions.id,
        activeRunId: documentVersions.activeRunId,
      })
      .from(extractionRuns)
      .innerJoin(documentVersions, eq(documentVersions.id, extractionRuns.versionId))
      .innerJoin(documents, eq(documents.id, documentVersions.documentId))
      .where(eq(extractionRuns.id, runId));
    if (!ctx) return null;

    const [failed] = await tx
      .update(extractionRuns)
      .set({
        status: "failed",
        errorKind: failure.kind,
        error: failure.message,
        finishedAt: sql`now()`,
        leaseExpiresAt: null,
        ...(failure.prompt !== undefined ? { prompt: failure.prompt } : {}),
        ...(failure.raw !== undefined ? { rawResponse: failure.raw } : {}),
      })
      .where(and(eq(extractionRuns.id, runId), eq(extractionRuns.status, "extracting")))
      .returning({ attempt: extractionRuns.attempt });
    if (!failed) return null;

    const retry =
      failure.kind === "transient" &&
      failed.attempt < MAX_ATTEMPTS &&
      ctx.activeRunId === runId &&
      ctx.currentVersionId === ctx.versionId;
    if (!retry) return null;

    const [next] = await tx
      .insert(extractionRuns)
      .values({ versionId: ctx.versionId, attempt: failed.attempt + 1, status: "queued" })
      .returning({ id: extractionRuns.id });
    await tx.update(documentVersions).set({ activeRunId: next!.id }).where(eq(documentVersions.id, ctx.versionId));
    return next!.id;
  });
}
