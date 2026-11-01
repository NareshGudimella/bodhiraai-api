import { memoryStorage } from 'multer';
import { ValidationFailed } from '../common/http/api.exception';
import { cleanInput } from '../common/http/transform-request.middleware';
import { laravelValidate, type Rules } from '../common/http/laravel-validator';
import type { Db } from '../db/db';
import {
  sniff,
  UploadRejected,
  type IncomingFile,
  type Kind,
} from './upload-rules';

/** Multer options for upload routes. Hard cap only; Laravel-style size rules run in validateWithFile. */
export const uploadOptions = (hardCapMb: number, files = 1) => ({
  storage: memoryStorage(),
  limits: { fileSize: hardCapMb * 1024 * 1024, files },
});

export interface FileRule {
  field: string;
  /** Laravel `image` (jpeg/png/gif/webp) or plain `file`. */
  kind: 'image' | 'file';
  /** Laravel `max:` in kilobytes. */
  maxKb: number;
  /** Laravel `mimes:` extensions, checked against the sniffed type. */
  mimes?: string[];
}

/** Extensions Laravel guesses for each sniffed type (jpg and jpeg go together). */
const EXTENSIONS: Partial<Record<Kind, string[]>> = {
  jpeg: ['jpg', 'jpeg'],
  png: ['png'],
  gif: ['gif'],
  webp: ['webp'],
  bmp: ['bmp'],
  pdf: ['pdf'],
};

/**
 * `$request->validate()` for a multipart request: text rules through
 * laravelValidate plus each file's `image`/`file` + `max` rules, reported
 * together as one 422 like Laravel.
 */
export async function validateWithFiles(
  db: Db,
  body: unknown,
  rules: Rules,
  files: Record<string, IncomingFile | undefined>,
  fileRules: FileRule[],
): Promise<Record<string, unknown>> {
  let data: Record<string, unknown> = {};
  let errors: Record<string, string[]> = {};
  try {
    data = await laravelValidate(db, cleanInput(body), rules);
  } catch (e) {
    if (!(e instanceof ValidationFailed)) throw e;
    errors = (e.getResponse() as { errors: Record<string, string[]> }).errors;
  }
  // Laravel reports fields in rule order; file fields sit among the text rules.
  const order = Object.keys(rules);
  for (const rule of fileRules) {
    const file = files[rule.field];
    if (!file) continue;
    const label = rule.field.replace(/_/g, ' ');
    const msgs: string[] = [];
    const kind = sniff(file.buffer);
    // Laravel's `image` accepts jpg, jpeg, png, gif, bmp and webp.
    if (
      rule.kind === 'image' &&
      !['jpeg', 'png', 'gif', 'webp', 'bmp'].includes(kind)
    ) {
      msgs.push(`The ${label} field must be an image.`);
    }
    if (
      rule.mimes &&
      !(EXTENSIONS[kind] ?? []).some((e) => rule.mimes!.includes(e))
    ) {
      msgs.push(
        `The ${label} field must be a file of type: ${rule.mimes.join(', ')}.`,
      );
    }
    if (file.size > rule.maxKb * 1024) {
      msgs.push(
        `The ${label} field must not be greater than ${rule.maxKb} kilobytes.`,
      );
    }
    if (msgs.length) errors[rule.field] = msgs;
  }
  if (Object.keys(errors).length) {
    // Expanded wildcard keys (`syllabi.0`) come after every other rule, as in Laravel.
    const rank = (k: string) => {
      const i = order.indexOf(k);
      return i < 0 ? order.length : i;
    };
    throw new ValidationFailed(
      Object.fromEntries(
        Object.entries(errors).sort(([a], [b]) => rank(a) - rank(b)),
      ),
    );
  }
  return data;
}

/** Single-file form of validateWithFiles. */
export function validateWithFile(
  db: Db,
  body: unknown,
  rules: Rules,
  file: IncomingFile | undefined,
  fileRule: FileRule,
): Promise<Record<string, unknown>> {
  return validateWithFiles(db, body, rules, { [fileRule.field]: file }, [
    fileRule,
  ]);
}

/** Run a storage call, turning upload-rule rejections into a field error (422). */
export async function storeOrReject<T>(
  field: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof UploadRejected)
      throw new ValidationFailed({ [field]: [e.message] });
    throw e;
  }
}
