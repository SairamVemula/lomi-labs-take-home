const BASE = "inline-block shrink-0 rounded-pill px-2 py-0.5 text-caption font-medium";

export type BadgeKind = "pending" | "approved" | "corrected" | "carried" | "changed" | "new";

const STYLES: Record<BadgeKind, string> = {
  pending: "text-pending bg-pending/15",
  approved: "text-approved bg-approved/15",
  corrected: "text-corrected bg-corrected/15",
  carried: "text-carried bg-carried/15",
  changed: "text-pending bg-pending/15",
  new: "text-accent bg-accent/15",
};

export function Badge({ kind, children }: { kind: BadgeKind; children: React.ReactNode }) {
  return <span className={`${BASE} ${STYLES[kind]}`}>{children}</span>;
}

/** Re-extraction change marker: Changed (amber) or New. Unchanged rows get no badge. */
export function ChangeBadge({ status }: { status: "new" | "unchanged" | "changed" }) {
  if (status === "changed") return <Badge kind="changed">Changed</Badge>;
  if (status === "new") return <Badge kind="new">New</Badge>;
  return null;
}
