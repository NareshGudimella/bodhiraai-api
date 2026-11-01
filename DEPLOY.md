# bodhiraai-api: production deployment

How the NestJS API runs in production:
- **AWS Elastic Beanstalk**: 1 to 5 instances behind an Application Load Balancer.
- **Amazon RDS for PostgreSQL**: the database.
- **One EC2 host**: Redis, plus the operations tasks.

How the API fits with Cloudflare and the switch from legacy are in [../docs/cutover-runbook.md](../docs/cutover-runbook.md).

> **Status: draft for review.** None of this has been run against AWS or production yet.

## 1. Pieces

| Piece | What it is | Notes |
|---|---|---|
| Elastic Beanstalk | Node.js 22 platform on Amazon Linux 2023. Application Load Balancer; auto scaling 1–5 on CPU | Config is in `.ebextensions/` and `.platform/`. Each instance runs `node dist/main.js` (`Procfile`) behind Beanstalk's Nginx, on port 8080 |
| RDS PostgreSQL | PostgreSQL 15 or newer, Multi-AZ recommended | Automated backups replace the legacy backup cron |
| EC2 host | Redis, plus an operations checkout of this repo | Redis holds only the shared rate-limit counters. The host also runs migrations. **No background worker is needed today**: legacy dispatches no jobs and schedules no tasks (Phase 6c), and the port has none. Any future worker goes on this host |
| Cloudflare | DNS, plus the edge Worker in front of everything | The Worker passes `/api/v1/*` and `/webhooks/*` to `https://api-origin.bodhiraai.com`, a proxied record pointing at the load balancer |

## 2. Network and security groups

| Security group | Inbound |
|---|---|
| Load balancer | 443 from [Cloudflare's IP ranges](https://www.cloudflare.com/ips/) only |
| Beanstalk instances | 80 from the load balancer group (Beanstalk sets this up) |
| RDS | 5432 from the instance group and the EC2 group |
| EC2 (Redis) | 6379 from the instance group; 22 from the admin IPs only (or use SSM Session Manager) |

**Origin protection:** the Cloudflare IP allowlist alone isn't enough, because any Cloudflare customer's traffic comes from those ranges. The API therefore refuses requests without `PROXY_SECRET` (section 5), which only the Worker and the web server have. For a second layer, turn on Cloudflare **Authenticated Origin Pulls** and require its client certificate at the load balancer (mutual TLS on the 443 listener).

TLS:
- Set Cloudflare SSL/TLS to **Full (strict)**.
- Add a 443 listener to the load balancer with an ACM certificate for `api-origin.bodhiraai.com`. Set it on the environment, not in `.ebextensions`, because the certificate ARN differs per account:
  ```bash
  eb config   # aws:elbv2:listener:443  Protocol: HTTPS, SSLCertificateArns: <acm-arn>
  ```

## 3. RDS

1. Create the instance in the same VPC, with the master user kept in Secrets Manager.
2. Then, from the EC2 host:

```sql
-- psql "postgres://<master>@<rds-endpoint>:5432/postgres?sslmode=verify-full&sslrootcert=/etc/pki/tls/certs/rds-global-bundle.pem"
CREATE ROLE bodhira_app LOGIN PASSWORD '<strong-password>';
CREATE DATABASE bodhira OWNER bodhira_app;
\c bodhira
CREATE EXTENSION IF NOT EXISTS citext;   -- needs rds_superuser; the first migration expects it
```

**Connections:** each instance opens up to `DB_POOL_MAX` connections (default 10). At 5 instances that's 50, plus the EC2 host. Keep the total under the instance class's `max_connections`, or lower `DB_POOL_MAX`.

## 4. EC2 host: Redis and operations

Amazon Linux 2023:

```bash
sudo dnf install -y redis6 git nodejs22 postgresql16
sudo curl -so /etc/pki/tls/certs/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
sudo tee -a /etc/redis6/redis6.conf >/dev/null <<'CONF'
bind 0.0.0.0
protected-mode yes
requirepass <strong-password>
maxmemory 256mb
maxmemory-policy volatile-ttl
save ""
appendonly no
CONF
sudo systemctl enable --now redis6
```

- **No persistence:** the counters expire after a minute, so nothing needs to survive a restart.
- **If Redis is down:** the API logs `Redis unavailable, rate limiting in memory on this instance` at most once a minute and counts in each instance's own memory, so limits stay on but are per instance (with N instances a client gets up to N times the limit); nothing fails. Deep `/health` answers 503 `degraded` with `checks.redis.status: down`. This host is a single point of failure only for shared rate-limit counting.
- **Operations checkout:** clone the repo to `/opt/bodhiraai-api` and run `npm ci`. It needs the dev dependencies for `drizzle-kit` and `tsx`. Put an `.env` with only `DATABASE_URL` in it, then `chmod 600`.

## 5. Environment (Beanstalk environment properties)

`NODE_ENV`, `PORT=8080` and `NODE_EXTRA_CA_CERTS` come from `.ebextensions/01-bodhira.config`. Set the rest on the environment, never in files.

**Secrets** (`DATABASE_URL`, `PROXY_SECRET`, `REDIS_URL`, `R2_SECRET_ACCESS_KEY`, `FILE_URL_SECRET`, `VDOCIPHER_API_SECRET`, gateway and mail secrets, `ANTHROPIC_API_KEY`): keep them in Secrets Manager or Parameter Store, and reference them from the environment. Beanstalk's `aws:elasticbeanstalk:application:environmentsecrets` namespace does this; check the current Beanstalk docs before relying on it. Plain environment properties (`eb setenv`) are visible to anyone with console access, so use them only for non-secret values.


| Variable | Value |
|---|---|
| `DATABASE_URL` | `postgres://bodhira_app:<password>@<rds-endpoint>:5432/bodhira?sslmode=verify-full`. The RDS CA bundle is installed by `.ebextensions` |
| `DB_POOL_MAX` | `10` (section 3) |
| `REDIS_URL` | `redis://:<password>@<ec2-private-ip>:6379` |
| `PROXY_SECRET` | A long random value. **Use the same value** in the Worker (`wrangler secret put PROXY_SECRET`) and pass it to the web container (the Worker does this). Once it's set, the API **refuses every request without it** (403), except `/api/v1/ping` and `/health`. Only the Worker and the web server can reach it, and the visitor IP in `X-Client-IP` is believed only with it. When testing the environment directly, send `-H 'X-Proxy-Secret: …'`. **Required in production: the API refuses to start without it** (security: not in legacy) |
| `TRUST_PROXY` | `loopback` (Beanstalk's Nginx). The real visitor address comes from `X-Client-IP` |
| `CORS_ORIGINS`, `WEB_URL`, `PUBLIC_URL` | `https://bodhiraai.com` |
| `STORAGE_DRIVER` | `r2`, plus every `R2_*` variable (`R2_PUBLIC_URL` is the public custom domain of the uploads bucket) |
| `R2_PRIVATE_BUCKET` | The **private** bucket (no public domain, no `r2.dev` access): invoices, and every private upload (avatars, school logos, lesson PDFs and thumbnails, assignment attachments and submissions). The R2 API token needs read/write on it and on the uploads bucket (the cut-over script copies between them). Bind the same bucket to the Worker as `PRIVATE_FILES` |
| `FILE_URL_SECRET` | **Required in production; the API refuses to start without it** (32+ characters, `openssl rand -base64 48`). Signs the short-lived `/files/<key>?exp&sig` links. **Use the same value** in the Worker (`wrangler secret put FILE_URL_SECRET`), which serves `/files/*` from `PRIVATE_FILES`. Rotating it breaks links already handed out (they last `FILE_URL_TTL`) |
| `FILES_BASE_URL` | **Required in production** (the API refuses to start without it): `https://bodhiraai.com`, the origin whose Worker serves `/files/*` |
| `FILE_URL_TTL` | Optional, seconds (default `1800`, max `86400`) |
| `BILLING_GATEWAY`, `RAZORPAY_*`, `STRIPE_*` | Copy the legacy values. Live checkout needs `RAZORPAY_KEY_SECRET`. `RAZORPAY_WEBHOOK_SECRET` / `STRIPE_WEBHOOK_SECRET` are required for webhooks (without them the webhook answers a generic 400) |
| `BILLING_DEMO` | **Leave unset.** Without gateway keys, checkout used to activate plans with no payment (demo mode). With `NODE_ENV=production` that now answers 503 `payment_unavailable` unless `BILLING_DEMO=1` |
| `OTP_LOGIN_ENABLED` | **Leave unset.** Phone OTP sign-in (`/auth/otp/send`, `/auth/otp/verify`) is off in production by default (503 `otp_unavailable`) because no SMS provider is wired and codes would never reach their owners. Set `1` only once an SMS provider sends the code. Elsewhere it defaults to on |
| `MAIL_SETTINGS_KEY` | **Required in production.** 32 random bytes (`openssl rand -base64 32`) that encrypt the SMTP password saved in the super admin panel (Mail settings). Generate once and keep it: with a different key the saved password can't be read and must be entered again. The app starts without it (a warning is logged) but the password can't be saved |
| `MAIL_*` | **Optional fallback.** Outgoing mail is configured in the super admin panel (`/super/mail-settings`, table `mail_settings`). Until a row is saved there, the API uses these variables, so copy the legacy values for the first deploy and then switch to the panel. In production only `MAIL_MAILER=smtp` with a `MAIL_HOST` sends; otherwise sending fails with a logged error (the app still starts, and the message is never logged). The settings are cached for up to a minute per instance |
| `ANTHROPIC_*`, `APP_NAME`, `APP_ENV` | Copy the legacy values |
| `AI_DAILY_TOKEN_LIMIT` | Optional. The AI tutor's daily token budget per student when the school has no `ai_daily_token_limit` of its own (default `5000`). Copy the legacy value if it was set |
| `CACHE_STORE` | Optional, informational: reported by the deep `/health` as `checks.cache.driver` (legacy's `CACHE_STORE`). The API's only cache probe is the database `cache` table, so leave it unset (`database`) |
| `R2_LEGACY_BUCKET`, `LEGACY_FILES_ORIGIN` | Cut-over only, for `npm run files:make-private` on the EC2 host: the bucket legacy files were copied to (default `bodhira-legacy`), and the legacy site origin (`https://bodhiraai.com`) so absolute legacy URLs are recognised. Not needed by the running API |
| `VDOCIPHER_PUBLIC_VIDEO_IDS` | Optional, comma-separated. Extra VdoCipher ids the public `/video/otp` may sign (marketing videos). It already allows `VDOCIPHER_VIDEO_ID` and the CMS setting `media.home_video_id`; ids used by a lesson are always refused (security: not in legacy, which signed any id) |
| `VDOCIPHER_API_SECRET`, `VDOCIPHER_VIDEO_ID` | Copy the legacy values. The secret is **required for lesson videos**: without it, production refuses lesson video uploads (503) and playback OTPs (503), and logs a warning at start. Keep it in Secrets Manager. Leave `VDOCIPHER_API_BASE` unset (tests only); `VDOCIPHER_OTP_TTL` defaults to 300 |


## 6. Deploy

Run `scripts/deploy.sh` from a workstation with the AWS CLI and EB CLI (`eb init` once, choosing the Node.js 22 platform). It deploys the checked-out commit in a fixed order, and stops at the first failure:

```bash
OPS_INSTANCE_ID=<ec2-instance-id> EB_ENV=<environment> scripts/deploy.sh
```

1. It refuses uncommitted changes, or a commit that isn't pushed.
2. Lint, unit tests, and `npm run build`. `dist/` is uploaded; `.ebignore` leaves out `src/`, tests, scripts and `.env*`.
3. Migrations on the EC2 host **at the same commit**, through SSM Run Command. It needs the SSM agent and an instance role; a failure deploys nothing.
4. `eb deploy`, rolling one instance at a time with a temporary extra one, labelled with the commit. Then a ping through Cloudflare.

The script is a draft and hasn't been run against AWS yet. CI (`.github/workflows/ci.yml`) runs lint, type-check, unit tests and the build on every push. The e2e suite needs a database with the imported legacy data (its fixtures are specific users and ids), so it stays local. `npm run db:seed` fills an empty database with synthetic demo data instead (staging, demos); most e2e suites need the imported data, not the seed.

- Each instance installs the production dependencies itself from `package-lock.json`. `sharp` needs its Linux build, which is why `node_modules` isn't uploaded.
- **Health check:** the load balancer probes `/api/v1/ping`, which doesn't touch the database. A database blip therefore doesn't take every instance out.
- **Monitoring:** point monitoring at `/health` **with the `X-Proxy-Secret` header**. With the secret it runs the deep check below; without it (or with no `PROXY_SECRET` set in production) the public answer is only `{"status":"ok"}` / `{"status":"degraded"}` (503), from a read-only `SELECT 1`, and error details stay in the server log. The deep check writes to the database (cache table round trip) and checks the database and the cache table and, when `REDIS_URL` is set, Redis. Redis being down answers 503 `degraded` (`checks.redis.status: down`): requests still succeed, but rate limits are counted per instance in memory instead of shared; legacy has no Redis check, so this one is an addition. Add CloudWatch alarms on the load balancer's 5xx count and unhealthy host count, and on RDS CPU, connections and free storage.
- **Migrations must be backward-compatible** with the code already running, because a rolling deploy runs old and new code side by side. Schema changes go through `npm run db:generate`, and you review the generated SQL (see [docs/drizzle.md](docs/drizzle.md)).

## 7. Operations

- **Logs:** `.ebextensions/01-bodhira.config` streams instance logs to CloudWatch Logs (`/aws/elasticbeanstalk/<env>/…`), kept **30 days** and kept when the environment is terminated. 30 days is a default to confirm (cost vs. how far back incidents need to be traced); change `RetentionInDays` there. `eb logs` still works for the last few hundred lines. The instance profile needs `logs:CreateLogStream`/`PutLogEvents` (Beanstalk's default `aws-elasticbeanstalk-ec2-role` has them).
- **Scale:** `eb scale <n>` (1–5), or let CPU auto scaling handle it.
- **Database shell:** from the EC2 host, `psql "$DATABASE_URL"`.
- **Backups:** RDS automated backups (7+ days), plus a manual snapshot before every cut-over or risky migration.
