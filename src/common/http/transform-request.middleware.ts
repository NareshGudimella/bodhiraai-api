import { Injectable, NestMiddleware } from '@nestjs/common';
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
