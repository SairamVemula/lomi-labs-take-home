import { review, value } from "../test/fixtures";
import { groupValues, headline, progressOf, subline } from "./review";

const pending = (id: string) => value({ id });
const approved = (id: string) => value({ id, latestReview: review() });
const carried = (id: string) => value({ id, latestReview: review({ origin: "carried_over" }) });

describe("groupValues", () => {
  it("puts pending first (gaps included), then reviewed, without headings on a first extraction", () => {
    const gap = value({ id: "gap", value: null, effectiveValue: null, gapReason: "not found" });
    const g = groupValues([approved("a"), gap, pending("p")]);
    expect(g.pendingCount).toBe(2);
    expect(g.grouped).toBe(false);
    expect(g.ordered.map((v) => v.id)).toEqual(["gap", "p", "a"]);
  });

  it("splits needs-review, carried-over and manual reviews once something was carried", () => {
    const g = groupValues([carried("c1"), approved("m"), pending("p"), carried("c2")]);
    expect(g.grouped).toBe(true);
    expect(g.groups.map((x) => [x.key, x.values.map((v) => v.id)])).toEqual([
      ["pending", ["p"]],
      ["carried", ["c1", "c2"]],
      ["reviewed", ["m"]],
    ]);
  });
});

describe("headline / subline", () => {
  it("counts values with no review", () => {
    expect(headline(2)).toBe("2 values need your review");
    expect(headline(1)).toBe("1 value needs your review");
  });
  it("says All reviewed at zero", () => {
    expect(headline(0)).toBe("All reviewed");
  });
  it("describes the carry-over only after re-extraction", () => {
    const p = { versionNumber: 1, value: "x", latestReview: null };
    const vals = [
      value({ id: "x", changeStatus: "changed", previous: p }),
      value({ id: "y", changeStatus: "changed", previous: p }),
      { ...carried("c1"), previous: p },
      { ...carried("c2"), previous: p },
      { ...carried("c3"), previous: p },
    ];
    expect(subline(vals, 2)).toBe(
      "Version 2 changed 2 values. 3 reviews carried over from version 1 because their evidence didn’t change.",
    );
    expect(subline(vals, 1)).toBeNull();
  });
  it("names the real baseline version when it is not adjacent (v3 vs v1)", () => {
    const prev = (n: number) => ({ versionNumber: n, value: "x", latestReview: null });
    const vals = [
      value({ id: "x", changeStatus: "changed", previous: prev(1) }),
      value({ id: "c", changeStatus: "unchanged", latestReview: review({ origin: "carried_over" }), previous: prev(1) }),
    ];
    expect(subline(vals, 3)).toBe(
      "Version 3 changed 1 value. 1 review carried over from version 1 because their evidence didn’t change.",
    );
  });
  it("omits the number when the baselines are mixed", () => {
    const prev = (n: number) => ({ versionNumber: n, value: "x", latestReview: null });
    const vals = [
      value({ id: "x", changeStatus: "changed", previous: prev(1) }),
      value({ id: "c", changeStatus: "unchanged", latestReview: review({ origin: "carried_over" }), previous: prev(2) }),
    ];
    expect(subline(vals, 3)).toContain("carried over from the previous version because");
  });
});

describe("progressOf", () => {
  it("buckets values exclusively with carried-over winning", () => {
    const corrected = value({ id: "k", latestReview: review({ action: "correct", correctedValue: "x" }) });
    expect(progressOf([pending("p"), approved("a"), corrected, carried("c")])).toEqual({
      pending: 1,
      approved: 1,
      corrected: 1,
      carried_over: 1,
      total: 4,
    });
  });
});
