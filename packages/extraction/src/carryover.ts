import { canonicalJson } from "@lomi/shared";
import type { FieldValue } from "@lomi/shared";
import type { AssembledValue } from "./assemble.js";
import { normalizeEvidenceForCompare } from "./evidence.js";

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

function isUnchanged(next: AssembledValue, base: BaselineValue): boolean {
  if (evKey(next.evidence) !== evKey(base.evidence)) return false;
  if (canonicalJson(next.value) !== canonicalJson(base.value)) return false;
  if (next.value === null && base.value === null) return next.gapReason === base.gapReason;
  return true;
}

export function diffAgainstBaseline(
  next: AssembledValue[],
  baseline: Map<string, BaselineValue> | null,
): CarryDecision[] {
  return next.map((n) => {
    const base = baseline?.get(n.fieldName);
    if (!base) return { fieldName: n.fieldName, changeStatus: "new", previousValueId: null, carryReviewId: null };
    if (isUnchanged(n, base)) {
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
