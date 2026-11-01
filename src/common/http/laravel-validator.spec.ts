import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Db } from '../../db/db';
import { laravelValidate } from './laravel-validator';

/** Fake database: ids 1–5 exist in every table. */
const dialect = new PgDialect();
const db = {
  execute: (query: SQL) => {
    const { params } = dialect.sqlToQuery(query);
    const id = Number(params[0]);
    return Promise.resolve({
      rows: id >= 1 && id <= 5 ? [{ '?column?': 1 }] : [],
    });
  },
} as unknown as Db;

const errorsOf = async (body: unknown, rules: Record<string, string[]>) => {
  try {
    await laravelValidate(db, body, rules);
    return null;
  } catch (e) {
    return (
      e as { getResponse(): { errors: Record<string, string[]> } }
    ).getResponse().errors;
  }
};

describe('laravelValidate', () => {
  it('stops a field after a failed required rule (Laravel implicit rules)', async () => {
    expect(
      await errorsOf({}, { title: ['required', 'string', 'max:5'] }),
    ).toEqual({
      title: ['The title field is required.'],
    });
  });

  // Laravel getSize(): a non-numeric value falls back to its length (1 < 5); the
  // message stays numeric-style because the field has an integer rule.
  it('runs every other failing rule, in order', async () => {
    expect(
      await errorsOf(
        { max_marks: 'x' },
        { max_marks: ['required', 'integer', 'min:5', 'max:1000'] },
      ),
    ).toEqual({
      max_marks: [
        'The max marks field must be an integer.',
        'The max marks field must be at least 5.',
      ],
    });
  });

  it('skips nullable fields that are null, but not non-nullable ones', async () => {
    expect(
      await errorsOf(
        { a: null, b: null },
        { a: ['nullable', 'string'], b: ['string'] },
      ),
    ).toEqual({
      b: ['The b field must be a string.'],
    });
  });

  it('compares numbers for integer fields and characters otherwise', async () => {
    expect(
      await errorsOf(
        { n: '2000', s: 'abcdef' },
        { n: ['integer', 'max:1000'], s: ['string', 'max:5'] },
      ),
    ).toEqual({
      n: ['The n field must not be greater than 1000.'],
      s: ['The s field must not be greater than 5 characters.'],
    });
  });

  it('validates wildcard array items and returns present keys only', async () => {
    expect(
      await errorsOf(
        { records: { '4': 'present', '9': 'sleeping' } },
        { 'records.*': ['required', 'in:present,absent'] },
      ),
    ).toEqual({ 'records.9': ['The selected records.9 is invalid.'] });
    const ok = await laravelValidate(
      db,
      { class_id: 3, title: 'T', extra: 1 },
      {
        class_id: ['required', 'exists:classes,id'],
        title: ['required'],
        subject_id: ['nullable', 'exists:subjects,id'],
      },
    );
    expect(ok).toEqual({ class_id: 3, title: 'T' });
  });

  it('checks exists, url, date and required_if', async () => {
    expect(
      await errorsOf(
        { class_id: 9, link: 'nope', due: '2026-02-30', scope: 'class' },
        {
          class_id: ['exists:classes,id'],
          link: ['url'],
          due: ['date'],
          target: ['nullable', 'required_if:scope,class'],
        },
      ),
    ).toEqual({
      class_id: ['The selected class id is invalid.'],
      link: ['The link field must be a valid URL.'],
      due: ['The due field must be a valid date.'],
      target: ['The target field is required when scope is class.'],
    });
  });
});
