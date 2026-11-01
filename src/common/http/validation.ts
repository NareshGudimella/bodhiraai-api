import { ValidationError, ValidationPipe } from '@nestjs/common';
import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { validate } from 'class-validator';
import { ValidationFailed } from './api.exception';

function collect(
  errors: ValidationError[],
  prefix = '',
  out: Record<string, string[]> = {},
) {
  for (const e of errors) {
    const key = prefix ? `${prefix}.${e.property}` : e.property;
    if (e.constraints) out[key] = Object.values(e.constraints);
    if (e.children?.length) collect(e.children, key, out);
  }
  return out;
}

/** Global pipe: DTO validation failures become Laravel-style 422 responses. */
export const apiValidationPipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  exceptionFactory: (errors) => new ValidationFailed(collect(errors)),
});

/**
 * Validate a body inside the handler. Use it when Laravel would resolve route
 * bindings (404) or ownership checks (403) before validating (422): declare the
 * parameter as `@Body() body: unknown` so the global pipe leaves it alone.
 */
export async function validateBody<T extends object>(
  cls: ClassConstructor<T>,
  body: unknown,
): Promise<T> {
  const instance = plainToInstance(cls, body ?? {});
  const errors = await validate(instance, { whitelist: true });
  if (errors.length) throw new ValidationFailed(collect(errors));
  return instance;
}
