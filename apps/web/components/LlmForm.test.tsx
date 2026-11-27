import { fireEvent, render, screen } from "@testing-library/react";
import { LlmForm } from "./LlmForm";

const presets = [
  { name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { name: "LM Studio", baseUrl: "http://host.docker.internal:1234/v1" },
];

function renderForm(keyOptional: boolean) {
  const onSubmit = vi.fn();
  render(
    <LlmForm
      idPrefix="t"
      presets={presets}
      submitLabel="Save"
      pendingLabel="Saving"
      error={null}
      pending={false}
      onSubmit={onSubmit}
      keyOptional={keyOptional}
    />,
  );
  return onSubmit;
}

describe("LlmForm", () => {
  it("keyOptional: submits without an API key (LM Studio / Ollama)", () => {
    const onSubmit = renderForm(true);
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "LM Studio" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "qwen3-8b" } });
    expect(screen.getByLabelText(/API key/)).not.toBeRequired();
    expect(screen.getByText(/optional for local servers/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledWith({ baseUrl: "http://host.docker.internal:1234/v1", apiKey: "", model: "qwen3-8b" });
  });

  it("without keyOptional the API key is required", () => {
    renderForm(false);
    expect(screen.getByLabelText(/API key/)).toBeRequired();
  });
});
