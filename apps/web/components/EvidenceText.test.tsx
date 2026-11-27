import { render } from "@testing-library/react";
import { EvidenceText } from "./EvidenceText";

const TEXT = "Invoice Number: INV-1\nDue Date: 2025-10-14\nTotal: $5";

describe("EvidenceText", () => {
  it("wraps exactly the evidence slice in a mark", () => {
    const start = TEXT.indexOf("Due Date");
    const end = start + "Due Date: 2025-10-14".length;
    const { container } = render(<EvidenceText text={TEXT} highlight={{ start, end }} />);
    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0]!.textContent).toBe(TEXT.slice(start, end));
    expect(marks[0]).toHaveClass("bg-highlight", "text-ink");
    expect(container.querySelector("pre")!.textContent).toBe(TEXT);
  });

  it("renders no mark when there are no offsets", () => {
    const { container } = render(<EvidenceText text={TEXT} highlight={null} />);
    expect(container.querySelector("mark")).toBeNull();
    expect(container.querySelector("pre")!.textContent).toBe(TEXT);
  });

  it("ignores offsets outside the text", () => {
    const { container } = render(<EvidenceText text="abc" highlight={{ start: 2, end: 99 }} />);
    expect(container.querySelector("mark")).toBeNull();
  });

  it("shows an empty state without text", () => {
    const { getByText } = render(<EvidenceText text={null} highlight={null} />);
    expect(getByText(/no document text/i)).toBeInTheDocument();
  });
});
