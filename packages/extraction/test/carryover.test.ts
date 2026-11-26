import { describe, expect, it } from "vitest";
import { diffAgainstBaseline, type AssembledValue, type BaselineValue } from "../src/index.js";

const av = (over: Partial<AssembledValue> = {}): AssembledValue => ({
  fieldName: "f",
  fieldType: "string",
  value: "A",
  evidence: "Hello World",
  evidenceStart: 0,
  evidenceEnd: 11,
  gapReason: null,
  ...over,
});
const bv = (over: Partial<BaselineValue> = {}): BaselineValue => ({
  id: "v1",
  value: "A",
  evidence: "Hello World",
  gapReason: null,
  latestReview: { id: "r1", action: "approved", correctedValue: null, note: null },
  ...over,
});

describe("diffAgainstBaseline", () => {
  it("all new with null baseline", () => {
    expect(diffAgainstBaseline([av()], null)).toEqual([
      { fieldName: "f", changeStatus: "new", previousValueId: null, carryReviewId: null },
    ]);
  });
  it("unchanged modulo whitespace/case carries review", () => {
    const r = diffAgainstBaseline([av({ evidence: "hello\n  world" })], new Map([["f", bv()]]));
    expect(r[0]).toEqual({ fieldName: "f", changeStatus: "unchanged", previousValueId: "v1", carryReviewId: "r1" });
  });
  it("same evidence different value is changed", () => {
    const r = diffAgainstBaseline([av({ value: "B" })], new Map([["f", bv()]]));
    expect(r[0]).toMatchObject({ changeStatus: "changed", previousValueId: "v1", carryReviewId: null });
  });
  it("different evidence same value is changed", () => {
    const r = diffAgainstBaseline([av({ evidence: "Other" })], new Map([["f", bv()]]));
    expect(r[0]!.changeStatus).toBe("changed");
  });
  it("gaps with equal reason unchanged; no review -> null carry", () => {
    const next = av({ value: null, evidence: null, gapReason: "nope" });
    const r = diffAgainstBaseline(
      [next],
      new Map([["f", bv({ value: null, evidence: null, gapReason: "nope", latestReview: null })]]),
    );
    expect(r[0]).toMatchObject({ changeStatus: "unchanged", carryReviewId: null, previousValueId: "v1" });
  });
  it("gaps with different reason changed", () => {
    const next = av({ value: null, evidence: null, gapReason: "a" });
    const r = diffAgainstBaseline([next], new Map([["f", bv({ value: null, evidence: null, gapReason: "b" })]]));
    expect(r[0]!.changeStatus).toBe("changed");
  });
  it("field absent from baseline is new; order follows next", () => {
    const r = diffAgainstBaseline([av({ fieldName: "z" }), av()], new Map([["f", bv()]]));
    expect(r.map((d) => [d.fieldName, d.changeStatus])).toEqual([["z", "new"], ["f", "unchanged"]]);
  });
});
