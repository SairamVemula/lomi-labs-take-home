import type { LlmClient, LlmRequest } from "./llm.js";

export class FakeLlmClient implements LlmClient {
  calls: LlmRequest[] = [];
  constructor(private handler: (req: LlmRequest) => unknown | Promise<unknown>) {}
  async completeJson(req: LlmRequest): Promise<{ parsed: unknown; raw: unknown }> {
    this.calls.push(req);
    const parsed = await this.handler(req);
    return { parsed, raw: { fake: true, parsed } };
  }
}
