import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/db';
import { ValidationFailed } from './api.exception';
import { parseLaravelDate } from './laravel';

/**
 * A small port of Laravel's validator for the rules this API uses, with the
 * same semantics and default English messages:
 *  - `required` / `required_if` / `required_without` are implicit; when one fails, the field's
 *    other rules are skipped (Validator::shouldStopValidating). `accepted` is
 *    implicit too: it also fails when the field is missing.
 *  - Other rules run only when the key is present, and are skipped for a null
 *    value when the field is `nullable`.
 *  - `min` / `max` compare numbers for `integer` fields, item counts for
 *    `array` fields, and characters otherwise.
 *  - `field.*` applies rules to each element of an array.
 * Returns the validated data (present keys only), like `$request->validate()`.
 */

export type Rules = Record<string, string[]>;
type Body = Record<string, unknown>;

const label = (field: string) => field.replace(/_/g, ' ');
const isInt = (v: unknown) =>
  (typeof v === 'number' && Number.isInteger(v)) ||
  (typeof v === 'string' && /^[+-]?\d+$/.test(v));
const scalar = (v: unknown) =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
    ? String(v)
    : '';

function isUrl(v: unknown) {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return /^(https?|ftp|ftps|sftp|wss?):$/.test(u.protocol) && !!u.hostname;
  } catch {
    return false;
  }
}

const MAX_BIGINT = 9223372036854775807n;

/**
 * Whether a row matches. Legacy compared mismatched types leniently ('abc' = 0);
 * PostgreSQL rejects the comparison instead (invalid input, out of range), which
 * here means no match.
 */
async function rowExists(db: Db, table: string, where: SQL) {
  try {
    const { rows } = await db.execute(
      sql`select 1 from ${sql.identifier(table)} where ${where} limit 1`,
    );
    return rows.length > 0;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === '22P02' || code === '22003' || code === '22007') return false;
    throw e;
  }
}

/** exists:table[,column] (column defaults to id). */
async function exists(db: Db, arg: string, v: unknown) {
  const [table, column = 'id'] = arg.split(',');
  if (column !== 'id') {
    if (v === undefined || (v !== null && typeof v === 'object')) return false;
    return rowExists(db, table, sql`${sql.identifier(column)} = ${scalar(v)}`);
  }
  if (!isInt(v) || BigInt(scalar(v)) > MAX_BIGINT) return false;
  return rowExists(db, table, sql`"id" = ${scalar(v)}`);
}

export async function laravelValidate(
  db: Db,
  body: unknown,
  rules: Rules,
): Promise<Body> {
  const data = (body && typeof body === 'object' ? body : {}) as Body;
  const errors: Record<string, string[]> = {};
  const validated: Body = {};

  // Expand `field.*` into one entry per array element. Like Laravel's
  // ValidationRuleParser, the expanded keys go after every other rule, so
  // their errors come last.
  const expanded: [string, string[], unknown, boolean][] = [];
  const wildcards: typeof expanded = [];
  for (const [field, list] of Object.entries(rules)) {
    if (field.endsWith('.*')) {
      const parent = data[field.slice(0, -2)];
      if (parent && typeof parent === 'object') {
        for (const [k, v] of Object.entries(parent)) {
          wildcards.push([`${field.slice(0, -2)}.${k}`, list, v, true]);
        }
      }
    } else {
      expanded.push([field, list, data[field], field in data]);
    }
  }
  expanded.push(...wildcards);

  for (const [field, list, value, present] of expanded) {
    const fail = (msg: string) => (errors[field] ??= []).push(msg);
    const nullable = list.includes('nullable');
    const numeric = list.includes('integer');
    const isArray = list.includes('array');
    const missing = value === null || value === undefined;

    for (const rule of list) {
      const [name, arg = ''] = rule.split(/:(.*)/s);
      if (name === 'nullable') continue;

      if (name === 'required') {
        const empty =
          missing ||
          (typeof value === 'string' && value.trim() === '') ||
          (Array.isArray(value) && !value.length) ||
          (typeof value === 'object' &&
            value !== null &&
            !Object.keys(value).length);
        if (empty) {
          fail(`The ${label(field)} field is required.`);
          break;
        }
        continue;
      }
      if (name === 'required_if') {
        const [other, expected] = arg.split(',');
        if (scalar(data[other]) === expected && missing) {
          fail(
            `The ${label(field)} field is required when ${label(other)} is ${expected}.`,
          );
          break;
        }
        continue;
      }

      if (name === 'required_without') {
        const others = arg.split(',');
        const blank = (v: unknown) =>
          v === null ||
          v === undefined ||
          (typeof v === 'string' && v.trim() === '');
        if (blank(value) && others.some((o) => blank(data[o]))) {
          fail(
            `The ${label(field)} field is required when ${others.map(label).join(' / ')} is not present.`,
          );
          break;
        }
        continue;
      }

      if (name === 'accepted') {
        if (!['yes', 'on', '1', 1, true, 'true'].includes(value as never)) {
          fail(`The ${label(field)} field must be accepted.`);
        }
        continue;
      }

      if (!present || (nullable && missing)) continue;

      const size =
        numeric && isInt(value)
          ? Number(value)
          : isArray && value && typeof value === 'object'
            ? Object.keys(value).length
            : [...scalar(value)].length;
      const unit = numeric ? '' : isArray ? ' items' : ' characters';

      switch (name) {
        case 'string':
          if (typeof value !== 'string')
            fail(`The ${label(field)} field must be a string.`);
          break;
        case 'integer':
          if (!isInt(value))
            fail(`The ${label(field)} field must be an integer.`);
          break;
        case 'array':
          if (!value || typeof value !== 'object')
            fail(`The ${label(field)} field must be an array.`);
          break;
        case 'min':
          if (size < Number(arg)) {
            fail(
              isArray
                ? `The ${label(field)} field must have at least ${arg}${unit}.`
                : `The ${label(field)} field must be at least ${arg}${unit}.`,
            );
          }
          break;
        case 'max':
          if (size > Number(arg)) {
            fail(
              isArray
                ? `The ${label(field)} field must not have more than ${arg}${unit}.`
                : `The ${label(field)} field must not be greater than ${arg}${unit}.`,
            );
          }
          break;
        case 'in':
          if (!arg.split(',').includes(scalar(value)))
            fail(`The selected ${label(field)} is invalid.`);
          break;
        case 'url':
          if (!isUrl(value))
            fail(`The ${label(field)} field must be a valid URL.`);
          break;
        case 'date':
          if (typeof value !== 'string' || !parseLaravelDate(value)) {
            fail(`The ${label(field)} field must be a valid date.`);
          }
          break;
        case 'exists':
          if (!(await exists(db, arg, value)))
            fail(`The selected ${label(field)} is invalid.`);
          break;
        case 'email':
          // filter_var(FILTER_VALIDATE_EMAIL)-style check (Laravel's default RFC validation is looser).
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(scalar(value))) {
            fail(`The ${label(field)} field must be a valid email address.`);
          }
          break;
        case 'before': {
          // Only `before:today` is used: the date must be earlier than today (UTC).
          const parsed =
            typeof value === 'string' ? parseLaravelDate(value) : null;
          const today = new Date(
            `${new Date().toISOString().slice(0, 10)}T00:00:00Z`,
          );
          if (!parsed || parsed.instant >= today) {
            fail(`The ${label(field)} field must be a date before ${arg}.`);
          }
          break;
        }
        case 'confirmed':
          if (value !== data[`${field}_confirmation`]) {
            fail(`The ${label(field)} field confirmation does not match.`);
          }
          break;
        case 'different':
          if (value === data[arg]) {
            fail(
              `The ${label(field)} field and ${label(arg)} must be different.`,
            );
          }
          break;
        case 'unique': {
          // unique:table,column[,ignoreId[,idColumn[,whereColumn,whereValue…]]]
          // (Rule::unique(...)->ignore($id)->where(...)); 'NULL' skips the ignore.
          const [table, column = field, ignore, idCol = 'id', ...wheres] =
            arg.split(',');
          const conditions = [
            sql`${sql.identifier(column)} = ${scalar(value)}`,
          ];
          for (let w = 0; w + 1 < wheres.length; w += 2) {
            const col = sql.identifier(wheres[w]);
            conditions.push(
              wheres[w + 1] === 'NULL'
                ? sql`${col} is null`
                : sql`${col} = ${wheres[w + 1]}`,
            );
          }
          if (ignore && ignore !== 'NULL') {
            conditions.push(sql`${sql.identifier(idCol)} <> ${ignore}`);
          }
          const taken = await rowExists(
            db,
            table,
            sql.join(conditions, sql` and `),
          );
          if (taken) fail(`The ${label(field)} has already been taken.`);
          break;
        }
        case 'regex': {
          // PHP pattern with delimiters, e.g. /^[a-z]+$/i
          const m = /^(.)(.*)\1([a-z]*)$/s.exec(arg);
          const re = m ? new RegExp(m[2], m[3].replace(/[^imsu]/g, '')) : null;
          if (!re || !re.test(scalar(value))) {
            fail(`The ${label(field)} field format is invalid.`);
          }
          break;
        }
        case 'boolean':
          if (![true, false, 0, 1, '0', '1'].includes(value as never)) {
            fail(`The ${label(field)} field must be true or false.`);
          }
          break;
        default:
          throw new Error(`laravelValidate: unsupported rule "${name}"`);
      }
    }

    if (present && !field.includes('.')) validated[field] = value;
  }

  // Wildcard parents (`records`) are returned whole, like Laravel.
  for (const field of Object.keys(rules)) {
    if (field.endsWith('.*')) {
      const parent = field.slice(0, -2);
      if (parent in data) validated[parent] = data[parent];
    }
  }

  if (Object.keys(errors).length) throw new ValidationFailed(errors);
  return validated;
}
