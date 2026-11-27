// Fake OpenAI-compatible server for e2e/chaos runs: answers POST {/v1}/chat/completions with recorded
// responses whose evidence quotes appear verbatim in the fixture PDFs. No framework, no dependencies.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

type Message = { role?: string; content?: unknown };
export type CompletionRequest = {
  model?: string;
  messages?: Message[];
  response_format?: { json_schema?: { name?: string } };
};

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));

const RECORDED = {
  "invoice-v1": fixture("invoice-v1"),
  "invoice-v2": fixture("invoice-v2"),
  lease: fixture("lease"),
  market_report: fixture("market_report"),
};

const text = (m: Message | undefined): string => (typeof m?.content === "string" ? m.content : "");

/** Pick the recorded answer from the prompt text; null when the request is not one we know. */
export function answerFor(req: CompletionRequest): unknown {
  if (req.response_format?.json_schema?.name === "verify") return { ok: true };
  const user = text(req.messages?.findLast((m) => m.role === "user"));
  const type = /Document type: (\w+)/.exec(user)?.[1];
  if (type === "invoice") return user.includes("INVOICE (REVISED)") ? RECORDED["invoice-v2"] : RECORDED["invoice-v1"];
  if (type === "lease") return RECORDED.lease;
  if (type === "market_report") return RECORDED.market_report;
  return null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handle(req: IncomingMessage, res: ServerResponse, delayMs: number): Promise<void> {
  const path = (req.url ?? "").split("?")[0] ?? "";
  if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true });
  if (req.method !== "POST" || !/^(\/v1)?\/chat\/completions$/.test(path)) {
    return send(res, 404, { error: { message: "not found" } });
  }
  let body: CompletionRequest;
  try {
    body = JSON.parse(await readBody(req)) as CompletionRequest;
  } catch {
    return send(res, 400, { error: { message: "invalid JSON body" } });
  }
  const answer = answerFor(body);
  if (answer === null) return send(res, 400, { error: { message: "fake-llm: unrecognised request" } });
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  send(res, 200, {
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model ?? "fake-model",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(answer) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

export function createFakeOpenAiServer(opts: { delayMs?: number } = {}): Server {
  const delayMs = opts.delayMs ?? 0;
  return createServer((req, res) => {
    handle(req, res, delayMs).catch(() => {
      if (!res.headersSent) send(res, 500, { error: { message: "fake-llm: internal error" } });
    });
  });
}

// Started directly (`node src/fake-openai-server.ts`), not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 4010);
  const delayMs = Number(process.env.FAKE_LLM_DELAY_MS ?? 0);
  createFakeOpenAiServer({ delayMs }).listen(port, "0.0.0.0", () => {
    console.log(`fake-llm listening on :${port} (delay ${delayMs}ms)`);
  });
}
