import { customType } from 'drizzle-orm/pg-core';

/**
 * PostgreSQL `citext` (extension): text that compares case-insensitively, as
 * the legacy columns did.
 */
export const citext = customType<{ data: string }>({
  dataType: () => 'citext',
});
