const CHAR_MAP: Record<string, string> = {
  "‘": "'", "’": "'", "‛": "'", "′": "'",
  "“": '"', "”": '"', "„": '"', "″": '"',
  "–": "-", "—": "-", "−": "-", "‒": "-",
};

/**
 * Fold text for verbatim matching. `map[i]` is the index in the original string
 * of the source character that produced folded char `i`. Case is preserved.
 */
export function foldForMatch(s: string): { folded: string; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  let i = 0;
  for (const ch of s) {
    const idx = i;
    i += ch.length;
    for (const f of ch.normalize("NFKC")) {
      const c = CHAR_MAP[f] ?? f;
      if (/\s/.test(c)) {
        if (chars.length > 0 && chars[chars.length - 1] !== " ") {
          chars.push(" ");
          map.push(idx);
        }
      } else {
        chars.push(c);
        map.push(idx);
      }
    }
  }
  if (chars[chars.length - 1] === " ") {
    chars.pop();
    map.pop();
  }
  return { folded: chars.join(""), map };
}
