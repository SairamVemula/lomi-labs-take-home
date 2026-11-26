import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  customType,
  foreignKey,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  boolean,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const docTypeEnum = pgEnum("doc_type", ["invoice", "lease", "market_report"]);
export const runStatusEnum = pgEnum("run_status", [
  "queued",
  "extracting",
  "extracted",
  "failed",
  "superseded",
]);
export const changeStatusEnum = pgEnum("change_status", ["new", "unchanged", "changed"]);
export const reviewActionEnum = pgEnum("review_action", ["approved", "corrected"]);
export const reviewOriginEnum = pgEnum("review_origin", ["manual", "carried_over"]);

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const users = pgTable("users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  identityHash: text("identity_hash").notNull().unique(),
  baseUrl: text("base_url"),
  model: text("model"),
  encryptedKey: bytea("encrypted_key"),
  isLocal: boolean("is_local").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
  lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: ts("expires_at").notNull(),
});

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    externalId: text("external_id"),
    type: docTypeEnum("type").notNull(),
    title: text("title").notNull(),
    currentVersionId: uuid("current_version_id").references((): AnyPgColumn => documentVersions.id, {
      onDelete: "set null",
    }),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [unique("documents_user_external_uq").on(t.userId, t.externalId)],
);

export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    storageKey: text("storage_key").notNull(),
    originalFilename: text("original_filename").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    parsedText: text("parsed_text"),
    activeRunId: uuid("active_run_id").references((): AnyPgColumn => extractionRuns.id, {
      onDelete: "set null",
    }),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [unique("document_versions_doc_number_uq").on(t.documentId, t.versionNumber)],
);

export const extractionRuns = pgTable(
  "extraction_runs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    versionId: uuid("version_id")
      .notNull()
      .references((): AnyPgColumn => documentVersions.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    status: runStatusEnum("status").notNull().default("queued"),
    leaseExpiresAt: ts("lease_expires_at"),
    error: text("error"),
    errorKind: text("error_kind", { enum: ["transient", "permanent"] }),
    model: text("model"),
    prompt: jsonb("prompt"),
    rawResponse: jsonb("raw_response"),
    createdAt: ts("created_at").notNull().defaultNow(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [unique("extraction_runs_version_attempt_uq").on(t.versionId, t.attempt)],
);

export const extractedValues = pgTable(
  "extracted_values",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    versionId: uuid("version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => extractionRuns.id, { onDelete: "cascade" }),
    fieldName: text("field_name").notNull(),
    fieldType: text("field_type", { enum: ["string", "date", "money", "percent", "number"] }).notNull(),
    value: jsonb("value"),
    evidence: text("evidence"),
    evidenceStart: integer("evidence_start"),
    evidenceEnd: integer("evidence_end"),
    gapReason: text("gap_reason"),
    changeStatus: changeStatusEnum("change_status").notNull(),
    previousValueId: uuid("previous_value_id"),
  },
  (t) => [
    unique("extracted_values_version_field_uq").on(t.versionId, t.fieldName),
    foreignKey({
      columns: [t.previousValueId],
      foreignColumns: [t.id],
      name: "extracted_values_previous_value_fk",
    }).onDelete("set null"),
  ],
);

export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    valueId: uuid("value_id")
      .notNull()
      .references(() => extractedValues.id, { onDelete: "cascade" }),
    action: reviewActionEnum("action").notNull(),
    correctedValue: jsonb("corrected_value"),
    note: text("note"),
    origin: reviewOriginEnum("origin").notNull(),
    carriedFromReviewId: uuid("carried_from_review_id"),
    // clock_timestamp() (not now()) so reviews inserted in one transaction still order strictly.
    createdAt: ts("created_at").notNull().default(sql`clock_timestamp()`),
  },
  (t) => [
    foreignKey({
      columns: [t.carriedFromReviewId],
      foreignColumns: [t.id],
      name: "reviews_carried_from_fk",
    }).onDelete("set null"),
  ],
);

export type User = typeof users.$inferSelect;
