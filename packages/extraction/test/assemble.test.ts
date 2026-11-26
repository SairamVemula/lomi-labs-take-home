import { describe, expect, it } from "vitest";
import { EXPECTED_FIELDS } from "@lomi/shared";
import { assembleValues } from "../src/assemble.js";

const text = "Invoice total: $1,200.00 due soon.";
const [first] = EXPECTED_FIELDS.invoice;

describe("assembleValues", () => {
  it("uses gap_reason when value is null", () => {
    const out = assembleValues("invoice", text, {
      [first!.field]: { value: null, evidence: null, gap_reason: "not stated" },
    });
    expect(out[0]).toMatchObject({ value: null, gapReason: "not stated", evidence: null });
  });
  it("defaults gap reason when none given", () => {
    const out = assembleValues("invoice", text, {
      [first!.field]: { value: null, evidence: null, gap_reason: "" },
    });
    expect(out[0]!.gapReason).toBe("not found in document");
  });
  it("gaps when evidence is not in text", () => {
    const out = assembleValues("invoice", text, {
      [first!.field]: { value: "x", evidence: "nowhere", gap_reason: null },
    });
    expect(out[0]).toMatchObject({
      value: null,
      gapReason: "evidence not found verbatim in document text",
      evidence: "nowhere",
      evidenceStart: null,
      evidenceEnd: null,
    });
  });
  it("gaps when evidence is null", () => {
    const out = assembleValues("invoice", text, {
      [first!.field]: { value: "x", evidence: null, gap_reason: null },
    });
    expect(out[0]).toMatchObject({ value: null, gapReason: "no evidence quoted", evidence: null });
  });
  it("gaps when value not parseable", () => {
    const moneyField = EXPECTED_FIELDS.invoice.find((f) => f.type === "money")!;
    const out = assembleValues("invoice", text, {
      [moneyField.field]: { value: "abc", evidence: "$1,200.00", gap_reason: null },
    });
    const v = out.find((o) => o.fieldName === moneyField.field)!;
    expect(v.gapReason).toBe("value not parseable as money");
    expect(v.value).toBeNull();
    expect(v.evidence).toBe("$1,200.00");
  });
  it("assembles a valid value with offsets", () => {
    const moneyField = EXPECTED_FIELDS.invoice.find((f) => f.type === "money")!;
    const out = assembleValues("invoice", text, {
      [moneyField.field]: {
        value: { amount: "1200.00", currency: "USD" },
        evidence: "$1,200.00",
        gap_reason: null,
      },
    });
    const v = out.find((o) => o.fieldName === moneyField.field)!;
    expect(v.gapReason).toBeNull();
    expect(v.evidenceStart).toBe(15);
    expect(v.evidenceEnd).toBe(24);
    expect(v.value).not.toBeNull();
  });
  it("marks missing fields, ignores extras, keeps length", () => {
    const out = assembleValues("invoice", text, {
      foo: { value: "x", evidence: "x", gap_reason: null },
    });
    expect(out).toHaveLength(EXPECTED_FIELDS.invoice.length);
    expect(out.every((o) => o.gapReason === "field missing from model output")).toBe(true);
    expect(out.map((o) => o.fieldName)).toEqual(EXPECTED_FIELDS.invoice.map((f) => f.field));
  });
});
