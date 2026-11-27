import { foldForMatch } from "./text.js";

/** Locate `quote` in `parsedText` (folded, case-sensitive). Offsets are [start, end) into the original text. */
export function findEvidence(
  parsedText: string,
  quote: string,
): { start: number; end: number } | null {
  const q = foldForMatch(quote).folded;
  if (q.length === 0) return null;
  const { folded, map } = foldForMatch(parsedText);
  const at = folded.indexOf(q);
  if (at < 0) return null;
  const last = at + q.length - 1;
  const start = map[at]!;
  // end: one past the last original char of the final matched folded char
  const lastIdx = map[last]!;
  const cp = parsedText.codePointAt(lastIdx);
  const end = lastIdx + (cp !== undefined && cp > 0xffff ? 2 : 1);
  return { start, end };
}

export function normalizeEvidenceForCompare(s: string): string {
  return foldForMatch(s).folded.toLowerCase();
}
