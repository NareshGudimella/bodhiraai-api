import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC } from '../decorators/auth.decorators';
import { RouteBindingGuard } from './route-binding.guard';

class Ctl {}

function run(isPublic: boolean, params: Record<string, string>) {
  const handler = () => undefined; // fresh per run: metadata sits on the function
  const select = jest.fn(() => {
    throw new Error('lookup');
  });
  const reflector = new Reflector();
  if (isPublic) Reflect.defineMetadata(IS_PUBLIC, true, handler);
  const guard = new RouteBindingGuard({ select } as never, reflector);
  const req = { params, route: { path: '/x/:lesson' } };
  const ctx = {
    getHandler: () => handler,
    getClass: () => Ctl,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { result: guard.canActivate(ctx), select, params };
}

describe('RouteBindingGuard (not in legacy)', () => {
  it('does no lookup on a @Public() route', async () => {
    const { result, select, params } = run(true, { lesson: 'intro-to-maths' });
    await expect(result).resolves.toBe(true);
    expect(select).not.toHaveBeenCalled();
    expect(params.lesson).toBe('intro-to-maths');
  });

  it('still looks slugs up on other routes, and leaves numeric ids alone', async () => {
    await expect(
      run(false, { lesson: 'intro-to-maths' }).result,
    ).rejects.toThrow('lookup');
    const numeric = run(false, { lesson: '42' });
    await expect(numeric.result).resolves.toBe(true);
    expect(numeric.select).not.toHaveBeenCalled();
  });
});
