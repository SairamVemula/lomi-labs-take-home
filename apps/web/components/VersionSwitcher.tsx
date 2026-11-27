import Link from "next/link";
import type { DocumentDetail } from "@lomi/shared";
import { focusRing } from "../lib/focus";

/** v1 / v2 · current switcher. The current version links to the bare route; others to ?version=N. */
export function VersionSwitcher({ detail }: { detail: Pick<DocumentDetail, "id" | "versions" | "currentVersion" | "viewingVersion"> }) {
  if (detail.versions.length < 2) return null;
  return (
    <nav aria-label="Versions" className="flex w-full overflow-hidden rounded-md border border-border bg-surface-raised md:w-auto">
      {detail.versions.map((v) => {
        const isCurrent = v.number === detail.currentVersion;
        const active = v.number === detail.viewingVersion;
        return (
          <Link
            key={v.number}
            href={isCurrent ? `/documents/${detail.id}` : `/documents/${detail.id}?version=${v.number}`}
            aria-current={active ? "page" : undefined}
            title={v.originalFilename}
            className={`flex min-h-11 flex-1 items-center justify-center px-3.5 text-label font-medium no-underline md:flex-none ${focusRing} ${
              active ? "bg-ink text-surface" : "text-ink hover:bg-border/40"
            }`}
          >
            {isCurrent ? `v${v.number} · current` : `v${v.number}`}
          </Link>
        );
      })}
    </nav>
  );
}
