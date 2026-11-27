import { render, screen } from "@testing-library/react";
import { ProgressBar, progressSegments } from "./ProgressBar";

describe("progressSegments", () => {
  it("orders pending, approved, corrected, carried over and sums to 100%", () => {
    const segs = progressSegments({ pending: 2, approved: 1, corrected: 1, carried_over: 3, total: 7 });
    expect(segs.map((s) => s.key)).toEqual(["pending", "approved", "corrected", "carried_over"]);
    expect(segs.reduce((n, s) => n + s.percent, 0)).toBeCloseTo(100, 6);
  });

  it("drops empty segments", () => {
    const segs = progressSegments({ pending: 5, approved: 0, corrected: 0, carried_over: 0, total: 5 });
    expect(segs).toEqual([{ key: "pending", count: 5, percent: 100 }]);
  });

  it("has no segments when total is zero", () => {
    expect(progressSegments({ pending: 0, approved: 0, corrected: 0, carried_over: 0, total: 0 })).toEqual([]);
  });
});

describe("ProgressBar", () => {
  it("renders segment widths and a pending summary", () => {
    const { container } = render(
      <ProgressBar progress={{ pending: 2, approved: 0, corrected: 0, carried_over: 3, total: 5 }} />,
    );
    const segs = container.querySelectorAll<HTMLElement>("[data-segment]");
    expect([...segs].map((s) => s.dataset.segment)).toEqual(["pending", "carried_over"]);
    expect(segs[0]).toHaveStyle({ width: "40%" });
    expect(segs[0]).toHaveClass("bg-pending");
    expect(segs[1]).toHaveStyle({ width: "60%" });
    expect(segs[1]).toHaveClass("bg-carried");
    expect(screen.getByText("2 pending")).toBeInTheDocument();
    expect(screen.getByText(/3 carried over/)).toBeInTheDocument();
  });

  it("shows the empty copy for zero total", () => {
    render(<ProgressBar progress={{ pending: 0, approved: 0, corrected: 0, carried_over: 0, total: 0 }} />);
    expect(screen.getByText("Values appear when extraction finishes")).toBeInTheDocument();
  });
});
