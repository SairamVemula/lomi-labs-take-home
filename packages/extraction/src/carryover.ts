import { canonicalJson } from "@lomi/shared";
import type { FieldValue } from "@lomi/shared";
import type { AssembledValue } from "./assemble.js";
import { findEvidence, normalizeEvidenceForCompare } from "./evidence.js";

export type BaselineValue = {
  id: string;
  value: FieldValue | null;
  evidence: string | null;
  gapReason: string | null;
  latestReview: {
    id: string;
    action: "approved" | "corrected";
    correctedValue: FieldValue | null;
    note: string | null;
  } | null;
};

export type CarryDecision = {
  fieldName: string;
  changeStatus: "new" | "unchanged" | "changed";
  previousValueId: string | null;
  carryReviewId: string | null;
};

const evKey = (e: string | null): string | null => (e === null ? null : normalizeEvidenceForCompare(e));

/** Parsed text of the new version and of the baseline version, for the cross-text evidence check. */
export type DiffTexts = { nextText: string; baselineText: string };

/**
 * Equal canonical values are "unchanged" when the quotes match, or (cross-text check, so a merely
 * reworded quote does not drop a review) when the baseline's quote still appears verbatim in the NEW
 * text, or the new quote appears verbatim in the BASELINE text. Differing values are always changed.
 */
function isUnchanged(next: AssembledValue, base: BaselineValue, texts?: DiffTexts): boolean {
  if (canonicalJson(next.value) !== canonicalJson(base.value)) return false;
  if (next.value === null && base.value === null) {
    return evKey(next.evidence) === evKey(base.evidence) && next.gapReason === base.gapReason;
  }
  if (evKey(next.evidence) === evKey(base.evidence)) return true;
  if (!texts) return false;
  if (base.evidence !== null && findEvidence(texts.nextText, base.evidence) !== null) return true;
  if (next.evidence !== null && findEvidence(texts.baselineText, next.evidence) !== null) return true;
  return false;
}

export function diffAgainstBaseline(
  next: AssembledValue[],
  baseline: Map<string, BaselineValue> | null,
  texts?: DiffTexts,
): CarryDecision[] {
  return next.map((n) => {
    const base = baseline?.get(n.fieldName);
    if (!base) return { fieldName: n.fieldName, changeStatus: "new", previousValueId: null, carryReviewId: null };
    if (isUnchanged(n, base, texts)) {
      return {
        fieldName: n.fieldName,
        changeStatus: "unchanged",
        previousValueId: base.id,
        carryReviewId: base.latestReview?.id ?? null,
      };
    }
    return { fieldName: n.fieldName, changeStatus: "changed", previousValueId: base.id, carryReviewId: null };
  });
}
