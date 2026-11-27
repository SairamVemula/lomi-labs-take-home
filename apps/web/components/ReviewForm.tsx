"use client";

import { useId, useState, type FormEvent } from "react";
import type { ReviewRequest, ValueView } from "@lomi/shared";
import { isMoney } from "../lib/format";
import { inputClass, primaryButton, secondaryButton } from "../lib/focus";

const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY", "CHF"];

function defaultCurrency(v: ValueView): string {
  const cur = isMoney(v.effectiveValue) ? v.effectiveValue.currency : isMoney(v.value) ? v.value.currency : null;
  return cur ? cur.toUpperCase() : "USD";
}

function toPayload(type: ValueView["fieldType"], text: string, currency: string): unknown {
  const t = text.trim();
  if (type === "money") {
    const cleaned = t.replace(/[,\s]/g, "");
    return { amount: cleaned !== "" && Number.isFinite(Number(cleaned)) ? Number(cleaned) : t, currency };
  }
  return t;
}

function placeholderFor(type: ValueView["fieldType"]): string | undefined {
  if (type === "date") return "YYYY-MM-DD";
  if (type === "money") return "0.00";
  if (type === "percent") return "e.g. 8.625";
  if (type === "number") return "e.g. 12";
  return undefined;
}

/**
 * Review controls for one pending value: Approve / Correct, or Confirm gap / Enter value for a gap.
 * `onReview` rejects with the API error; its message is shown inline.
 */
export function ReviewForm({ value, onReview }: { value: ValueView; onReview: (body: ReviewRequest) => Promise<unknown> }) {
  const id = useId();
  const isGap = value.value === null && value.gapReason !== null;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [currency, setCurrency] = useState(() => defaultCurrency(value));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(body: ReviewRequest) {
    setBusy(true);
    setError(null);
    try {
      await onReview(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the review");
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (text.trim() === "") {
      setError("Enter a value");
      return;
    }
    const n = note.trim();
    void run({ action: "correct", value: toPayload(value.fieldType, text, currency), ...(n ? { note: n } : {}) });
  }

  if (!open) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2 max-md:[&>button]:flex-1">
          {isGap ? (
            <button type="button" disabled={busy} onClick={() => void run({ action: "approve" })} className={secondaryButton}>
              Confirm gap
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={() => void run({ action: "approve" })} className={primaryButton}>
              Approve
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setError(null);
              setOpen(true);
            }}
            className={secondaryButton}
          >
            {isGap ? "Enter value" : "Correct"}
          </button>
        </div>
        {error && (
          <p role="alert" className="text-caption text-failed">
            {error}
          </p>
        )}
      </div>
    );
  }

  const errId = `${id}-err`;
  const type = value.fieldType;
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 border-t border-border pt-3">
      <div className="flex flex-wrap gap-3">
        <div className="flex min-w-0 flex-[1_1_200px] flex-col gap-1.5">
          <label htmlFor={`${id}-v`} className="text-label font-medium">
            Corrected value
          </label>
          <div className="flex gap-2">
            <input
              id={`${id}-v`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={placeholderFor(type)}
              inputMode={type === "money" || type === "number" || type === "percent" ? "decimal" : undefined}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errId : undefined}
              autoFocus
              className={`${inputClass} ${error ? "border-failed" : ""}`}
            />
            {type === "money" && (
              <>
                <label htmlFor={`${id}-c`} className="sr-only">
                  Currency
                </label>
                <select
                  id={`${id}-c`}
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  className={`${inputClass} w-24 shrink-0`}
                >
                  {(CURRENCIES.includes(currency) ? CURRENCIES : [currency, ...CURRENCIES]).map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
          {error && (
            <span id={errId} role="alert" className="text-caption text-failed">
              {error}
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-[2_1_260px] flex-col gap-1.5">
          <label htmlFor={`${id}-n`} className="text-label font-medium">
            Note <span className="font-normal text-ink-muted">(optional)</span>
          </label>
          <input id={`${id}-n`} value={note} onChange={(e) => setNote(e.target.value)} className={inputClass} />
        </div>
      </div>
      <div className="flex flex-wrap gap-2 max-md:[&>button]:flex-1">
        <button type="submit" disabled={busy} className={primaryButton}>
          {busy ? "Saving…" : "Save correction"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="inline-flex min-h-11 items-center justify-center rounded-md px-4 text-body font-medium text-ink hover:bg-border/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
