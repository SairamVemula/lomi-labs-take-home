import { fireEvent, render, screen } from "@testing-library/react";
import { review, value } from "../test/fixtures";
import { ValueRow } from "./ValueRow";

const base = { version: 1, selected: false, readOnly: false, onSelect: vi.fn(), onHover: vi.fn(), onReview: vi.fn() };

describe("ValueRow", () => {
  it("pending row: Pending badge, evidence quote, review buttons", () => {
    render(<ValueRow {...base} value={value()} />);
    expect(screen.getByText("Pending")).toHaveClass("text-pending");
    expect(screen.getByText("Due Date: 2025-10-14")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("approved row: Approved badge and no buttons", () => {
    render(<ValueRow {...base} value={value({ latestReview: review() })} />);
    expect(screen.getByText("Approved")).toHaveClass("text-approved");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("corrected row shows the new value with the original struck through and the note", () => {
    const v = value({
      value: "MERIDIAN LLC",
      effectiveValue: "Meridian LLC",
      fieldType: "string",
      latestReview: review({ action: "correct", correctedValue: "Meridian LLC", note: "Use title case" }),
    });
    render(<ValueRow {...base} value={v} />);
    expect(screen.getByText("Corrected")).toHaveClass("text-corrected");
    expect(screen.getByText("Meridian LLC")).toBeInTheDocument();
    expect(screen.getByText("MERIDIAN LLC")).toHaveClass("line-through");
    expect(screen.getByText(/Use title case/)).toBeInTheDocument();
  });

  it("carried row: Carried over · approved / corrected", () => {
    const a = value({ id: "a", latestReview: review({ origin: "carried_over" }) });
    const { unmount } = render(<ValueRow {...base} value={a} />);
    expect(screen.getByText("Carried over · approved")).toHaveClass("text-carried");
    unmount();
    const b = value({
      id: "b",
      latestReview: review({ origin: "carried_over", action: "correct", correctedValue: "x" }),
    });
    render(<ValueRow {...base} value={b} />);
    expect(screen.getByText("Carried over · corrected")).toBeInTheDocument();
  });

  it("changed row shows Now vs Previously with the previous value and review", () => {
    const v = value({
      value: "2025-11-13",
      effectiveValue: "2025-11-13",
      changeStatus: "changed",
      previous: {
        versionNumber: 1,
        value: "2025-10-14",
        latestReview: review({ action: "correct", correctedValue: "2025-10-15", note: "by phone" }),
      },
    });
    render(<ValueRow {...base} version={2} value={v} />);
    expect(screen.getByText("Changed")).toHaveClass("text-pending");
    expect(screen.getByText("Now · version 2")).toBeInTheDocument();
    const box = screen.getByText("Previously · version 1").parentElement!;
    expect(box).toHaveTextContent("2025-10-14");
    expect(box).toHaveTextContent("Corrected to 2025-10-15");
    expect(box).toHaveTextContent("by phone");
  });

  it("labels the baseline by its real version number after a supersede (v3 vs v1)", () => {
    const v = value({
      changeStatus: "changed",
      previous: { versionNumber: 1, value: "2025-10-14", latestReview: null },
    });
    render(<ValueRow {...base} version={3} value={v} />);
    expect(screen.getByText("Now · version 3")).toBeInTheDocument();
    expect(screen.getByText("Previously · version 1")).toBeInTheDocument();
    expect(screen.queryByText("Previously · version 2")).toBeNull();
  });

  it("a gap shows the reason in amber and the struck model quote; Confirm gap / Enter value", () => {
    const v = value({
      value: null,
      effectiveValue: null,
      gapReason: "evidence not found verbatim",
      evidence: "Total: $5",
      evidenceStart: null,
      evidenceEnd: null,
    });
    render(<ValueRow {...base} value={v} />);
    expect(screen.getByText("Gap: evidence not found verbatim")).toHaveClass("text-pending");
    expect(screen.getByText("Total: $5")).toHaveClass("line-through");
    expect(screen.getByRole("button", { name: "Confirm gap" })).toBeInTheDocument();
  });

  it("read-only hides the review buttons", () => {
    render(<ValueRow {...base} readOnly value={value()} />);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("clicking selects the row", () => {
    const onSelect = vi.fn();
    render(<ValueRow {...base} onSelect={onSelect} value={value()} />);
    fireEvent.click(screen.getByRole("article"));
    expect(onSelect).toHaveBeenCalledWith("v1");
  });
});
