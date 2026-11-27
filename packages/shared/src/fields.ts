import expectedFields from "./expected-fields.json" with { type: "json" };

export type FieldType = "string" | "date" | "money" | "percent" | "number";
export type DocumentType = "invoice" | "lease" | "market_report";

export const DOCUMENT_TYPES: readonly DocumentType[] = ["invoice", "lease", "market_report"];

export type ExpectedField = { field: string; type: FieldType };

/** Copied from assignment/fixtures/expected-fields.json by scripts/copy-fixtures.mjs. */
export const EXPECTED_FIELDS = expectedFields as Record<DocumentType, ExpectedField[]>;

export type Money = { amount: string; currency: string };
export type FieldValue = string | number | Money;
