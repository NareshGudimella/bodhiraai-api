import { Injectable, NestMiddleware } from '@nestjs/common';
import { ValidationFailed } from './api.exception';
import type { NextFunction, Request, Response } from 'express';

/** TrimStrings::$except — matched against the dotted key, like Laravel. */
const NEVER_TRIM = new Set([
  'current_password',
  'password',
  'password_confirmation',
]);

/** Str::trim(): whitespace plus BOM (U+FEFF), zero-width space (U+200B) and LRM (U+200E). */
const EXTRA = String.fromCharCode(0xfeff, 0x200b, 0x200e);
const TRIM = new RegExp(String.raw`^[\s${EXTRA}]+|[\s${EXTRA}]+$`, 'gu');

function clean(value: unknown, key: string): unknown {
  if (Array.isArray(value)) return value.map((v, i) => clean(v, `${key}.${i}`));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        clean(v, key ? `${key}.${k}` : k),
      ]),
    );
  }
  if (typeof value !== 'string') return value;
  const trimmed = NEVER_TRIM.has(key) ? value : value.replace(TRIM, '');
  return trimmed === '' ? null : trimmed;
}

/**
 * security: not in legacy: no query-string value may exceed QUERY_MAX characters
 * (QUERY_MAX_BY_KEY: signed tokens and paths), nor an array more than 50 items.
 */
export const QUERY_MAX = 200;
const QUERY_MAX_BY_KEY: Record<string, number> = { t: 1000, path: 500 };

function capQuery(
  query: unknown,
  key = '',
  errors: Record<string, string[]> = {},
) {
  if (typeof query === 'string') {
    const max = QUERY_MAX_BY_KEY[key.split('.').pop() ?? ''] ?? QUERY_MAX;
    if ([...query].length > max)
      errors[key] = [
        `The ${key.replace(/_/g, ' ')} field must not be greater than ${max} characters.`,
      ];
  } else if (query && typeof query === 'object') {
    const entries = Object.entries(query);
    if (Array.isArray(query) && entries.length > 50)
      errors[key] = [
        `The ${key.replace(/_/g, ' ')} field must not have more than 50 items.`,
      ];
    else
      for (const [k, v] of entries.slice(0, 50))
        capQuery(v, key ? `${key}.${k}` : k, errors);
  }
  if (!key && Object.keys(errors).length) throw new ValidationFailed(errors);
}

/**
 * Laravel's default TrimStrings + ConvertEmptyStringsToNull middleware: every
 * input string is trimmed (passwords excepted) and '' becomes null before
 * validation, for the JSON body and the query string.
 */
@Injectable()
export class TransformRequestMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    // Webhook bodies stay raw bytes: their signatures cover the exact payload.
    if (
      req.body &&
      typeof req.body === 'object' &&
      !Buffer.isBuffer(req.body)
    ) {
      req.body = clean(req.body, '');
    }
    const query = clean({ ...req.query }, '') as Request['query'];
    capQuery(query);
    Object.defineProperty(req, 'query', { value: query, writable: true });
    next();
  }
}

/**
 * The same cleaning for bodies parsed after middleware runs (multipart forms are
 * parsed by Multer inside the route's interceptor).
 */
export function cleanInput(body: unknown): unknown {
  return body && typeof body === 'object' ? clean(body, '') : body;
}
