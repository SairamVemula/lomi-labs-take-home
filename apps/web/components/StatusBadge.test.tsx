import { render, screen } from "@testing-library/react";
import type { DocumentStatus } from "@lomi/shared";
import { StatusBadge } from "./StatusBadge";

const cases: [DocumentStatus, string, string][] = [
  ["queued", "Queued", "text-ink-muted"],
  ["extracting", "Extracting…", "text-accent"],
  ["extracted", "Extracted", "text-approved"],
  ["failed", "Failed", "text-failed"],
  ["superseded", "Superseded", "text-ink-muted"],
];

describe("StatusBadge", () => {
  it.each(cases)("%s renders label %s with colour class %s", (status, label, colour) => {
    render(<StatusBadge status={status} />);
    const badge = screen.getByText(label);
    expect(badge).toHaveClass(colour);
    expect(badge).toHaveClass("rounded-pill");
  });

  it("animates only while extracting", () => {
    const { rerender } = render(<StatusBadge status="extracting" />);
    expect(screen.getByText("Extracting…")).toHaveClass("animate-pulse");
    rerender(<StatusBadge status="extracted" />);
    expect(screen.getByText("Extracted")).not.toHaveClass("animate-pulse");
  });
});
