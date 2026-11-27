import { and, asc, eq, inArray } from "drizzle-orm";
import { EXPECTED_FIELDS } from "@lomi/shared";
import type { DocumentDetail, DocumentStatus, DocumentSummary, DocumentType, ValueView } from "@lomi/shared";
import { pdfStorageKey, sha256Hex, type FileStorage } from "@lomi/storage";
import { inTx, type Queryable } from "../client.js";
import { documents, documentVersions, extractedValues, extractionRuns } from "../schema.js";
import { EMPTY_PROGRESS, latestReviews, progressByVersion, type ReviewRow } from "./values.js";

export type StoredFile = { storageKey: string; originalFilename: string; sha256: string; sizeBytes: number };

/** Hash + key the bytes and write them to storage (storage before DB, per spec). */
export async function storePdf(
  storage: FileStorage,
  originalFilename: string,
  bytes: Uint8Array,
): Promise<StoredFile> {
  const sha256 = sha256Hex(bytes);
  const storageKey = pdfStorageKey(originalFilename, sha256);
  await storage.put(storageKey, bytes, "application/pdf");
  return { storageKey, originalFilename, sha256, sizeBytes: bytes.byteLength };
}

export async function createDocumentWithVersion(
  db: Queryable,
  args: { userId: string; type: DocumentType; title: string; externalId?: string; file: StoredFile },
): Promise<{ documentId: string; versionId: string; runId: string }> {
  return inTx(db, async (tx) => {
    const [doc] = await tx
      .insert(documents)
      .values({ userId: args.userId, type: args.type, title: args.title, externalId: args.externalId ?? null })
      .returning({ id: documents.id });
    const [ver] = await tx
      .insert(documentVersions)
      .values({ documentId: doc!.id, versionNumber: 1, ...args.file })
      .returning({ id: documentVersions.id });
    const [run] = await tx
      .insert(extractionRuns)
      .values({ versionId: ver!.id, attempt: 1, status: "queued" })
      .returning({ id: extractionRuns.id });
    await tx.update(documentVersions).set({ activeRunId: run!.id }).where(eq(documentVersions.id, ver!.id));
    await tx.update(documents).set({ currentVersionId: ver!.id }).where(eq(documents.id, doc!.id));
    return { documentId: doc!.id, versionId: ver!.id, runId: run!.id };
  });
}

export async function addVersion(
  db: Queryable,
  args: { documentId: string; userId: string; file: StoredFile },
): Promise<{ versionId: string; versionNumber: number; runId: string }> {
  return inTx(db, async (tx) => {
    const locked = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.id, args.documentId), eq(documents.userId, args.userId)))
      .for("update");
    if (locked.length === 0) throw new Error("document not found");

    const existing = await tx
      .select({ n: documentVersions.versionNumber })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, args.documentId));
    const versionNumber = existing.reduce((m, r) => Math.max(m, r.n), 0) + 1;

    const [ver] = await tx
      .insert(documentVersions)
      .values({ documentId: args.documentId, versionNumber, ...args.file })
      .returning({ id: documentVersions.id });
    const [run] = await tx
      .insert(extractionRuns)
      .values({ versionId: ver!.id, attempt: 1, status: "queued" })
      .returning({ id: extractionRuns.id });
    await tx.update(documentVersions).set({ activeRunId: run!.id }).where(eq(documentVersions.id, ver!.id));
    await tx.update(documents).set({ currentVersionId: ver!.id }).where(eq(documents.id, args.documentId));
    return { versionId: ver!.id, versionNumber, runId: run!.id };
  });
}

type RunSummary = {
  status: DocumentStatus;
  error: string | null;
  errorKind: "transient" | "permanent" | null;
  attempt: number;
};

/** Active run of each version (the worker keeps active_run_id pointing at the newest attempt). */
async function activeRuns(db: Queryable, versionIds: string[]): Promise<Map<string, RunSummary>> {
  const out = new Map<string, RunSummary>();
  if (versionIds.length === 0) return out;
  const rows = await db
    .select({
      versionId: documentVersions.id,
      status: extractionRuns.status,
      error: extractionRuns.error,
      errorKind: extractionRuns.errorKind,
      attempt: extractionRuns.attempt,
    })
    .from(documentVersions)
    .innerJoin(extractionRuns, eq(extractionRuns.id, documentVersions.activeRunId))
    .where(inArray(documentVersions.id, versionIds));
  for (const r of rows) out.set(r.versionId, { status: r.status, error: r.error, errorKind: r.errorKind, attempt: r.attempt });
  return out;
}

export async function getDocumentDetail(
  db: Queryable,
  args: { documentId: string; userId: string; versionNumber?: number },
): Promise<DocumentDetail | null> {
  const [doc] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, args.documentId), eq(documents.userId, args.userId)));
  if (!doc?.currentVersionId) return null;

  const versions = await db
    .select()
    .from(documentVersions)
    .where(eq(documentVersions.documentId, doc.id))
    .orderBy(asc(documentVersions.versionNumber));
  const current = versions.find((v) => v.id === doc.currentVersionId);
  if (!current) return null;
  const viewing = args.versionNumber === undefined ? current : versions.find((v) => v.versionNumber === args.versionNumber);
  if (!viewing) return null;

  const runs = await activeRuns(db, [current.id, viewing.id]);
  const currentStatus: DocumentStatus = runs.get(current.id)?.status ?? "queued";
  const viewingRun = runs.get(viewing.id) ?? null;

  const valueRows = await db.select().from(extractedValues).where(eq(extractedValues.versionId, viewing.id));
  const previousIds = valueRows.map((v) => v.previousValueId).filter((x): x is string => x !== null);
  const previousRows = previousIds.length
    ? await db.select().from(extractedValues).where(inArray(extractedValues.id, previousIds))
    : [];
  const reviewMap = await latestReviews(db, [...valueRows.map((v) => v.id), ...previousRows.map((v) => v.id)]);
  const previousById = new Map(previousRows.map((v) => [v.id, v]));
  const versionNumberById = new Map(versions.map((v) => [v.id, v.versionNumber]));

  const reviewView = (r: ReviewRow | undefined) =>
    r
      ? {
          action: r.action === "approved" ? ("approve" as const) : ("correct" as const),
          correctedValue: r.correctedValue ?? null,
          note: r.note,
          origin: r.origin,
          createdAt: r.createdAt.toISOString(),
        }
      : null;
  const effective = (value: unknown, r: ReviewRow | undefined) =>
    r?.action === "corrected" ? (r.correctedValue ?? null) : (value ?? null);

  const order = new Map(EXPECTED_FIELDS[doc.type].map((f, i) => [f.field, i]));
  const values: ValueView[] = valueRows
    .map((v) => {
      const review = reviewMap.get(v.id);
      const prev = v.previousValueId ? previousById.get(v.previousValueId) : undefined;
      return {
        id: v.id,
        fieldName: v.fieldName,
        fieldType: v.fieldType,
        value: v.value ?? null,
        evidence: v.evidence,
        evidenceStart: v.evidenceStart,
        evidenceEnd: v.evidenceEnd,
        gapReason: v.gapReason,
        changeStatus: v.changeStatus,
        effectiveValue: effective(v.value, review),
        latestReview: reviewView(review),
        previous: prev
          ? {
              versionNumber: versionNumberById.get(prev.versionId) ?? 0,
              value: prev.value ?? null,
              latestReview: reviewView(reviewMap.get(prev.id)),
            }
          : null,
      };
    })
    .sort((a, b) => (order.get(a.fieldName) ?? 1e9) - (order.get(b.fieldName) ?? 1e9) || a.fieldName.localeCompare(b.fieldName));

  return {
    id: doc.id,
    title: doc.title,
    type: doc.type,
    status: currentStatus,
    currentVersion: current.versionNumber,
    viewingVersion: viewing.versionNumber,
    versions: versions.map((v) => ({
      number: v.versionNumber,
      originalFilename: v.originalFilename,
      fileUrl: `/api/documents/${doc.id}/versions/${v.versionNumber}/file`,
      status: v.id === current.id ? currentStatus : "superseded",
      createdAt: v.createdAt.toISOString(),
    })),
    parsedText: viewing.parsedText,
    values,
    latestRun: viewingRun
      ? { status: viewingRun.status, error: viewingRun.error, attempt: viewingRun.attempt }
      : null,
  };
}

export async function listDocuments(db: Queryable, userId: string): Promise<DocumentSummary[]> {
  const rows = await db
    .select({
      id: documents.id,
      title: documents.title,
      type: documents.type,
      versionId: documentVersions.id,
      versionNumber: documentVersions.versionNumber,
    })
    .from(documents)
    .innerJoin(documentVersions, eq(documentVersions.id, documents.currentVersionId))
    .where(eq(documents.userId, userId))
    .orderBy(asc(documents.createdAt), asc(documents.id));
  const versionIds = rows.map((r) => r.versionId);
  const [runs, progress] = await Promise.all([activeRuns(db, versionIds), progressByVersion(db, versionIds)]);
  return rows.map((r) => {
    const run = runs.get(r.versionId);
    return {
      id: r.id,
      title: r.title,
      type: r.type,
      status: run?.status ?? "queued",
      currentVersion: r.versionNumber,
      progress: progress.get(r.versionId) ?? { ...EMPTY_PROGRESS },
      latestError:
        run?.status === "failed" ? { kind: run.errorKind, message: run.error ?? "Extraction failed" } : null,
    };
  });
}

export async function getVersionFile(
  db: Queryable,
  args: { documentId: string; userId: string; versionNumber: number },
): Promise<StoredFile | null> {
  const [row] = await db
    .select({
      storageKey: documentVersions.storageKey,
      originalFilename: documentVersions.originalFilename,
      sha256: documentVersions.sha256,
      sizeBytes: documentVersions.sizeBytes,
    })
    .from(documentVersions)
    .innerJoin(documents, eq(documents.id, documentVersions.documentId))
    .where(
      and(
        eq(documents.id, args.documentId),
        eq(documents.userId, args.userId),
        eq(documentVersions.versionNumber, args.versionNumber),
      ),
    );
  return row ?? null;
}

export async function listReferencedStorageKeys(db: Queryable): Promise<Set<string>> {
  const rows = await db.select({ k: documentVersions.storageKey }).from(documentVersions);
  return new Set(rows.map((r) => r.k));
}
