import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { User } from "@lomi/db";
import type { AuthedRequest } from "./user-resolver.js";

/** The authenticated user set by the global AuthGuard. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): User => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().user;
});
