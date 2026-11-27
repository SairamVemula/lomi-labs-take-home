import type { Progress, ValueView } from "@lomi/shared";

export type GroupKey = "pending" | "carried" | "reviewed";

export const isPending = (v: ValueView): boolean => v.latestReview === null;
export const isCarried = (v: ValueView): boolean => v.latestReview?.origin === "carried_over";
export const isChanged = (v: ValueView): boolean => v.changeStatus === "changed" && v.previous !== null;

export type Grouped = {
  pendingCount: number;
  carriedCount: number;
  /** True once something was carried over: the list then shows group headings. */
  grouped: boolean;
  groups: { key: GroupKey; values: ValueView[] }[];
  /** Pending first (gaps included), then carried, then manual reviews; server order kept inside each group. */
  ordered: ValueView[];
};

export function groupValues(values: ValueView[]): Grouped {
  const pending = values.filter(isPending);
  const carried = values.filter((v) => !isPending(v) && isCarried(v));
  const reviewed = values.filter((v) => !isPending(v) && !isCarried(v));
  const groups = (
    [
      { key: "pending", values: pending },
      { key: "carried", values: carried },
      { key: "reviewed", values: reviewed },
    ] as const
  ).filter((g) => g.values.length > 0);
  return {
    pendingCount: pending.length,
    carriedCount: carried.length,
    grouped: carried.length > 0,
    groups: groups.map((g) => ({ key: g.key, values: [...g.values] })),
    ordered: [...pending, ...carried, ...reviewed],
  };
}

export function headline(pendingCount: number): string {
  if (pendingCount === 0) return "All reviewed";
  return pendingCount === 1 ? "1 value needs your review" : `${pendingCount} values need your review`;
}

/** Re-extraction summary; null for version 1 or when nothing changed or carried. */
export function subline(values: ValueView[], version: number): string | null {
  if (version <= 1) return null;
  const changed = values.filter((v) => v.changeStatus === "changed").length;
  const carried = values.filter(isCarried).length;
  if (changed === 0 && carried === 0) return null;
  const s = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return (
    `Version ${version} changed ${s(changed, "value", "values")}. ` +
    `${s(carried, "review", "reviews")} carried over from version ${version - 1} because their evidence didn’t change.`
  );
}

/** Same buckets as the server's progress (exclusive; carried-over wins over the action). */
export function progressOf(values: ValueView[]): Progress {
  const p: Progress = { pending: 0, approved: 0, corrected: 0, carried_over: 0, total: values.length };
  for (const v of values) {
    if (!v.latestReview) p.pending++;
    else if (v.latestReview.origin === "carried_over") p.carried_over++;
    else if (v.latestReview.action === "correct") p.corrected++;
    else p.approved++;
  }
  return p;
}
