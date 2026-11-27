import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, inArray } from "drizzle-orm";
import {
  addVersion,
  MAX_VERSIONS_PER_DOCUMENT,
  createDocumentWithVersion,
  createRetryRun,
  documents,
  documentVersions,
  extractedValues,
  extractionRuns,
  getDocumentDetail,
  getProgress,
  getVersionFile,
  insertReview,
  listDocuments,
  storePdf,
  type Db,
  type StoredFile,
} from "@lomi/db";
import {
  normalizeValue,
  type DocumentDetail,
  type DocumentSummary,
  type DocumentType,
  type Progress,
  type ReviewRequest,
  type ValueView,
} from "@lomi/shared";
import type { FileStorage } from "@lomi/storage";
import { ApiError } from "../errors.js";
import { RunEnqueuer } from "../queue.js";
import { DATABASE, STORAGE } from "../tokens.js";

export const MAX_DOCUMENTS = 25;
export const MAX_IN_FLIGHT = 5;

export type UploadedFile = { originalname: string; buffer: Buffer };

const notFound = () => new ApiError(404, "NOT_FOUND", "Not found");

const versionLimit = () =>
  new ApiError(409, "VERSION_LIMIT", `A document can have at most ${MAX_VERSIONS_PER_DOCUMENT} versions`);

@Injectable()
export class DocumentsService {
  private readonly db: Db;

  constructor(
    @Inject(DATABASE) database: { db: Db },
    @Inject(STORAGE) private readonly storage: FileStorage,
    @Inject(RunEnqueuer) private readonly enqueuer: RunEnqueuer,
  ) {
    this.db = database.db;
  }

  list(userId: string): Promise<DocumentSummary[]> {
    return listDocuments(this.db, userId);
  }

  async detail(userId: string, documentId: string, version: number | undefined): Promise<DocumentDetail> {
    const d = await getDocumentDetail(this.db, { documentId, userId, versionNumber: version });
    if (!d) throw notFound();
    return d;
  }

  async progress(userId: string, documentId: string): Promise<Progress> {
    const p = await getProgress(this.db, { documentId, userId });
    if (!p) throw notFound();
    return p;
  }

  async create(
    userId: string,
    type: DocumentType,
    title: string | undefined,
    file: UploadedFile,
  ): Promise<{ id: string; status: "queued"; version: 1 }> {
    const [docs] = await this.db.select({ n: count() }).from(documents).where(eq(documents.userId, userId));
    if ((docs?.n ?? 0) >= MAX_DOCUMENTS) {
      throw new ApiError(409, "DOCUMENT_LIMIT", `You can have at most ${MAX_DOCUMENTS} documents`);
    }
    await this.assertCapacity(userId);
    const stored = await this.store(file);
    const created = await createDocumentWithVersion(this.db, {
      userId,
      type,
      title: title ?? file.originalname.replace(/\.pdf$/i, ""),
      file: stored,
    });
    await this.enqueuer.enqueue([created.runId]);
    return { id: created.documentId, status: "queued", version: 1 };
  }

  async uploadVersion(
    userId: string,
    documentId: string,
    file: UploadedFile,
  ): Promise<{ id: string; version: number; status: "queued" }> {
    const [owned] = await this.db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.userId, userId)));
    if (!owned) throw notFound();
    const [{ n: versionCount } = { n: 0 }] = await this.db
      .select({ n: count() })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId));
    if (versionCount >= MAX_VERSIONS_PER_DOCUMENT) throw versionLimit();
    await this.assertCapacity(userId);
    const stored = await this.store(file);
    try {
      const v = await addVersion(this.db, { documentId, userId, file: stored });
      await this.enqueuer.enqueue([v.runId]);
      return { id: documentId, version: v.versionNumber, status: "queued" };
    } catch (err) {
      if (err instanceof Error && err.message === "document not found") throw notFound();
      if (err instanceof Error && err.message === "version limit") throw versionLimit();
      throw err;
    }
  }

  async retry(userId: string, documentId: string): Promise<{ id: string; status: "queued" }> {
    const r = await createRetryRun(this.db, { documentId, userId });
    if ("error" in r) {
      if (r.error === "NOT_FOUND") throw notFound();
      throw new ApiError(409, "NOT_FAILED", "Only a failed extraction can be retried");
    }
    await this.enqueuer.enqueue([r.runId]);
    return { id: documentId, status: "queued" };
  }

  async review(userId: string, valueId: string, body: ReviewRequest): Promise<ValueView> {
    const [row] = await this.db
      .select({ documentId: documents.id, fieldType: extractedValues.fieldType })
      .from(extractedValues)
      .innerJoin(documentVersions, eq(documentVersions.id, extractedValues.versionId))
      .innerJoin(documents, eq(documents.id, documentVersions.documentId))
      .where(and(eq(extractedValues.id, valueId), eq(documents.userId, userId)));
    if (!row) throw notFound();

    let result;
    if (body.action === "approve") {
      result = await insertReview(this.db, { valueId, userId, action: "approved", correctedValue: null, note: null });
    } else {
      if (body.value === undefined || body.value === null) {
        throw new ApiError(400, "INVALID_VALUE", `invalid ${row.fieldType}: a value is required`);
      }
      const n = normalizeValue(row.fieldType, body.value);
      if (!n.ok) throw new ApiError(400, "INVALID_VALUE", n.reason);
      result = await insertReview(this.db, {
        valueId,
        userId,
        action: "corrected",
        correctedValue: n.value,
        note: body.note ?? null,
      });
    }
    if ("error" in result) {
      if (result.error === "NOT_FOUND") throw notFound();
      throw new ApiError(409, "VALUE_NOT_CURRENT", "This value belongs to a superseded version");
    }
    const detail = await getDocumentDetail(this.db, { documentId: row.documentId, userId });
    const view = detail?.values.find((v) => v.id === valueId);
    if (!view) throw notFound();
    return view;
  }

  async file(userId: string, documentId: string, version: number): Promise<StoredFile> {
    const f = await getVersionFile(this.db, { documentId, userId, versionNumber: version });
    if (!f) throw notFound();
    return f;
  }

  private async assertCapacity(userId: string): Promise<void> {
    const [r] = await this.db
      .select({ n: count() })
      .from(extractionRuns)
      .innerJoin(documentVersions, eq(documentVersions.id, extractionRuns.versionId))
      .innerJoin(documents, eq(documents.id, documentVersions.documentId))
      .where(and(eq(documents.userId, userId), inArray(extractionRuns.status, ["queued", "extracting"])));
    if ((r?.n ?? 0) >= MAX_IN_FLIGHT) {
      throw new ApiError(
        429,
        "TOO_MANY_IN_FLIGHT",
        `At most ${MAX_IN_FLIGHT} extractions can run at once; try again shortly`,
      );
    }
  }

  private async store(file: UploadedFile): Promise<StoredFile> {
    try {
      return await storePdf(this.storage, file.originalname, file.buffer);
    } catch {
      throw new ApiError(500, "STORAGE_UNAVAILABLE", "File storage is unavailable");
    }
  }
}
