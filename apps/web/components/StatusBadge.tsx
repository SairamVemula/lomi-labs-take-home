import type { DocumentStatus } from "@lomi/shared";

const STYLES: Record<DocumentStatus, { label: string; cls: string }> = {
  queued: { label: "Queued", cls: "text-ink-muted bg-ink-muted/15" },
  extracting: { label: "Extracting…", cls: "text-accent bg-accent/15 animate-pulse" },
  extracted: { label: "Extracted", cls: "text-approved bg-approved/15" },
  failed: { label: "Failed", cls: "text-failed bg-failed/15" },
  superseded: { label: "Superseded", cls: "text-ink-muted bg-ink-muted/15" },
};

export function StatusBadge({ status }: { status: DocumentStatus }) {
  const { label, cls } = STYLES[status];
  return (
    <span className={`inline-block shrink-0 rounded-pill px-2.5 py-0.5 text-label font-medium ${cls}`}>{label}</span>
  );
}
