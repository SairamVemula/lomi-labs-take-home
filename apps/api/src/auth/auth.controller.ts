import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { LoginRequest } from "@lomi/shared";
import type { User } from "@lomi/db";
import { hasEnvLlm, type ApiConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { CONFIG, USER_RESOLVER } from "../tokens.js";
import { AuthService } from "./auth.service.js";
import { CurrentUser } from "./current-user.decorator.js";
import { Public } from "./public.decorator.js";
import { SESSION_COOKIE, sessionCookieOptions } from "./session-cookie.js";
import type { UserResolver } from "./user-resolver.js";

export const PRESETS = [
  { name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { name: "Anthropic", baseUrl: "https://api.anthropic.com/v1/" },
  { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { name: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
  { name: "Ollama", baseUrl: "http://host.docker.internal:11434/v1", localOnly: true },
] as const;

export function parseLlmBody(body: unknown): LoginRequest {
  const parsed = LoginRequest.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      400,
      "BAD_REQUEST",
      parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
    );
  }
  return parsed.data;
}

const notFound = (): ApiError => new ApiError(404, "NOT_FOUND", "Not found");

@Controller("auth")
export class AuthController {
  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(USER_RESOLVER) private readonly resolver: UserResolver,
  ) {}

  private me(user: User): { mode: string; model: string | null; baseUrl: string | null } {
    return { mode: this.config.authMode, model: user.model, baseUrl: user.baseUrl };
  }

  /** What the UI needs before login: mode, whether an LLM is usable, and endpoint presets. No key material. */
  @Public()
  @Get("config")
  async getConfig(@Req() req: Request): Promise<{
    mode: string;
    llmConfigured: boolean;
    llmSource: "env" | "settings" | null;
    presets: { name: string; baseUrl: string }[];
  }> {
    const local = this.config.authMode === "local";
    const user = await this.resolver.resolve(req);
    const stored = Boolean(user?.baseUrl && user.model && user.encryptedKey);
    const llmSource = local && hasEnvLlm(this.config) ? "env" : stored ? "settings" : null;
    return {
      mode: this.config.authMode,
      llmConfigured: llmSource !== null,
      llmSource,
      presets: PRESETS.filter((p) => local || !("localOnly" in p)).map(({ name, baseUrl }) => ({ name, baseUrl })),
    };
  }

  @Get("me")
  getMe(@CurrentUser() user: User): { mode: string; model: string | null; baseUrl: string | null } {
    return this.me(user);
  }

  @Public()
  @UseGuards(ThrottlerGuard)
  @Post("login")
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ mode: string; model: string | null; baseUrl: string | null }> {
    if (this.config.authMode !== "byok") throw notFound();
    const { token, user } = await this.auth.login(parseLlmBody(body));
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions(this.config.secureCookies));
    return this.me(user);
  }

  @Public()
  @Post("logout")
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ ok: true }> {
    if (this.config.authMode !== "byok") throw notFound();
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    await this.auth.logout(typeof token === "string" ? token : undefined);
    res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(this.config.secureCookies), maxAge: undefined });
    return { ok: true };
  }
}
