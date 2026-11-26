import { describe, expect, it } from "vitest";
import { pdfStorageKey, sha256Hex } from "../src/index.js";

const H = "AB12CD34";
const h = "ab12cd34";

describe("pdfStorageKey", () => {
  it("slugifies and lowercases hash", () => {
    expect(pdfStorageKey("Invoice 001 (Rev).PDF", H)).toBe(`pdfs/invoice-001-rev-${h}.pdf`);
  });
  it("drops path traversal", () => {
    expect(pdfStorageKey("../../etc/passwd.pdf", H)).toBe(`pdfs/etc-passwd-${h}.pdf`);
  });
  it("falls back to document", () => {
    expect(pdfStorageKey(".pdf", H)).toBe(`pdfs/document-${h}.pdf`);
  });
  it("caps slug length at 80", () => {
    const key = pdfStorageKey("a".repeat(200) + ".pdf", H);
    const slug = key.slice("pdfs/".length, key.length - `-${h}.pdf`.length);
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.length).toBeGreaterThan(0);
  });
  it("normalizes non-ASCII", () => {
    expect(pdfStorageKey("Factura Nº 7.pdf", H)).toBe(`pdfs/factura-n-7-${h}.pdf`);
  });
});

describe("sha256Hex", () => {
  it("returns lowercase hex", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
