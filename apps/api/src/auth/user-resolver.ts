import type { Request } from "express";
import type { User } from "@lomi/db";

/** Request-scoped identity. Controllers never know which auth mode is active; they only see `req.user`. */
export interface UserResolver {
  resolve(req: Request): Promise<User | null>;
}

export type AuthedRequest = Request & { user: User };
