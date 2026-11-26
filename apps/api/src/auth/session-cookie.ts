import { createHash, randomBytes } from "node:crypto";
import type { CookieOptions } from "express";

export const SESSION_COOKIE = "sid";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const newSessionToken = (): string => randomBytes(32).toString("base64url");
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export function sessionCookieOptions(secure: boolean): CookieOptions {
  return { httpOnly: true, sameSite: "lax", path: "/", secure, maxAge: SESSION_TTL_MS };
}
