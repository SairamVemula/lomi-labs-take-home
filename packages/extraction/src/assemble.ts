import { EXPECTED_FIELDS, normalizeValue } from "@lomi/shared";
import type { DocumentType, FieldType, FieldValue } from "@lomi/shared";
import { findEvidence } from "./evidence.js";

export type LlmField = { value: unknown; evidence: string | null; gap_reason: string | null };

export type AssembledValue = {
  fieldName: string;
  fieldType: FieldType;
  value: FieldValue | null;
  evidence: string | null;
  evidenceStart: number | null;
  evidenceEnd: number | null;
  gapReason: string | null;
};

function gap(
  fieldName: string,
  fieldType: FieldType,
  gapReason: string,
  evidence: string | null,
): AssembledValue {
  return { fieldName, fieldType, value: null, evidence, evidenceStart: null, evidenceEnd: null, gapReason };
}

/** One entry per expected field (fixture order); anything unverifiable becomes a gap. */
export function assembleValues(
  docType: DocumentType,
  parsedText: string,
  output: Record<string, LlmField | undefined>,
): AssembledValue[] {
  return EXPECTED_FIELDS[docType].map(({ field, type }) => {
    const f = Object.hasOwn(output, field) ? output[field] : undefined;
    if (!f) return gap(field, type, "field missing from model output", null);
    if (f.value === null || f.value === undefined) {
      const reason = f.gap_reason && f.gap_reason.trim() !== "" ? f.gap_reason : "not found in document";
      return gap(field, type, reason, null);
    }
    const evidence = f.evidence;
    if (evidence === null || evidence === undefined || evidence.trim() === "") {
      return gap(field, type, "no evidence quoted", null);
    }
    const found = findEvidence(parsedText, evidence);
    if (!found) return gap(field, type, "evidence not found verbatim in document text", evidence);
    const n = normalizeValue(type, f.value);
    if (!n.ok) return gap(field, type, `value not parseable as ${type}`, evidence);
    return {
      fieldName: field,
      fieldType: type,
      value: n.value,
      evidence,
      evidenceStart: found.start,
      evidenceEnd: found.end,
      gapReason: null,
    };
  });
}
