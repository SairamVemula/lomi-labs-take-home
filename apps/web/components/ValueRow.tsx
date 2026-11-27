"use client";

import type { ReactNode } from "react";
import type { ReviewRequest, ValueView } from "@lomi/shared";
import { displayText, displayValue, fieldLabel, reviewSummary } from "../lib/format";
import { isCarried, isChanged, isPending } from "../lib/review";
import { Badge, ChangeBadge } from "./ChangeBadge";
import { ReviewForm } from "./ReviewForm";

const MONO_QUOTE = "m-0 rounded-sm bg-surface px-3 py-2 font-mono text-evidence";

function Value({ value, className }: { value: ValueView; className: string }) {
  const review = value.latestReview;
  const d = displayValue(value.fieldType, value.effectiveValue);
  const corrected = review?.action === "correct" && value.value !== null;
  return (
    <div className={className}>
      {d.main}
      {d.unit && <span className="ml-1 text-label font-medium text-ink-muted">{d.unit}</span>}
      {corrected && (
        <span className="ml-2 text-body font-normal text-ink-muted line-through">
          {displayText(value.fieldType, value.value)}
        </span>
      )}
    </div>
  );
}

function StateBadge({ value, version }: { value: ValueView; version: number }) {
  const r = value.latestReview;
  const isGap = value.value === null && value.gapReason !== null;
  if (!r) {
    if (isChanged(value)) return <ChangeBadge status="changed" />;
    return (
      <span className="flex gap-2">
        {version > 1 && <ChangeBadge status={value.changeStatus} />}
        <Badge kind="pending">{isGap ? "Gap" : "Pending"}</Badge>
      </span>
    );
  }
  const verdict = r.action === "correct" ? "corrected" : "approved";
  const state =
    r.origin === "carried_over" ? (
      <Badge kind="carried">{`Carried over · ${verdict}`}</Badge>
    ) : (
      <Badge kind={verdict}>{verdict === "corrected" ? "Corrected" : "Approved"}</Badge>
    );
  return (
    <span className="flex gap-2">
      {(isChanged(value) || (version > 1 && value.changeStatus === "new")) && <ChangeBadge status={value.changeStatus} />}
      {state}
    </span>
  );
}

function Previously({ value }: { value: ValueView }) {
  const prev = value.previous!;
  const r = prev.latestReview;
  return (
    <div className="flex flex-1 basis-60 flex-col gap-1 rounded-md border border-dashed border-border bg-surface p-3">
      <span className="text-caption text-ink-muted">{`Previously${prev.versionNumber > 0 ? ` · version ${prev.versionNumber}` : ""}`}</span>
      <div className="text-body font-medium text-ink-muted">{displayText(value.fieldType, prev.value)}</div>
      {r ? (
        <span className={`text-caption font-medium ${r.action === "correct" ? "text-corrected" : "text-approved"}`}>
          {reviewSummary(value.fieldType, r)}
          {r.note && <span className="font-normal text-ink-muted">{` · “${r.note}”`}</span>}
        </span>
      ) : (
        <span className="text-caption text-ink-muted">Not reviewed</span>
      )}
    </div>
  );
}

export type ValueRowProps = {
  value: ValueView;
  /** The version being viewed (labels "Now"/"Previously"). */
  version: number;
  selected: boolean;
  /** Historical versions: no review controls. */
  readOnly: boolean;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
  onReview: (id: string, body: ReviewRequest) => Promise<unknown>;
};

export function ValueRow({ value, version, selected, readOnly, onSelect, onHover, onReview }: ValueRowProps) {
  const pending = isPending(value);
  const changed = isChanged(value);
  const carried = isCarried(value);
  const isGap = value.value === null && value.gapReason !== null;
  const r = value.latestReview;
  const frame = `flex flex-col gap-3 rounded-md bg-surface-raised ${selected ? "border-2 border-accent" : "border border-border"}`;
  const handlers = {
    onClick: () => onSelect(value.id),
    onMouseEnter: () => onHover(value.id),
    onMouseLeave: () => onHover(null),
    onFocus: () => onSelect(value.id),
    tabIndex: 0,
  };

  if (carried && !changed) {
    return (
      <article {...handlers} className={`${frame} gap-1 px-4 py-3 ${selected ? "" : "cursor-pointer"}`}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-label font-medium text-ink-muted">{fieldLabel(value.fieldName)}</span>
          <StateBadge value={value} version={version} />
        </div>
        <Value value={value} className="text-body font-semibold text-ink" />
        {r?.note ? (
          <span className="text-caption text-ink-muted">{`Note: “${r.note}”`}</span>
        ) : (
          value.evidence && <span className="font-mono text-evidence text-ink-muted">{value.evidence}</span>
        )}
      </article>
    );
  }

  let body: ReactNode;
  if (isGap) {
    body = (
      <>
        <div className="text-body font-medium text-pending">{`Gap: ${value.gapReason}`}</div>
        {value.effectiveValue !== null && <Value value={value} className="text-title font-semibold text-ink" />}
        {pending && value.evidence && (
          <div className="flex flex-col gap-1">
            <span className="text-caption text-ink-muted">The model quoted (not in the document):</span>
            <blockquote className={`${MONO_QUOTE} text-ink-muted line-through`}>{value.evidence}</blockquote>
          </div>
        )}
      </>
    );
  } else if (changed) {
    body = (
      <div className="flex flex-wrap gap-4">
        <div className="flex min-w-0 flex-1 basis-60 flex-col gap-2">
          <span className="text-caption text-ink-muted">{`Now · version ${version}`}</span>
          <Value value={value} className="text-title font-semibold text-ink" />
          {value.evidence && <blockquote className={`${MONO_QUOTE} text-ink`}>{value.evidence}</blockquote>}
        </div>
        <Previously value={value} />
      </div>
    );
  } else {
    body = (
      <>
        <Value value={value} className="text-title font-semibold text-ink" />
        {value.evidence && <blockquote className={`${MONO_QUOTE} text-ink`}>{value.evidence}</blockquote>}
      </>
    );
  }

  return (
    <article {...handlers} className={`${frame} p-4 ${selected ? "" : "cursor-pointer"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-label font-medium text-ink-muted">{fieldLabel(value.fieldName)}</span>
        <StateBadge value={value} version={version} />
      </div>
      {body}
      {r?.note && !carried && <span className="text-caption text-ink-muted">{`Note: “${r.note}”`}</span>}
      {pending && !readOnly && <ReviewForm value={value} onReview={(b) => onReview(value.id, b)} />}
    </article>
  );
}
