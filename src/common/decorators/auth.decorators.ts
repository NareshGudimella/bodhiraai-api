import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Request } from 'express';
import type { users } from '../../db/types';
import { Role } from '../roles';

export const IS_PUBLIC = 'isPublic';
export const ROLES = 'roles';

/** Skip the global bearer-token guard (Laravel: route outside `auth:sanctum`). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Laravel `role:a,b` middleware. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export interface AuthedRequest extends Request {
  user: users;
  tokenId: bigint;
}

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<AuthedRequest>().user,
);

export const CurrentTokenId = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<AuthedRequest>().tokenId,
);
