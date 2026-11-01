import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Response } from 'express';
import { fail } from '../http/api-response';

/** Renders every error in the legacy envelope (see bootstrap/app.php in the Laravel app). */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  constructor(private readonly debug: boolean) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof ThrottlerException) {
      res.status(429).json(fail('Too Many Attempts.'));
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null && 'success' in body) {
        res.status(status).json(body);
        return;
      }
      const message =
        typeof body === 'string'
          ? body
          : ((body as { message?: string | string[] }).message ??
            exception.message);
      res
        .status(status)
        .json(
          fail(
            Array.isArray(message)
              ? message.join(' ')
              : message || 'HTTP error',
          ),
        );
      return;
    }

    this.logger.error(exception);
    const message =
      this.debug && exception instanceof Error
        ? exception.message
        : 'Server error';
    res.status(500).json(fail(message));
  }
}
