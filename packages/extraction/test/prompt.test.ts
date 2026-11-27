import { describe, expect, it } from "vitest";
import { EXPECTED_FIELDS } from "@lomi/shared";
import { buildExtractionRequest } from "../src/prompt.js";

describe("buildExtractionRequest", () => {
  it("requires exactly the invoice fields, strict", () => {
    const { jsonSchema, system, user } = buildExtractionRequest("invoice", "Invoice text");
    const s = jsonSchema as { required: string[]; additionalProperties: boolean; properties: Record<string, { additionalProperties: boolean; required: string[] }> };
    expect(s.required).toEqual(EXPECTED_FIELDS.invoice.map((f) => f.field));
    expect(s.required).toHaveLength(5);
    expect(s.additionalProperties).toBe(false);
    for (const p of Object.values(s.properties)) {
      expect(p.additionalProperties).toBe(false);
      expect(p.required).toEqual(["value", "evidence", "gap_reason"]);
    }
    expect(system).toMatch(/verbatim/i);
    expect(user).toContain("Invoice text");
  });

  it("uses type-appropriate value schemas", () => {
    const s = buildExtractionRequest("invoice", "x").jsonSchema as { properties: Record<string, { properties: { value: { anyOf?: unknown[]; type?: string[] } } }> };
    expect(s.properties.total_amount!.properties.value.anyOf).toHaveLength(2);
    expect(s.properties.issue_date!.properties.value.type).toEqual(["string", "null"]);
  });

  it("tells the model that mapping a currency symbol to its code is normalisation, not guessing", () => {
    const { system, jsonSchema } = buildExtractionRequest("invoice", "x");
    // A real local model returned null for "Total Due: $6,126.45" because "$ -> USD" read as inference.
    expect(system).toMatch(/\$.*USD/);
    expect(system).toMatch(/not (a )?guess/i);
    expect(system).toContain('{"amount":"6126.45","currency":"USD"}');
    const money = (jsonSchema as { properties: Record<string, { properties: { value: { anyOf: { properties?: { currency?: { description: string } } }[] } } }> })
      .properties.total_amount!.properties.value.anyOf[0]!.properties!.currency!.description;
    expect(money).toMatch(/\$.*USD/);
  });
});
