import type { FieldType, FieldValue } from "./fields.js";

export type NormalizeResult = { ok: true; value: FieldValue } | { ok: false; reason: string };

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function monthIndex(name: string): number {
  const n = name.toLowerCase().replace(/\.$/, "");
  if (n.length < 3) return -1;
  return MONTHS.findIndex(
    (m) => m === n || (n.length === 3 && m.startsWith(n)) || (n === "sept" && m === "september"),
  );
}

function isoDate(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  const p = (n: number, w: number) => String(n).padStart(w, "0");
  return `${p(y, 4)}-${p(m, 2)}-${p(d, 2)}`;
}

function parseDate(raw: string): string | null {
  const s = raw.trim().replace(/\s+/g, " ");
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return isoDate(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return isoDate(+m[3]!, +m[1]!, +m[2]!);
  m = /^([A-Za-z]+\.?) (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(s);
  if (m) {
    const mi = monthIndex(m[1]!);
    return mi < 0 ? null : isoDate(+m[3]!, mi + 1, +m[2]!);
  }
  m = /^(\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]+\.?),? (\d{4})$/.exec(s);
  if (m) {
    const mi = monthIndex(m[2]!);
    return mi < 0 ? null : isoDate(+m[3]!, mi + 1, +m[1]!);
  }
  return null;
}

const SYMBOLS: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP" };

function parseAmount(text: string): number | null {
  const cleaned = text.replace(/[,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$|^-?\.\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseMoney(raw: unknown): FieldValue | null {
  let amount: number | null;
  let currency = "USD";
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    amount =
      typeof o.amount === "number" ? o.amount : typeof o.amount === "string" ? parseAmount(o.amount) : null;
    if (typeof o.currency === "string") {
      const c = o.currency.trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(c)) return null;
      currency = c;
    }
  } else if (typeof raw === "number") {
    amount = raw;
  } else if (typeof raw === "string") {
    let s = raw.trim();
    const sym = /[$€£]/.exec(s);
    if (sym) {
      currency = SYMBOLS[sym[0]]!;
      s = s.replace(sym[0], "");
    }
    const code = /[A-Za-z]{3}/.exec(s);
    if (code) {
      currency = code[0].toUpperCase();
      s = s.replace(code[0], " ");
    }
    amount = parseAmount(s);
  } else return null;
  if (amount === null || !Number.isFinite(amount)) return null;
  return { amount: amount.toFixed(2), currency };
}

function parseNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const m = /-?\d[\d,]*(?:\.\d+)?|-?\.\d+/.exec(raw);
  return m ? parseAmount(m[0]) : null;
}

export function normalizeValue(type: FieldType, raw: unknown): NormalizeResult {
  switch (type) {
    case "string": {
      if (typeof raw !== "string" && typeof raw !== "number") return { ok: false, reason: "expected a string" };
      const s = String(raw).trim().replace(/\s+/g, " ");
      return s ? { ok: true, value: s } : { ok: false, reason: "empty string" };
    }
    case "date": {
      const d = typeof raw === "string" ? parseDate(raw) : null;
      return d ? { ok: true, value: d } : { ok: false, reason: `invalid date: ${JSON.stringify(raw)}` };
    }
    case "money": {
      const v = parseMoney(raw);
      return v ? { ok: true, value: v } : { ok: false, reason: `invalid money: ${JSON.stringify(raw)}` };
    }
    case "percent":
    case "number": {
      const v = parseNumber(raw);
      return v !== null ? { ok: true, value: v } : { ok: false, reason: `invalid ${type}: ${JSON.stringify(raw)}` };
    }
  }
}

function sortKeys(v: unknown): unknown {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, sortKeys(x)]),
    );
  }
  return v;
}

export function canonicalJson(v: FieldValue | null): string {
  return JSON.stringify(sortKeys(v));
}
