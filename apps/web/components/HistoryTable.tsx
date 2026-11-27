import type { ValueView } from "@lomi/shared";
import { displayText, displayValue, fieldLabel } from "../lib/format";
import { Badge } from "./ChangeBadge";

function ReviewCell({ value }: { value: ValueView }) {
  const r = value.latestReview;
  if (!r) return <Badge kind="pending">Pending</Badge>;
  const corrected = r.action === "correct";
  return (
    <>
      <Badge kind={corrected ? "corrected" : "approved"}>{corrected ? "Corrected" : "Approved"}</Badge>
      {r.origin === "carried_over" && <span className="ml-2 text-caption text-carried">carried over</span>}
      {r.note && <div className="mt-1 text-caption text-ink-muted">{`“${r.note}”`}</div>}
    </>
  );
}

/** Read-only table for a superseded version (md and up); phones use read-only ValueRow cards instead. */
export function HistoryTable({ values, version }: { values: ValueView[]; version: number }) {
  const th = "border-b border-border px-4 py-3 text-left text-label font-medium text-ink-muted";
  return (
    <div className="hidden overflow-x-auto rounded-md border border-border bg-surface-raised md:block">
      <table className="w-full min-w-[720px] border-collapse text-body">
        <thead>
          <tr>
            <th scope="col" className={th}>Field</th>
            <th scope="col" className={th}>Value</th>
            <th scope="col" className={th}>{`Evidence (version ${version} text)`}</th>
            <th scope="col" className={th}>Review</th>
          </tr>
        </thead>
        <tbody>
          {values.map((v) => {
            const d = displayValue(v.fieldType, v.effectiveValue);
            return (
              <tr key={v.id} className="border-b border-border last:border-b-0">
                <td className="p-4 text-ink-muted">{fieldLabel(v.fieldName)}</td>
                <td className="p-4 font-semibold">
                  {v.gapReason !== null && v.effectiveValue === null ? (
                    <span className="font-medium text-pending">{`Gap: ${v.gapReason}`}</span>
                  ) : (
                    <>
                      {d.main}
                      {d.unit && <span className="ml-1 text-label font-medium text-ink-muted">{d.unit}</span>}
                      {v.latestReview?.action === "correct" && v.value !== null && (
                        <span className="ml-2 font-normal text-ink-muted line-through">{displayText(v.fieldType, v.value)}</span>
                      )}
                    </>
                  )}
                </td>
                <td className="p-4 font-mono text-evidence">{v.evidence}</td>
                <td className="p-4">
                  <ReviewCell value={v} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
