import { describe, expect, it } from "vitest";
import { findEvidence, foldForMatch, normalizeEvidenceForCompare } from "../src/index.js";

describe("findEvidence", () => {
  it("matches a quote split across a line break", () => {
    const text = "Rent\nTotal Due:\n$1,234.50\nThanks";
    const r = findEvidence(text, "Total Due: $1,234.50");
    expect(r).not.toBeNull();
    const s = text.slice(r!.start, r!.end);
    expect(s).toContain("Total Due:");
    expect(s).toContain("$1,234.50");
    expect(s).toBe("Total Due:\n$1,234.50");
  });
  it("folds quotes, dashes and ligatures", () => {
    const text = "Tenant’s deposit – ﬁve hundred";
    const r = findEvidence(text, "Tenant's deposit - five hundred");
    expect(r).toEqual({ start: 0, end: text.length });
  });
  it("returns null for hallucinated quote", () => {
    expect(findEvidence("Total Due: $1,234.50", "Total Due: $9,999.00")).toBeNull();
  });
  it("returns null for empty or whitespace quote", () => {
    expect(findEvidence("abc", "")).toBeNull();
    expect(findEvidence("abc", " \n\t ")).toBeNull();
  });
  it("is case-sensitive", () => {
    expect(findEvidence("Total Due", "total due")).toBeNull();
  });
  it("returns the first occurrence", () => {
    expect(findEvidence("ab ab", "ab")).toEqual({ start: 0, end: 2 });
  });
});

describe("foldForMatch", () => {
  it("trims and keeps map aligned", () => {
    const { folded, map } = foldForMatch("  a \n b ");
    expect(folded).toBe("a b");
    expect(map).toEqual([2, 3, 6]);
  });
});

describe("normalizeEvidenceForCompare", () => {
  it("folds and lowercases", () => {
    expect(normalizeEvidenceForCompare(" “Hi”\n—There ")).toBe('"hi" -there');
  });
});
