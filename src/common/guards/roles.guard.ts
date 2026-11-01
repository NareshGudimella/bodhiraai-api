import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthedRequest, ROLES } from '../decorators/auth.decorators';
import { ApiException } from '../http/api.exception';
import { Role } from '../roles';

/** Laravel EnsureRole middleware. Runs after TokenAuthGuard. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!roles?.length) return true;

    const { user } = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!user) throw new ApiException('Unauthenticated', 401);
    if (!roles.includes(user.role as Role)) {
      throw new ApiException(
        'You do not have permission to access this resource.',
        403,
      );
    }
    return true;
  }
}
