import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PdfParseError, extractPdfText } from "../src/pdf.js";

const dir = resolve(import.meta.dirname, "../../../assignment/fixtures/documents");
const load = (n: string) => new Uint8Array(readFileSync(resolve(dir, n)));

describe("extractPdfText", () => {
  it("extracts invoice text", async () => {
    const t = await extractPdfText(load("invoice-001.pdf"));
    expect(t.length).toBeGreaterThan(0);
    expect(t).toMatch(/meridian/i); // text is upper-case: "MERIDIAN OFFICE SUPPLIES LLC"
  });
  it("extracts every fixture", async () => {
    for (const n of ["invoice-001.v2.pdf", "lease-excerpt-001.pdf", "market-report-excerpt-001.pdf"]) {
      expect((await extractPdfText(load(n))).trim().length).toBeGreaterThan(0);
    }
  });
  it("v1 vs v2 invoice differ in due_date and total_amount only", async () => {
    const v1 = await extractPdfText(load("invoice-001.pdf"));
    const v2 = await extractPdfText(load("invoice-001.v2.pdf"));
    const grab = (t: string, label: string) => new RegExp(`${label}: (.+)`).exec(t)?.[1];
    for (const label of ["Invoice Number", "Issue Date"]) expect(grab(v1, label)).toBe(grab(v2, label));
    expect(v1).toContain("MERIDIAN OFFICE SUPPLIES LLC");
    expect(v2).toContain("MERIDIAN OFFICE SUPPLIES LLC");
    expect(grab(v1, "Due Date")).toBe("2025-10-14");
    expect(grab(v2, "Due Date")).toBe("2025-11-13");
    expect(grab(v1, "Total Due")).toBe("$5,230.29");
    expect(grab(v2, "Total Due")).toBe("$6,126.45");
  });
  it("throws PdfParseError on garbage", async () => {
    await expect(extractPdfText(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(PdfParseError);
  });
});
