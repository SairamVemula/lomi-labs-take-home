import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "../lib/api";
import { value } from "../test/fixtures";
import { ReviewForm } from "./ReviewForm";

describe("ReviewForm", () => {
  it("Approve sends the approve action", async () => {
    const onReview = vi.fn().mockResolvedValue(undefined);
    render(<ReviewForm value={value()} onReview={onReview} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(onReview).toHaveBeenCalledWith({ action: "approve" }));
  });

  it("a gap shows Confirm gap / Enter value; Confirm gap sends approve", async () => {
    const onReview = vi.fn().mockResolvedValue(undefined);
    const gap = value({ value: null, effectiveValue: null, gapReason: "evidence not found", fieldType: "money" });
    render(<ReviewForm value={gap} onReview={onReview} />);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByRole("button", { name: "Enter value" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm gap" }));
    await waitFor(() => expect(onReview).toHaveBeenCalledWith({ action: "approve" }));
  });

  it("money sends {amount,currency} with the currency defaulted from the current value", async () => {
    const onReview = vi.fn().mockResolvedValue(undefined);
    const money = value({
      fieldType: "money",
      value: { amount: 5230.29, currency: "EUR" },
      effectiveValue: { amount: 5230.29, currency: "EUR" },
    });
    render(<ReviewForm value={money} onReview={onReview} />);
    fireEvent.click(screen.getByRole("button", { name: "Correct" }));
    fireEvent.change(screen.getByLabelText("Corrected value"), { target: { value: "6126.45" } });
    expect(screen.getByLabelText("Currency")).toHaveValue("EUR");
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: "revised" } });
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    await waitFor(() =>
      expect(onReview).toHaveBeenCalledWith({
        action: "correct",
        value: { amount: 6126.45, currency: "EUR" },
        note: "revised",
      }),
    );
  });

  it("money defaults to USD for a gap", () => {
    const gap = value({ fieldType: "money", value: null, effectiveValue: null, gapReason: "x" });
    render(<ReviewForm value={gap} onReview={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Enter value" }));
    expect(screen.getByLabelText("Currency")).toHaveValue("USD");
  });

  it("date uses a YYYY-MM-DD placeholder and sends text", async () => {
    const onReview = vi.fn().mockResolvedValue(undefined);
    render(<ReviewForm value={value()} onReview={onReview} />);
    fireEvent.click(screen.getByRole("button", { name: "Correct" }));
    const input = screen.getByLabelText("Corrected value");
    expect(input).toHaveAttribute("placeholder", "YYYY-MM-DD");
    fireEvent.change(input, { target: { value: "2025-11-13" } });
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    await waitFor(() => expect(onReview).toHaveBeenCalledWith({ action: "correct", value: "2025-11-13" }));
  });

  it("renders the API's 400 message inline and keeps the form open", async () => {
    const msg = "invalid date: 31/02/2026 is not a real calendar date.";
    const onReview = vi.fn().mockRejectedValue(new ApiError(400, "INVALID_VALUE", msg));
    render(<ReviewForm value={value()} onReview={onReview} />);
    fireEvent.click(screen.getByRole("button", { name: "Correct" }));
    fireEvent.change(screen.getByLabelText("Corrected value"), { target: { value: "31/02/2026" } });
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    expect(await screen.findByText(msg)).toBeInTheDocument();
    expect(screen.getByLabelText("Corrected value")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Save correction" })).toBeInTheDocument();
  });

  it("Cancel closes the form", () => {
    render(<ReviewForm value={value()} onReview={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Correct" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Corrected value")).toBeNull();
  });
});
