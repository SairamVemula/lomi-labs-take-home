"use client";

import { useState, type FormEvent } from "react";
import { inputClass, primaryButton } from "../lib/focus";

export type LlmValues = { baseUrl: string; apiKey: string; model: string };
type Preset = { name: string; baseUrl: string };

const CUSTOM = "__custom__";

export function LlmForm({
  idPrefix,
  presets,
  submitLabel,
  pendingLabel,
  error,
  pending,
  onSubmit,
  note,
  keyOptional = false,
  initial,
}: {
  idPrefix: string;
  presets: Preset[];
  submitLabel: string;
  pendingLabel: string;
  error: { title: string; detail: string } | null;
  pending: boolean;
  onSubmit: (v: LlmValues) => void;
  note?: string;
  /** Local mode: keyless servers (LM Studio, Ollama) need no API key. */
  keyOptional?: boolean;
  /** The saved config to start from (the key is never sent back, so it always starts empty). */
  initial?: { baseUrl: string; model: string };
}) {
  const startUrl = initial?.baseUrl ?? presets[0]?.baseUrl ?? "";
  const [preset, setPreset] = useState(
    initial ? (presets.find((p) => p.baseUrl === initial.baseUrl)?.name ?? CUSTOM) : (presets[0]?.name ?? CUSTOM),
  );
  const [baseUrl, setBaseUrl] = useState(startUrl);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initial?.model ?? "gpt-4.1-mini");

  function pickPreset(name: string) {
    setPreset(name);
    const p = presets.find((x) => x.name === name);
    if (p) setBaseUrl(p.baseUrl);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit({ baseUrl: baseUrl.trim(), apiKey, model: model.trim() });
  }

  const label = "text-label font-medium";
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" aria-busy={pending}>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${idPrefix}-provider`} className={label}>
          Provider
        </label>
        <select id={`${idPrefix}-provider`} value={preset} onChange={(e) => pickPreset(e.target.value)} className={inputClass}>
          {presets.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
          <option value={CUSTOM}>Custom endpoint</option>
        </select>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${idPrefix}-base`} className={label}>
          Base URL
        </label>
        <input
          id={`${idPrefix}-base`}
          type="url"
          required
          value={baseUrl}
          onChange={(e) => {
            setBaseUrl(e.target.value);
            setPreset(presets.find((p) => p.baseUrl === e.target.value)?.name ?? CUSTOM);
          }}
          className={`${inputClass} font-mono text-evidence`}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${idPrefix}-key`} className={label}>
          API key
        </label>
        <input
          id={`${idPrefix}-key`}
          type="password"
          required={!keyOptional}
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={keyOptional ? `${idPrefix}-key-hint` : undefined}
          className={`${inputClass} ${error ? "border-failed" : ""}`}
        />
        {keyOptional && (
          <span id={`${idPrefix}-key-hint`} className="text-caption text-ink-muted">
            Optional for local servers such as LM Studio or Ollama.
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${idPrefix}-model`} className={label}>
          Model
        </label>
        <input id={`${idPrefix}-model`} required value={model} onChange={(e) => setModel(e.target.value)} className={inputClass} />
        <span className="text-caption text-ink-muted">Must support structured output (json_schema).</span>
      </div>
      {error && (
        <div role="alert" className="rounded-md bg-failed/15 p-3 text-label text-failed">
          <strong className="font-semibold">{error.title}</strong> {error.detail}
        </div>
      )}
      <button type="submit" disabled={pending} className={primaryButton}>
        {pending ? pendingLabel : submitLabel}
      </button>
      {note && <p className="text-caption text-ink-muted">{note}</p>}
    </form>
  );
}
