import { Body, Controller, HttpCode, Inject, Put } from "@nestjs/common";
import { retryFailedRunsForUser, type Db, type User } from "@lomi/db";
import { AuthService } from "../auth/auth.service.js";
import { parseLlmBody } from "../auth/auth.controller.js";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { hasEnvLlm, type ApiConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { RunEnqueuer } from "../queue.js";
import { CONFIG, DATABASE } from "../tokens.js";

@Controller("settings")
export class SettingsController {
  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(DATABASE) private readonly database: { db: Db },
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(RunEnqueuer) private readonly enqueuer: RunEnqueuer,
  ) {}

  /** Local mode only: set the LLM the worker uses, then retry every failed run (e.g. "No LLM configured"). */
  @Put("llm")
  @HttpCode(200)
  async putLlm(@CurrentUser() user: User, @Body() body: unknown): Promise<{ llmConfigured: true; retried: number }> {
    if (this.config.authMode !== "local") throw new ApiError(404, "NOT_FOUND", "Not found");
    if (hasEnvLlm(this.config)) {
      throw new ApiError(409, "ENV_CONFIGURED", "The LLM is configured through the environment (LLM_* in .env) and cannot be changed here");
    }
    const llm = parseLlmBody(body);
    await this.auth.verifyProvider(llm);
    await this.auth.saveLocalConfig(user.id, llm);
    const runIds = await retryFailedRunsForUser(this.database.db, user.id);
    await this.enqueuer.enqueue(runIds);
    return { llmConfigured: true, retried: runIds.length };
  }
}
