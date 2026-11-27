import type { ReviewView, ValueView } from "@lomi/shared";

export function review(over: Partial<ReviewView> = {}): ReviewView {
  return { action: "approve", correctedValue: null, note: null, origin: "manual", createdAt: "2026-11-26T10:00:00Z", ...over };
}

export function value(over: Partial<ValueView> = {}): ValueView {
  return {
    id: "v1",
    fieldName: "due_date",
    fieldType: "date",
    value: "2025-10-14",
    evidence: "Due Date: 2025-10-14",
    evidenceStart: 10,
    evidenceEnd: 30,
    gapReason: null,
    changeStatus: "new",
    effectiveValue: "2025-10-14",
    latestReview: null,
    previous: null,
    ...over,
  };
}
