import { EXPECTED_FIELDS } from "@lomi/shared";
import type { DocumentType, FieldType } from "@lomi/shared";

function valueSchema(type: FieldType): object {
  switch (type) {
    case "string":
      return { type: ["string", "null"] };
    case "date":
      return { type: ["string", "null"], description: "ISO 8601 date YYYY-MM-DD" };
    case "money":
      return {
        anyOf: [
          {
            type: "object",
            properties: {
              amount: { type: "string", description: "Decimal number, no currency symbols or thousands separators" },
              currency: { type: "string", description: "ISO 4217 currency code" },
            },
            required: ["amount", "currency"],
            additionalProperties: false,
          },
          { type: "null" },
        ],
      };
    case "percent":
      return { type: ["number", "null"], description: "Percentage as written: 4.2 means 4.2%" };
    case "number":
      return { type: ["number", "null"] };
  }
}

const SYSTEM = `You extract structured fields from the text of a business document.

Rules:
- For every field return "value", "evidence" and "gap_reason".
- "evidence" must be a verbatim quote copied exactly, character for character, from the document text that supports the value. Do not paraphrase, reformat, or fix typos.
- Copy values exactly as the document states them; only normalise to the requested format (dates as YYYY-MM-DD, money as a decimal string plus ISO 4217 currency, percentages as numbers).
- If a field is absent or you are not certain, set "value" to null, "evidence" to null, and explain briefly in "gap_reason". Never guess or infer values that are not in the text.
- When a value is present, "gap_reason" must be null.
- Respond only with JSON matching the schema.`;

export function buildExtractionRequest(
  docType: DocumentType,
  parsedText: string,
): { system: string; user: string; jsonSchema: object } {
  const fields = EXPECTED_FIELDS[docType];
  const properties: Record<string, object> = {};
  for (const { field, type } of fields) {
    properties[field] = {
      type: "object",
      properties: {
        value: valueSchema(type),
        evidence: { type: ["string", "null"], description: "Verbatim quote from the document supporting the value" },
        gap_reason: { type: ["string", "null"], description: "Why the value is null; null when a value is present" },
      },
      required: ["value", "evidence", "gap_reason"],
      additionalProperties: false,
    };
  }
  const jsonSchema = {
    type: "object",
    properties,
    required: fields.map((f) => f.field),
    additionalProperties: false,
  };
  const list = fields.map((f) => `- ${f.field} (${f.type})`).join("\n");
  const user = `Document type: ${docType}\nFields to extract:\n${list}\n\nDocument text:\n"""\n${parsedText}\n"""`;
  return { system: SYSTEM, user, jsonSchema };
}
