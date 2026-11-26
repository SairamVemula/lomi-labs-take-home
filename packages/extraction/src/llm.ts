import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError } from "openai";
import { SsrfBlockedError, createSafeFetch } from "./safe-fetch.js";

export type LlmRequest = { system: string; user: string; jsonSchema: object; schemaName: string };

export interface LlmClient {
  completeJson(req: LlmRequest): Promise<{ parsed: unknown; raw: unknown }>;
}

export class LlmError extends Error {
  constructor(
    public kind: "transient" | "permanent",
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export type ClientOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  allowPrivateHosts: boolean;
  timeoutMs?: number;
};

function classify(e: unknown): LlmError {
  if (e instanceof LlmError) return e;
  for (let c: unknown = e, i = 0; c && i < 8; i++, c = (c as { cause?: unknown }).cause) {
    if (c instanceof SsrfBlockedError) return new LlmError("permanent", c.reason);
  }
  if (e instanceof APIConnectionTimeoutError || e instanceof APIConnectionError) {
    return new LlmError("transient", e.message);
  }
  if (e instanceof APIError) {
    const s = e.status;
    const transient = s === 408 || s === 429 || (typeof s === "number" && s >= 500);
    return new LlmError(transient ? "transient" : "permanent", e.message, s);
  }
  return new LlmError("transient", e instanceof Error ? e.message : String(e));
}

async function complete(
  opts: ClientOptions,
  req: LlmRequest,
): Promise<{ parsed: unknown; raw: unknown }> {
  const sdk = new OpenAI({
    baseURL: opts.baseUrl,
    apiKey: opts.apiKey,
    fetch: createSafeFetch({ allowPrivateHosts: opts.allowPrivateHosts }) as never,
    maxRetries: 0,
    timeout: opts.timeoutMs ?? 60000,
  });
  let raw;
  try {
    raw = await sdk.chat.completions.create({
      model: opts.model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: req.schemaName, schema: req.jsonSchema as Record<string, unknown>, strict: true },
      },
    });
  } catch (e) {
    throw classify(e);
  }
  const content = raw.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new LlmError("permanent", "model returned no message content");
  try {
    return { parsed: JSON.parse(content), raw };
  } catch {
    throw new LlmError("permanent", "model returned invalid JSON");
  }
}

export function createOpenAiCompatibleClient(opts: ClientOptions): LlmClient {
  return { completeJson: (req) => complete(opts, req) };
}

export async function verifyProvider(opts: ClientOptions): Promise<void> {
  await complete(
    opts,
    {
      system: 'Reply with JSON {"ok": true}.',
      user: "ping",
      schemaName: "verify",
      jsonSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
  );
}
