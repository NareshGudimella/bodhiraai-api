import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TokenService } from '../../auth/token.service';
import { AuthedRequest, IS_PUBLIC } from '../decorators/auth.decorators';
import { ApiException } from '../http/api.exception';

/** Global guard: requires a valid Sanctum-format bearer token unless the route is @Public(). */
@Injectable()
export class TokenAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization ?? '';
    const plain = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        ctx.getHandler(),
        ctx.getClass(),
      ])
    ) {
      // Public routes still know a signed-in caller (like auth()->user() on a
      // legacy public page), but never reject one.
      const optional = plain ? await this.tokens.resolve(plain) : null;
      if (optional) {
        req.user = optional.user;
        req.tokenId = optional.tokenId;
      }
      return true;
    }

    const resolved = plain ? await this.tokens.resolve(plain) : null;
    if (!resolved) throw new ApiException('Unauthenticated.', 401);

    req.user = resolved.user;
    req.tokenId = resolved.tokenId;
    return true;
  }
}
