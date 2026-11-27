import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXPECTED_FIELDS, type DocumentType } from "@lomi/shared";
import { assembleValues, buildExtractionRequest, extractPdfText, type LlmField } from "@lomi/extraction";
import { createFakeOpenAiServer } from "../src/fake-openai-server.ts";

const DOCS = "../../assignment/fixtures/documents";
const CASES: { file: string; type: DocumentType; gaps: string[] }[] = [
  { file: "invoice-001.pdf", type: "invoice", gaps: [] },
  { file: "invoice-001.v2.pdf", type: "invoice", gaps: [] },
  { file: "lease-excerpt-001.pdf", type: "lease", gaps: [] },
  { file: "market-report-excerpt-001.pdf", type: "market_report", gaps: ["median_household_income"] },
];

let url = "";
const server = createFakeOpenAiServer();
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
});
afterAll(() => new Promise((r) => server.close(r)));

async function complete(body: unknown): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { choices: { message: { content: string } }[] };
  return JSON.parse(json.choices[0]!.message.content);
}

describe("fake OpenAI server", () => {
  for (const c of CASES) {
    it(`answers ${c.file} with evidence that appears verbatim in the PDF text`, async () => {
      const text = await extractPdfText(readFileSync(`${DOCS}/${c.file}`));
      const { system, user, jsonSchema } = buildExtractionRequest(c.type, text);
      const out = (await complete({
        model: "m",
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_schema", json_schema: { name: "extraction", schema: jsonSchema, strict: true } },
      })) as Record<string, LlmField>;
      const values = assembleValues(c.type, text, out);
      const gaps = values.filter((v) => v.value === null).map((v) => v.fieldName);
      expect(gaps).toEqual(c.gaps);
      expect(values).toHaveLength(EXPECTED_FIELDS[c.type].length);
    });
  }

  it("distinguishes invoice v1 from the revised v2", async () => {
    const ask = async (file: string) => {
      const text = await extractPdfText(readFileSync(`${DOCS}/${file}`));
      const { user } = buildExtractionRequest("invoice", text);
      return (await complete({ messages: [{ role: "user", content: user }] })) as Record<string, LlmField>;
    };
    expect((await ask("invoice-001.pdf")).due_date?.value).toBe("2025-10-14");
    expect((await ask("invoice-001.v2.pdf")).due_date?.value).toBe("2025-11-13");
  });

  it("answers the login verification ping", async () => {
    const out = await complete({ messages: [{ role: "user", content: "ping" }], response_format: { type: "json_schema", json_schema: { name: "verify" } } });
    expect(out).toEqual({ ok: true });
  });
});
