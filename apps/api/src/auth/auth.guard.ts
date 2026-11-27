import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ApiError } from "../errors.js";
import { USER_RESOLVER } from "../tokens.js";
import { IS_PUBLIC } from "./public.decorator.js";
import type { AuthedRequest, UserResolver } from "./user-resolver.js";

/** Global guard: every route needs a resolved user unless marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(USER_RESOLVER) private readonly resolver: UserResolver,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const user = await this.resolver.resolve(req);
    if (!user) throw new ApiError(401, "UNAUTHENTICATED", "Sign in required");
    req.user = user;
    return true;
  }
}
