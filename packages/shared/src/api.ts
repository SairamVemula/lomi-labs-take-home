import { z } from "zod";

export const DocumentTypeSchema = z.enum(["invoice", "lease", "market_report"]);
export const DocumentStatus = z.enum(["queued", "extracting", "extracted", "failed", "superseded"]);
export type DocumentStatus = z.infer<typeof DocumentStatus>;
export const ChangeStatus = z.enum(["new", "unchanged", "changed"]);
export type ChangeStatus = z.infer<typeof ChangeStatus>;

export const ReviewRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("correct"), value: z.unknown(), note: z.string().optional() }),
]);
export type ReviewRequest = z.infer<typeof ReviewRequest>;

export const LoginRequest = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  model: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const Progress = z.object({
  pending: z.number().int(),
  approved: z.number().int(),
  corrected: z.number().int(),
  carried_over: z.number().int(),
  total: z.number().int(),
});
export type Progress = z.infer<typeof Progress>;

export const ReviewView = z.object({
  action: z.enum(["approve", "correct"]),
  correctedValue: z.unknown().nullable(),
  note: z.string().nullable(),
  origin: z.string(),
  createdAt: z.string(),
});
export type ReviewView = z.infer<typeof ReviewView>;

export const ValueView = z.object({
  id: z.string(),
  fieldName: z.string(),
  fieldType: z.enum(["string", "date", "money", "percent", "number"]),
  value: z.unknown().nullable(),
  evidence: z.string().nullable(),
  evidenceStart: z.number().int().nullable(),
  evidenceEnd: z.number().int().nullable(),
  gapReason: z.string().nullable(),
  changeStatus: ChangeStatus,
  effectiveValue: z.unknown().nullable(),
  latestReview: ReviewView.nullable(),
  previous: z.object({ value: z.unknown().nullable(), latestReview: ReviewView.nullable() }).nullable(),
});
export type ValueView = z.infer<typeof ValueView>;

export const DocumentSummary = z.object({
  id: z.string(),
  title: z.string(),
  type: DocumentTypeSchema,
  status: DocumentStatus,
  currentVersion: z.number().int(),
  progress: Progress,
});
export type DocumentSummary = z.infer<typeof DocumentSummary>;

export const DocumentDetail = z.object({
  id: z.string(),
  title: z.string(),
  type: DocumentTypeSchema,
  status: DocumentStatus,
  currentVersion: z.number().int(),
  viewingVersion: z.number().int(),
  versions: z.array(
    z.object({
      number: z.number().int(),
      originalFilename: z.string(),
      fileUrl: z.string(),
      status: DocumentStatus,
      createdAt: z.string(),
    }),
  ),
  parsedText: z.string().nullable(),
  values: z.array(ValueView),
  latestRun: z
    .object({ status: z.string(), error: z.string().nullable(), attempt: z.number().int() })
    .nullable(),
});
export type DocumentDetail = z.infer<typeof DocumentDetail>;
