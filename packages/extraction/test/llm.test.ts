import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LlmError, createOpenAiCompatibleClient, verifyProvider } from "../src/llm.js";
import { FakeLlmClient } from "../src/testing.js";

let server: Server;
let baseUrl = "";
let status = 200;
let content = '{"a":1}';
type Body = { response_format: { type: string; json_schema: { strict: boolean } }; temperature: number; max_tokens?: number };
let bodies: Body[] = [];

beforeEach(async () => {
  status = 200;
  content = '{"a":1}';
  bodies = [];
  server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      bodies.push(JSON.parse(b) as Body);
      res.writeHead(status, { "content-type": "application/json" });
      if (status !== 200) return res.end(JSON.stringify({ error: { message: "nope" } }));
      res.end(
        JSON.stringify({
          id: "c1",
          object: "chat.completion",
          created: 1,
          model: "m",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

const mk = () => createOpenAiCompatibleClient({ baseUrl, apiKey: "k", model: "m", allowPrivateHosts: true });
const req = { system: "s", user: "u", jsonSchema: { type: "object" }, schemaName: "extraction" };

describe("createOpenAiCompatibleClient", () => {
  it("parses JSON content and sends json_schema response_format", async () => {
    const out = await mk().completeJson(req);
    expect(out.parsed).toEqual({ a: 1 });
    expect((out.raw as { id: string }).id).toBe("c1");
    expect(bodies[0]!.response_format.type).toBe("json_schema");
    expect(bodies[0]!.response_format.json_schema.strict).toBe(true);
    expect(bodies[0]!.temperature).toBe(0);
  });
  it("classifies 503 as transient", async () => {
    status = 503;
    await expect(mk().completeJson(req)).rejects.toMatchObject({ kind: "transient", status: 503 });
  });
  it("classifies 429 as transient", async () => {
    status = 429;
    await expect(mk().completeJson(req)).rejects.toMatchObject({ kind: "transient" });
  });
  it("classifies 401 as permanent", async () => {
    status = 401;
    const e = await mk().completeJson(req).catch((x) => x);
    expect(e).toBeInstanceOf(LlmError);
    expect(e).toMatchObject({ kind: "permanent", status: 401 });
  });
  it("classifies non-JSON content as permanent", async () => {
    content = "not json";
    await expect(mk().completeJson(req)).rejects.toMatchObject({ kind: "permanent" });
  });
  it("classifies connection failure as transient", async () => {
    const c = createOpenAiCompatibleClient({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m", allowPrivateHosts: true });
    await expect(c.completeJson(req)).rejects.toMatchObject({ kind: "transient" });
  });
});

describe("verifyProvider", () => {
  it("resolves on success with small max_tokens", async () => {
    content = '{"ok":true}';
    await expect(verifyProvider({ baseUrl, apiKey: "k", model: "m", allowPrivateHosts: true })).resolves.toBeUndefined();
    expect(bodies[0]!.max_tokens).toBeLessThanOrEqual(50);
  });
  it("throws LlmError on failure", async () => {
    status = 401;
    await expect(verifyProvider({ baseUrl, apiKey: "k", model: "m", allowPrivateHosts: true })).rejects.toBeInstanceOf(LlmError);
  });
});

describe("FakeLlmClient", () => {
  it("records calls and returns handler output", async () => {
    const f = new FakeLlmClient(() => ({ x: 1 }));
    expect((await f.completeJson(req)).parsed).toEqual({ x: 1 });
    expect(f.calls).toHaveLength(1);
  });
});
