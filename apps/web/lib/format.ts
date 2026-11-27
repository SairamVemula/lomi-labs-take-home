import type { ReviewView, ValueView } from "@lomi/shared";

/** `due_date` -> `Due date`. */
export function fieldLabel(fieldName: string): string {
  const s = fieldName.replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type MoneyValue = { amount: number | string; currency: string };

export function isMoney(v: unknown): v is MoneyValue {
  return (
    v !== null &&
    typeof v === "object" &&
    (typeof (v as MoneyValue).amount === "number" || typeof (v as MoneyValue).amount === "string") &&
    typeof (v as MoneyValue).currency === "string"
  );
}

/** Display text for a value: `main` is the value itself, `unit` a small suffix (money currency). */
export function displayValue(type: ValueView["fieldType"], v: unknown): { main: string; unit?: string } {
  if (v === null || v === undefined || v === "") return { main: "—" };
  if (type === "money" && isMoney(v)) {
    let main: string;
    try {
      main = new Intl.NumberFormat("en-US", { style: "currency", currency: v.currency }).format(Number(v.amount));
    } catch {
      main = Number(v.amount).toLocaleString("en-US", { minimumFractionDigits: 2 });
    }
    return { main, unit: v.currency };
  }
  if (type === "percent" && typeof v === "number") return { main: `${v}%` };
  if (typeof v === "string" || typeof v === "number") return { main: String(v) };
  return { main: JSON.stringify(v) };
}

export function displayText(type: ValueView["fieldType"], v: unknown): string {
  const d = displayValue(type, v);
  return d.unit ? `${d.main} ${d.unit}` : d.main;
}

/** "Approved", or "Corrected to X" for a correction. */
export function reviewSummary(type: ValueView["fieldType"], r: ReviewView): string {
  return r.action === "correct" ? `Corrected to ${displayText(type, r.correctedValue)}` : "Approved";
}
