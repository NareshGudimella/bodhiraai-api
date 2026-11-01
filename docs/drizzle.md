# Database access: Drizzle on PostgreSQL

The API's database is PostgreSQL, accessed with Drizzle ORM (`drizzle-orm` 0.45, node-postgres). The schema was generated from the legacy schema and keeps its table, column and relation names.

| File | Purpose |
|---|---|
| `src/db/schema.ts` | Tables and relations. Edit it, then `npm run db:generate` (writes `drizzle/NNNN_*.sql`) and `npm run db:migrate` |
| `src/db/types.ts` | Row types named like the tables: `import type { users } from '../db/types'` |
| `src/db/db.ts` | `DB` injection token, `Db` type, `createDb()` |
| `src/db/helpers.ts` | Legacy-compatible helpers (below) |

## Behaviour this port must keep

Legacy's database behaved differently from PostgreSQL. These differences change results silently, so follow these rules:

- **Case-insensitive text.** VARCHAR/CHAR columns are `citext`, so `=`, `IN`, unique indexes and ORDER BY ignore case, as legacy's collation did. TEXT columns (bodies, JSON-ish `meta`/`data`) are plain `text`. For "contains" and "starts with" searches, use `containsCi()`/`startsWithCi()` (ILIKE), never `like()`.
- **NULL ordering.** Legacy sorted NULLs first ascending and last descending; PostgreSQL does the opposite. Use `myAsc(col)`/`myDesc(col)` for nullable columns. `asc()`/`desc()` are fine for NOT NULL columns.
- **Row order and ties.** Legacy returned rows in primary-key order when there was no ORDER BY, and broke ties of an ORDER BY in id order too; PostgreSQL does neither. End every ordering with `asc(t.id)` unless it already ends on a unique column (`findFirst` included; with no ORDER BY, order by `asc(t.id)`). Leave it off grouped queries.
- **AVG/SUM.** Use `myAvg(col)` (rounded to 4 decimals like legacy) and `mySum(col)`. `count()`/`$count()` return numbers (int8 is parsed as a number in `db.ts`).
- **Types.** BIGINT ids are `bigint` (as with Prisma); UNSIGNED INT columns are `bigint({ mode: 'number' })` (numbers); DATE/TIMESTAMP are `Date` in UTC; booleans are booleans.
- **Comparison errors.** PostgreSQL rejects comparisons legacy coerced (`'abc' = id`). Validate or `routeId()` before querying.

## Mapping from Prisma

Inject the client: `constructor(@Inject(DB) private readonly db: Db) {}` (`DB`, `Db` from `../db/db`; tables from `../db/schema`; when a table name clashes with a row type, import the table as `users as usersTable`).

| Prisma | Drizzle |
|---|---|
| `findUnique` / `findFirst({ where, include, select, orderBy })` | `db.query.t.findFirst({ where, with, columns, orderBy })`. Returns `undefined`, not `null`: add `?? null` where null matters |
| `findMany({ where, skip, take, orderBy })` | `db.query.t.findMany({ where, offset, limit, orderBy })` |
| `include: { rel: true }` / `select: { a: true, rel: { select } }` | `with: { rel: true }` / `columns: { a: true }, with: { rel: { columns } }` (same relation names) |
| `_count: { select: { rel: true } }` | `extras: (t) => ({ rel_count: countOf(child, 'fk_column', t.id).as('rel_count') })`, then shape the output as before |
| `where: { rel: { some: {...} } }` | `exists(db.select({ x: sql\`1\` }).from(child).where(and(eq(child.fk, t.id), ...)))` in a top-level `where: (t) => …` |
| `count({ where })` | `db.$count(t, where)` |
| `aggregate({ _sum, _avg, _max, _count })` | `db.select({ s: mySum(t.c), a: myAvg(t.c), m: max(t.c), n: count() }).from(t).where(…)` |
| `groupBy` | `db.select({ k: t.k, n: count() }).from(t).where(…).groupBy(t.k)` |
| `create({ data })` | `const [row] = await db.insert(t).values(data).returning()` |
| `createMany` | `db.insert(t).values(rows)` |
| `update` / `updateMany({ where, data })` | `db.update(t).set(data).where(…)` (`.returning()` for the row, `rowCount` for the count). `.set({})` throws: skip empty updates |
| `upsert({ where, create, update })` | `db.insert(t).values(create).onConflictDoUpdate({ target: [unique columns], set: update }).returning()` |
| `{ views: { increment: 1 } }` | `sql\`${t.views} + 1\`` |
| `delete` / `deleteMany` | `db.delete(t).where(…)` |
| `in` / `notIn` / `not: null` / `null` | `inArray` / `notInArray` / `isNotNull` / `isNull` |
| `contains` / `startsWith` | `containsCi` / `startsWithCi` |
| `prisma[table]` (table chosen at runtime) | `tableNamed(name)`, `columnNamed(table, column)` |
| `$queryRaw` | `db.execute(sql\`…\`)` → `{ rows }` (PostgreSQL syntax) |

Relational queries (`db.query`): use the callback forms `where: (t, ops) => …`, `orderBy: (t) => [...]`, `extras: (t) => ({...})` inside nested `with`, so columns get the relation's alias. Inside `extras`, Drizzle re-aliases every column to the parent table; that is why `countOf()` names the child table itself.
