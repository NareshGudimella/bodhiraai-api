import { HttpException, HttpStatus } from '@nestjs/common';
import { fail } from './api-response';

/** Throw to return a legacy-shaped error: `{ success:false, message, code?, errors? }`. */
export class ApiException extends HttpException {
  constructor(
    message: string,
    status: number = HttpStatus.BAD_REQUEST,
    code?: string,
    errors?: unknown,
  ) {
    super(fail(message, code, errors), status);
  }
}

/** Laravel's ValidationException: 422 with `errors: { field: [messages] }`. */
export class ValidationFailed extends ApiException {
  constructor(errors: Record<string, string[]>) {
    super(
      'The given data was invalid.',
      HttpStatus.UNPROCESSABLE_ENTITY,
      undefined,
      errors,
    );
  }

  static field(field: string, message: string) {
    return new ValidationFailed({ [field]: [message] });
  }
}
