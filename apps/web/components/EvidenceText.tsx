"use client";

import { useEffect, useRef } from "react";

export type Highlight = { start: number; end: number };

/**
 * The version's parsed text with a mark over [start, end) (JS string indices).
 * `scrollKey` changes when the user clicks a row, which scrolls the mark into view.
 */
export function EvidenceText({
  text,
  highlight,
  scrollKey,
}: {
  text: string | null;
  highlight: Highlight | null;
  scrollKey?: number;
}) {
  const markRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (scrollKey) markRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [scrollKey]);

  if (text === null || text === "") {
    return <p className="rounded-md border border-border bg-surface-raised p-4 text-label text-ink-muted">No document text available.</p>;
  }
  const valid = highlight && highlight.start >= 0 && highlight.start < highlight.end && highlight.end <= text.length;
  return (
    <pre className="m-0 max-h-[70vh] overflow-auto rounded-md border border-border bg-surface-raised p-4 font-mono text-evidence whitespace-pre-wrap text-ink">
      {valid ? (
        <>
          {text.slice(0, highlight.start)}
          <mark ref={markRef} className="rounded-sm bg-highlight px-0.5 text-ink">
            {text.slice(highlight.start, highlight.end)}
          </mark>
          {text.slice(highlight.end)}
        </>
      ) : (
        text
      )}
    </pre>
  );
}
