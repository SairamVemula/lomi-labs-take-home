import { Inject, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { touchSession, type Db, type User } from "@lomi/db";
import type { ApiConfig } from "../config.js";
import { CONFIG, DATABASE } from "../tokens.js";
import { SESSION_COOKIE, SESSION_TTL_MS, hashToken, sessionCookieOptions } from "./session-cookie.js";
import type { UserResolver } from "./user-resolver.js";

/** AUTH_MODE=byok: the `sid` cookie names a session; each use slides its 7-day expiry. */
@Injectable()
export class SessionUserResolver implements UserResolver {
  constructor(
    @Inject(DATABASE) private readonly database: { db: Db },
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  async resolve(req: Request): Promise<User | null> {
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== "string" || token.length === 0 || token.length > 128) return null;
    const user = await touchSession(this.database.db, hashToken(token), new Date(Date.now() + SESSION_TTL_MS));
    // Keep the browser cookie as long-lived as the server-side session.
    if (user) req.res?.cookie(SESSION_COOKIE, token, sessionCookieOptions(this.config.secureCookies));
    return user;
  }
}
