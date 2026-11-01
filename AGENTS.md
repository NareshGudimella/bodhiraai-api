# AGENTS.md: bodhiraai-api

NestJS 11 + Drizzle ORM (PostgreSQL) port of the legacy Laravel API. It serves `/api/v1/*` with the **same contract** as `../bodhiraai.com` (see [../docs/migration-plan.md](../docs/migration-plan.md)). Workspace rules: [../AGENTS.md](../AGENTS.md).

## Layout

| Path | Purpose |
|---|---|
| `src/main.ts` | Bootstrap: UTC timezone, `.env` loading, `configureApp()` |
| `src/app.setup.ts` | Global prefix `api/v1`, helmet, CORS, BigInt→number JSON, validation pipe, error filter. Shared with the e2e tests |
| `src/app.module.ts` | Global guards in order: `TokenAuthGuard` → `RolesGuard`. Rate limits are per route |
| `src/common/` | `http/` (`ok()`, `paginated()`, `fail()`, `ApiException`, `ValidationFailed`), `http/laravel.ts` (Laravel-compatible serialisation, see below), `decorators/` (`@Public()`, `@Roles()`, `@CurrentUser()`, `@RateLimit()`), `guards/`, `roles.ts` |
| `src/student/` | Phase 1 port of `StudentService` and the student API controllers, `BadgeCatalog`, the subscription access check |
| `src/ai/` | AI tutor: `AiService`, `ClaudeClient` (Anthropic SDK; returns null to fall back to the canned reply), `ai-tutor.ts` (prompt, canned replies) |
| `src/live-class/` | Student and teacher live classes, the Laravel-style store validator |
| `src/notification/` | `NotificationService.notifyMany()` writes Laravel database-channel rows; `/me/notifications` endpoints |
| `src/teacher/`, `src/parent/`, `src/chat/` | Phase 3 ports (`TeacherService`, `ParentService`, chat) |
| `src/common/http/eloquent.ts` | `toModel(table, row, relations)` / `withPivot(...)`: `Model::toArray()` for raw-model responses (per-table casts and hidden fields); `dirtyFields()` for `fill()->save()` (write only changed columns, keep `updated_at` otherwise); `phpBool()` |
| `src/storage/` | `StorageService` (R2 / local), upload rules (`FileUploadService` port, content sniffing), `validateWithFile` / `storeOrReject` / `uploadOptions` for multipart routes |
| `src/account/` | `/me/profile`, `/me/password` (all roles) |
| `src/admin/`, `src/super/` | Phase 4 ports (`AdminService`, `SuperAdminService`). `guardSameSchool()` for cross-school 403s; soft-deleted schools are filtered with `LIVE_SCHOOL` |
| `src/admin/school-web.controller.ts`, `src/super/catalogue.controller.ts` | Phase 4b: endpoints for legacy web-only features (parent links, syllabus opt-in; syllabi, plans, enquiries) |
| `src/content/` | Phase 4b: `ContentService` and the `/content` endpoints (library, chapters, lessons with uploads, quiz builder) |
| `src/billing/` | Phase 5: pricing, paywall, B2C checkout and invoices (`CheckoutController`), school billing and manual grants (`SchoolBillingController`), gateway webhooks at `/webhooks/*` outside `/api/v1` (raw body, see `app.setup.ts`). `gateways.ts` ports `RazorpayGateway`/`StripeGateway`; `invoice.service.ts` and `invoice-pdf.ts` (pdfkit with the DejaVu fonts in `assets/fonts/`) port `InvoiceService` |
| `src/cms/` | Phase 6a: the Web Studio (`/cms/*`, super and web admins): collections from one schema-driven controller factory (`cms.schema.ts`, `cms-resource.controller.ts`), pages and sections, posts and tags, menus, media, settings (`SettingsService` also clears legacy's cached copy), lead management with CSV export, `AuditService` (`audit_logs`). Public lead forms: `leads.controller.ts` (`/leads/*`) |
| `src/cms/site.controller.ts`, `site-images.*`, `video.controller.ts` | Phase 6b: public data for the marketing site (`/site/*`), the Site Image Manager (overrides in `site_settings`, group `site_images`), the VdoCipher OTP (`/video/otp`) |
| `src/common/decorators/client.decorator.ts` | `@Client()`: the visitor's IP (from `X-Forwarded-For` when the caller is in `TRUST_PROXY`), user agent and referer, as Laravel's `$request->ip()` etc. |
| `src/mail/` | `MailService`: Laravel's `log`, `smtp` (nodemailer) and `array` mailers. Settings come from the `mail_settings` table (`MailSettingsService`, cached; edited at `/super/mail-settings` by `src/super/mail-settings.controller.ts`; password AES-256-GCM with `MAIL_SETTINGS_KEY` in `mail-crypto.ts`, never returned), falling back to `MAIL_MAILER` etc. when no row exists |
| `src/super/color-extractor.ts`, `src/storage/mp4-faststart.ts` | Exact ports of `ColorExtractor` (GD's bilinear downscale included) and `Mp4Faststart` |
| `src/common/http/laravel-validator.ts` | `laravelValidate(db, body, rules)`: Laravel validation rules, messages and semantics |
| `src/common/http/transform-request.middleware.ts` | Laravel `TrimStrings` + `ConvertEmptyStringsToNull`, applied to every route |
| `src/common/http/php-strings.ts` | `mb_strwidth`/`mb_strimwidth`/`Str::limit` (wide-character table extracted from PHP) |
| `src/auth/` | Sanctum-compatible `TokenService`, `$2y$` bcrypt helpers, `userResource()`, auth endpoints, `PasswordResetService` (Laravel's password broker), `WebHandoffService` (not in legacy: `/auth/web-handoff`, single-use codes in `web_handoff_codes`, a Node-only table) |
| `src/health/` | `/api/v1/ping`, and `/health` outside the prefix (legacy `HealthController`: DB and database-cache probes). Public callers get only `{status}`; the deep check needs `X-Proxy-Secret` (or no `PROXY_SECRET` outside production) |
| `src/db/` | Drizzle on PostgreSQL: `schema.ts` (tables and relations, legacy names), `types.ts` (row types), `db.ts` (`DB` token, `createDb()`), `helpers.ts` (legacy-compatible ordering, search, counts). Rules: [docs/drizzle.md](docs/drizzle.md) |
| `drizzle/` | SQL migrations generated by drizzle-kit. This app owns the PostgreSQL schema |

## Conventions

- One Nest module per legacy area (`src/student/`, `src/teacher/`, …): controller → service → Drizzle (`@Inject(DB) private readonly db: Db`). Port logic from the matching legacy `app/Services/*Service.php`.
- Every route needs auth unless marked `@Public()`. Public routes still resolve a bearer token when one is sent (`req.user`), but never reject a bad one. Restrict roles with `@Roles(Role.X)`. Add `@RateLimit(LIMITS.x, key)` only where the legacy route had `throttle:x`; legacy has **no** global limiter.
- Return `ok(data, message?)` or `paginated(...)`. Throw `ApiException(message, status, code?)` or `ValidationFailed`. Never return raw entities: map them through a resource function (like `userResource`) so the JSON matches the legacy `*Resource`.
- Use the helpers in `http/laravel.ts` to match Laravel's output exactly:
  - Dates: `iso8601` for Resources, `eloquentDate`/`eloquentRow` for raw models, `diffForHumans`.
  - Route binding: `routeId` and `modelNotFound` reproduce the legacy 404 message.
  - JSON columns: parse with `jsonCast`, write with `phpJsonEncode`.
- Write timestamps explicitly (`created_at`/`updated_at`), because Laravel sets them, not the DB.
- Follow [docs/drizzle.md](docs/drizzle.md) for every query: `citext` text compares case-insensitively like legacy, `myAsc`/`myDesc` keep legacy's NULL order, every ordering ends with `asc(t.id)`, `countOf` replaces relation counts, `containsCi` replaces LIKE searches.
- When a route has a binding or ownership check, take `@Body() body: unknown` and call `validateBody(Dto, body)` after the lookup. Laravel answers 404/403 before 422, and the global `ValidationPipe` would validate first.
- Notifications: build the same `toArray()` payload as the legacy class and call `NotificationService.notifyMany(ids, '<ClassName>', data)`. Links use `WEB_URL`.
- Text Laravel shortens with `Str::limit` must use `strLimit()` (display width, not length).
- Where the legacy controller uses `$request->validate([...])`, port the rule array as-is to `laravelValidate()`, and call it where the legacy code does (before or after the guards). Add a rule to the engine instead of hand-validating.
- When legacy returns a raw model (`'class' => $class`), serialise it with `toModel`/`withPivot`, keeping the relation names (snake_case) and the `load()` order. Add the table's `$casts`/`$hidden` to `eloquent.ts` first.
- Use `forbidden()` for a bare `abort(403)` (message "HTTP error"), and `modelNotFoundClass()` for an id-less `firstOrFail()`.
- Uploads: `@UseInterceptors(FileInterceptor(field, uploadOptions(capMb)))`, then `validateWithFile(db, body, rules, file, {field, kind, maxKb})` (it also applies Laravel's trimming, which middleware can't do for multipart), then `storeOrReject(field, () => storage.store(file, category, folder))`. Store absolute URLs; delete replaced files with `storage.delete(url)`, which only touches files this service stored.
- Check a new port against the running legacy API before calling it done. List any additive or intentional differences in the migration plan.
- Table, relation and row-type names follow the legacy table names (`users`, `schools`, …); relation names are the old Prisma include names (`post.users`, `sub.schools`).
- Files that must not be public (invoices) go through `storage.putPrivate()`/`getPrivate()` and are served by an endpoint that checks ownership.
- Use `@Client()` for anything legacy reads from `$request->ip()`, `userAgent()` or the Referer (audit rows, leads). The web forwards these; never read `req.ip` directly. Behind Cloudflare the address comes from `X-Client-IP` plus `PROXY_SECRET` (`common/http/client-ip.ts`).
- Production runs 1–5 instances (Elastic Beanstalk; see [DEPLOY.md](DEPLOY.md)). Keep no per-process state: rate-limit counters go to Redis (`REDIS_URL`), and files go to R2.
- Legacy bugs kept for parity sit behind a named constant or a comment that says so (see the migration plan's "Known legacy bugs"), so the fix is one deliberate change.
- Legacy `env('X')` read as a string: use `envString()` (`billing/gateways.ts`), which maps Laravel's `true`/`false`/`empty`/`null` literals.

## Security deviations (marked `// security: not in legacy`)

Deliberate differences from legacy, each labelled in code; keep them when porting or testing parity (`test/security.e2e-spec.ts`):

- **Registration:** teachers and parents start `on_hold` (no token; message says the school must approve; an admin activates them with `POST /admin/users/:id/toggle`). Sign-up respects `max_teachers` / `max_students`.
- **Tokens:** `TokenService.resolve` rejects users whose status isn't `active` (401). Web tokens (`web`, `web-handoff`) live 30 days; other devices 90 days idle (sliding, `last_used_at`) and 1 year absolute. `TokenService.revokeAllForUser(userId, exceptTokenId?)` signs a user out everywhere: call it when deactivating, blocking or removing an account. Password change (keeps the caller's token) and reset call it.
- **Web handoff:** issuing is limited to 10 codes an hour per user; `POST /auth/web-handoff/peek {code}` returns `{name, role}` without consuming the code.
- **Phone OTP:** off in production unless `OTP_LOGIN_ENABLED=1` (503 `otp_unavailable`; no SMS provider exists). 5 wrong codes kill the OTP (`otp_attempts`, Node-only table); no Guest rows; student/teacher/parent accounts only; `active` status required; limits per IP and per phone.
- **Billing:** demo checkout is refused in production unless `BILLING_DEMO=1`. A payment is applied once (webhook replays are ignored); gateway errors are logged, not returned.
- **Mail:** in production only a complete `smtp` configuration (admin panel row, else `MAIL_*`) sends; otherwise `send()` logs an error (never the message) and throws. The app still starts. `mail_settings` is Node-only; the SMTP password is write-only (`password_set` in responses, blank on save keeps it).
- **AI tutor:** the budget is reserved atomically per user and metered on Claude's reported usage; history is capped at 8000 characters.
- **Rate limits:** `RateLimit(limit, key, ttlMs)`; `RateLimiter.hit()` adds a second limit (per phone, per IP per hour). Redis errors fall back to in-memory counting.

## Commands

```bash
npm run start:dev       # watch mode on :4000 (PORT)
npm run build           # → dist/
npm run lint            # eslint --fix + prettier
npm test                # unit (src/**/*.spec.ts)
npm run test:e2e        # e2e (test/), needs DATABASE_URL with the seeded schema
npm run db:generate     # after editing src/db/schema.ts → drizzle/NNNN_*.sql
npm run db:migrate      # apply migrations to DATABASE_URL
```

`.env`: copy `.env.example`. Local database: `createdb bodhira`, then `npm run db:migrate`. Uploads use `STORAGE_DRIVER=local` in development (files in `storage/uploads`, served at `/uploads`; private files in `storage/private`, not served); production sets `STORAGE_DRIVER=r2` with the `R2_*` variables, including `R2_PRIVATE_BUCKET` for invoices. Without gateway keys, billing runs in demo mode like legacy.

## Don'ts

- Don't edit `drizzle/*.sql` after it is applied anywhere; add a new migration. Don't use `drizzle-kit push` outside throwaway databases.
- Never connect to the legacy app's database.
- Don't change the response envelope, token format or password hashing. They keep compatibility with the legacy app and mobile clients.
- Don't add `@nestjs/config`. Version 12 is ESM-only and breaks Jest; use `src/config/env.ts`.
