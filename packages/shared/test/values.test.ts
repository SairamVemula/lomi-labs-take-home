import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXPECTED_FIELDS, canonicalJson, normalizeValue } from "../src/index.js";

describe("normalizeValue", () => {
  it("normalizes dates", () => {
    expect(normalizeValue("date", "March 3, 2026")).toEqual({ ok: true, value: "2026-03-03" });
    expect(normalizeValue("date", "3 March 2026")).toEqual({ ok: true, value: "2026-03-03" });
    expect(normalizeValue("date", "03/04/2026")).toEqual({ ok: true, value: "2026-03-04" });
    expect(normalizeValue("date", "2026-03-03")).toEqual({ ok: true, value: "2026-03-03" });
  });
  it("rejects impossible dates", () => {
    const r = normalizeValue("date", "2026-02-31");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("date");
    expect(normalizeValue("date", "02/30/2026").ok).toBe(false);
    expect(normalizeValue("date", "2025-02-29").ok).toBe(false);
    expect(normalizeValue("date", "Feb 29, 2024")).toEqual({ ok: true, value: "2024-02-29" });
  });
  it("normalizes money", () => {
    const want = { ok: true, value: { amount: "1234.50", currency: "USD" } };
    expect(normalizeValue("money", "$1,234.5")).toEqual(want);
    expect(normalizeValue("money", { amount: 1234.5, currency: "usd" })).toEqual(want);
    expect(normalizeValue("money", "€10")).toEqual({ ok: true, value: { amount: "10.00", currency: "EUR" } });
    expect(normalizeValue("money", "GBP 5.255")).toMatchObject({ ok: true, value: { currency: "GBP" } });
    expect(normalizeValue("money", "abc").ok).toBe(false);
  });
  it("normalizes percent and number", () => {
    expect(normalizeValue("percent", "4.2%")).toEqual({ ok: true, value: 4.2 });
    expect(normalizeValue("number", "12 months")).toEqual({ ok: true, value: 12 });
    expect(normalizeValue("number", "n/a").ok).toBe(false);
  });
  it("normalizes strings", () => {
    expect(normalizeValue("string", "  Acme  Corp ")).toEqual({ ok: true, value: "Acme Corp" });
    expect(normalizeValue("string", "   ").ok).toBe(false);
  });
});

describe("canonicalJson", () => {
  it("sorts keys", () => {
    expect(canonicalJson({ currency: "USD", amount: "1.00" })).toBe(
      canonicalJson({ amount: "1.00", currency: "USD" }),
    );
    expect(canonicalJson(null)).toBe("null");
  });
});

describe("EXPECTED_FIELDS", () => {
  it("equals the fixture", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("../../../assignment/fixtures/expected-fields.json", import.meta.url), "utf8"),
    );
    expect(EXPECTED_FIELDS).toEqual(fixture);
  });
});
