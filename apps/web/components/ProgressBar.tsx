import type { Progress } from "@lomi/shared";

type SegmentKey = "pending" | "approved" | "corrected" | "carried_over";

const ORDER: { key: SegmentKey; bar: string }[] = [
  { key: "pending", bar: "bg-pending" },
  { key: "approved", bar: "bg-approved" },
  { key: "corrected", bar: "bg-corrected" },
  { key: "carried_over", bar: "bg-carried" },
];

export function progressSegments(p: Progress): { key: SegmentKey; count: number; percent: number }[] {
  if (p.total <= 0) return [];
  return ORDER.filter(({ key }) => p[key] > 0).map(({ key }) => ({
    key,
    count: p[key],
    percent: (p[key] / p.total) * 100,
  }));
}

export function ProgressBar({ progress }: { progress: Progress }) {
  if (progress.total <= 0) {
    return <span className="text-label text-ink-muted">Values appear when extraction finishes</span>;
  }
  const bars = new Map(ORDER.map((o) => [o.key, o.bar]));
  const rest: string[] = [];
  if (progress.approved) rest.push(`${progress.approved} approved`);
  if (progress.corrected) rest.push(`${progress.corrected} corrected`);
  if (progress.carried_over) rest.push(`${progress.carried_over} carried over`);
  return (
    <div>
      <div
        role="img"
        aria-label={`${progress.pending} pending of ${progress.total} values`}
        className="flex h-2 overflow-hidden rounded-pill bg-border"
      >
        {progressSegments(progress).map((s) => (
          <div key={s.key} data-segment={s.key} className={bars.get(s.key)} style={{ width: `${s.percent}%` }} />
        ))}
      </div>
      <div className="mt-1.5 text-label text-ink-muted">
        {progress.pending > 0 && <strong className="font-semibold text-pending">{progress.pending} pending</strong>}
        {progress.pending > 0 && rest.length > 0 && " · "}
        {rest.join(" · ")}
        {progress.pending === 0 && rest.length === 0 && "Nothing to review"}
      </div>
    </div>
  );
}
