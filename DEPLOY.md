# bodhiraai-api: production deployment

How the NestJS API runs in production:
- **AWS Elastic Beanstalk**: 1 to 5 instances behind an Application Load Balancer.
- **Supabase (PostgreSQL)**: the database, reached through Supabase's connection pooler.
- **One EC2 instance (the worker host)**: Redis (shared rate-limit counters and the job queue) and the background-job worker (not in legacy).
- **Cloudflare**: the website Worker in front (see `../bodhiraai-ui/DEPLOY.md`) and R2 for files, videos and uploads.

How the API fits with Cloudflare and the switch from legacy are in [../docs/cutover-runbook.md](../docs/cutover-runbook.md).

> **Status: draft for review.** None of this has been run against AWS or production yet.

## 1. Pieces

| Piece | What it is | Notes |
|---|---|---|
| Elastic Beanstalk | Node.js 22 platform on Amazon Linux 2023. Application Load Balancer; auto scaling 1–10 on CPU | Config is in `.ebextensions/` and `.platform/`. Each instance runs `node dist/main.js` (`Procfile`) behind Beanstalk's Nginx, on port 8080 |
| Supabase | PostgreSQL 17 (Pro plan recommended for daily backups and point-in-time recovery). The app connects through the **transaction pooler** (port 6543); migrations use the **session pooler** (port 5432) | Pick a region close to the Beanstalk region. Use the pooler host, not `db.<ref>.supabase.co`, which is IPv6-only |
| Worker host (EC2) | Amazon Linux 2023, in the Beanstalk VPC: Redis with AOF persistence, and the BullMQ worker (the same build with `APP_TYPE=WORKER`, under PM2) | Section 4. Redis holds the shared rate-limit counters and the job queue. The worker runs the jobs the API enqueues: emails (password reset), invoice PDF and email after payment, notification rows, lesson-video transcoding to encrypted HLS (needs `ffmpeg`, below) and HLS deletes. Not in legacy, which did this work inside the request; without `REDIS_URL` the API still does (inline) |
| Cloudflare | DNS, plus the edge Worker in front of everything | The Worker passes `/api/v1/*` and `/webhooks/*` to `https://api.bodhiraai.com`, a proxied record pointing at the load balancer |

## 2. Network and security groups

| Security group | Inbound |
|---|---|
| Load balancer | 443 from [Cloudflare's IP ranges](https://www.cloudflare.com/ips/) only |
| Beanstalk instances | 80 from the load balancer group (Beanstalk sets this up) |
| Worker host (EC2) | 6379 from the Beanstalk instance group only. No SSH from the internet: use SSM Session Manager, or 22 from the admin IPs only |

Supabase is reached over the internet with TLS. Its **Network Restrictions** can limit database access to the Beanstalk instances' and the worker host's outbound IPs: give them a NAT gateway with an Elastic IP (or Elastic IPs) and allow only those, plus the machines that run migrations. The worker host also needs outbound HTTPS (R2, VdoCipher) and SMTP.

**Origin protection:** the Cloudflare IP allowlist alone isn't enough, because any Cloudflare customer's traffic comes from those ranges. The API therefore refuses requests without the proxy header `X-Proxy-Secret` (section 5), which only the Worker and the web server can send. For a second layer, turn on Cloudflare **Authenticated Origin Pulls** and require its client certificate at the load balancer (mutual TLS on the 443 listener).

TLS:
- Set Cloudflare SSL/TLS to **Full (strict)**.
- Add a 443 listener to the load balancer with an ACM certificate for `api.bodhiraai.com`. Set it on the environment, not in `.ebextensions`, because the certificate ARN differs per account:
  ```bash
  eb config   # aws:elbv2:listener:443  Protocol: HTTPS, SSLCertificateArns: <acm-arn>
  ```

## 3. Supabase (database)

1. Create the project (region close to Beanstalk) and keep the database password in Secrets Manager.
2. Database → Extensions: enable **citext** (schema `public`); the first migration expects it.
3. Copy two connection strings from **Connect**:
   - **Transaction pooler** (port 6543) → the app's `DATABASE_URL`.
   - **Session pooler** (port 5432) → `MIGRATE_DATABASE_URL` for `scripts/deploy.sh`, data copies and `psql`.
4. Append `?uselibpqcompat=true&sslmode=require` to both. Node's `pg` driver otherwise treats `sslmode=require` as full certificate verification, and Supabase's certificate isn't in Node's default trust store, so the connection fails. That keeps TLS but skips certificate verification. shortcut: encrypted but not certificate-verified; upgrade by downloading Supabase's CA (Database settings → SSL), adding it as a file in `.ebextensions` with `NODE_EXTRA_CA_CERTS`, and using `sslmode=verify-full`.
5. Apply the schema: `DATABASE_URL="<session pooler URL>" npm run db:migrate`. For existing data, copy it in with `pg_dump`/`psql` over the session pooler (only the `public` and `drizzle` schemas).

**Connections:** each process opens up to `DB_POOL_MAX` connections to the transaction pooler, which multiplexes them onto the database: `10` per web instance, `5` on the worker (one per concurrent job, `WORKER_CONCURRENCY` 5). At the peak of 11 web instances (10, plus the extra one during a rolling deploy) that's 11 × 10 + 5 = **115 client connections**, under the pooler's 400-client limit on **Small** compute (the production size: 2 GB, 90 database connections). If you raise `MaxSize`, `DB_POOL_MAX` or `WORKER_CONCURRENCY`, redo this sum: (MaxSize + 1) × DB_POOL_MAX + worker DB_POOL_MAX must stay under the limit. Keep the worker's `DB_POOL_MAX` at least `WORKER_CONCURRENCY`. The pooler multiplexes those clients onto its **pool size** of real database connections (default 15 on Small), and that is the queue under load: raise it in Database → Settings → Connection pooling to about **40** (of the 90; the rest stays for Supabase's own services, the session pooler, migrations and `psql`). Beyond that, move to Medium compute (600 clients, 120 connections).

## 4. Worker host: Redis and the job worker

One small EC2 instance (e.g. `t4g.small`, Amazon Linux 2023, **at least 40 GB gp3** for 5 GB lesson videos) in a private subnet of the Beanstalk VPC, with its own security group (section 2).

**ffmpeg** (lesson videos, **this host only**; Beanstalk never transcodes): the `video-transcode` job runs `ffmpeg` and `ffprobe` from PATH on this host and turns each uploaded lesson video into AES-128 encrypted HLS (360p and 720p). Install it:

```bash
sudo dnf install -y ffmpeg        # if the AL2023 repos have no ffmpeg: use a static build below
ffmpeg -version && ffprobe -version
# Static build fallback (arm64 for t4g; pick the build and verify its checksum from the vendor's page):
#   curl -LO https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz
#   tar xf ffmpeg-release-arm64-static.tar.xz && sudo cp ffmpeg-*-static/{ffmpeg,ffprobe} /usr/local/bin/
```

CPU sizing: transcoding is CPU-bound. A `t4g.small` (2 vCPU, burstable) makes a 10-minute 1080p lesson in roughly real time or slower (x264 `veryfast`, both renditions one after the other) and runs out of CPU credits under a steady stream of uploads: it is fine for occasional uploads. For regular use pick `c7g.large` or bigger, and set `WORKER_CONCURRENCY=1` (or 2) so one transcode does not starve the other jobs. The original is streamed from R2 to a temp file and the HLS output is uploaded from disk file by file (nothing is held in memory); `/tmp` needs about 2.5 times the original (original plus ~1.5x output, removed afterwards) and the job fails with a clear message when it does not fit. Sources up to 5 GB therefore need **at least 40 GB gp3** (OS, Redis and headroom included); long transcodes (hours for a 5 GB 1080p source on a small instance) are expected. These sizing figures are estimates, not measured on that instance.

**Redis** (jobs must survive a restart, so AOF persistence is on):

```bash
sudo dnf install -y redis6 nodejs22 rsync
sudo npm install -g pm2
sudo tee -a /etc/redis6/redis6.conf >/dev/null <<'CONF'
bind 127.0.0.1 <private-ip>
protected-mode yes
requirepass <strong-password>
appendonly yes
appendfsync everysec
maxmemory 512mb
# BullMQ requires noeviction: an evicted job key would lose the job.
maxmemory-policy noeviction
CONF
sudo systemctl enable --now redis6
redis6-cli -a '<strong-password>' --no-auth-warning config get appendonly   # → yes
```

- `REDIS_URL` is `redis://:<password>@<private-ip>:6379` on Beanstalk and `redis://:<password>@127.0.0.1:6379` on the worker. Use a password without `@`, `:` or `/` (`openssl rand -hex 32`). shortcut: plain TCP inside the VPC (no TLS); upgrade with Redis TLS (`tls-port`) and `rediss://` if the network can't be trusted.
- **Backups:** the AOF file is in `/var/lib/redis6`. Take daily EBS snapshots of the volume (Data Lifecycle Manager); a lost Redis loses queued jobs and resets rate-limit counters, nothing else.
- **If Redis is down:** rate limits are counted per instance in memory (logged at most once a minute), and jobs run inline in the API instance that wanted them (emails, invoices, notifications, video deletes, as before). Lesson videos are **not** transcoded there (no ffmpeg on Beanstalk): the lesson stays `processing` with its original kept, and the worker's sweep (at start and every 5 minutes) queues it once Redis is back. Nothing fails; deep `/health` answers 503 `degraded`.

**The worker** runs under PM2 as the deploy user, from the release directory of the current deploy (section 6), with `ecosystem.worker.config.js`. The web API is not here: it runs on Elastic Beanstalk.

```bash
sudo mkdir -p /opt/bodhiraai-api/releases
sudo chown -R <deploy-user> /opt/bodhiraai-api
install -m 600 /dev/null /opt/bodhiraai-api/.env   # as <deploy-user>; then fill it in (below)
# Start PM2 (and the saved worker) at boot, as <deploy-user>: run the command this prints.
pm2 startup systemd -u <deploy-user> --hp /home/<deploy-user>
# Rotate PM2's log files (default: 10 MB, 30 files kept).
pm2 install pm2-logrotate
```

The first `scripts/deploy.sh` starts the worker and `pm2 save`s it, so it comes back after a reboot.

**`APP_TYPE`** picks the role of the one build: `WEB` (the default; Beanstalk, nothing to set) serves the HTTP API, `WORKER` runs the background jobs (`ecosystem.worker.config.js` sets it). Any other value refuses to start.

`/opt/bodhiraai-api/.env` (the API root's `.env`; each release links to it, and the app loads it itself as it does locally) holds the **same values as the Beanstalk environment** (section 5) that the jobs use, readable only by the deploy user; sample: `env-samples/worker.env`: `NODE_ENV=production`, `DATABASE_URL` (the transaction pooler), `DB_POOL_MAX=5`, `REDIS_URL` (127.0.0.1), `APP_SECRET`, `WEB_URL`, `APP_NAME`. Provider credentials are not here: the worker reads them from the database, where the panel saved them. Optional: `WORKER_CONCURRENCY` (default 5; raise this, not the PM2 instance count, for more parallel jobs). It has no HTTP server, so it needs no `PORT` and no proxy header; its `APP_SECRET` is the same value as Beanstalk's. Keep the file in step with the Beanstalk environment when a secret rotates, then `pm2 restart bodhira-worker`.

- Stopping or restarting is graceful: PM2 sends SIGINT and the worker finishes the jobs it is running (up to `kill_timeout`, 120 s) before it exits. A job cut off by a crash is picked up again (BullMQ's stalled-job check) and retried. PM2 restarts a crashed worker at once. It runs one process (one thread); raise `WORKER_CONCURRENCY` for more parallel jobs.
- Useful commands: `pm2 status`, `pm2 logs bodhira-worker`, `pm2 restart bodhira-worker`, `pm2 monit`.
- **If the worker is down:** jobs wait in Redis and run when it's back. Meanwhile invoice PDFs are rendered on demand when downloaded, password-reset and invoice emails wait, notifications appear late and uploaded videos stay `processing`. Watch `checks.queue.waiting` (section 6, Monitoring).
- This host is a single point of failure for the queue (not for requests). A second worker host can run the same PM2 app against the same Redis if needed; jobs are idempotent.

## 5. Environment (Beanstalk environment properties)

`NODE_ENV` and `PORT=8080` come from `.ebextensions/01-bodhira.config`. Set the rest on the environment, never in files.

**Secrets** (`DATABASE_URL`, `APP_SECRET`, `REDIS_URL`): keep them in Secrets Manager or Parameter Store, and reference them from the environment. Provider secrets (R2, SMTP password, gateway and Anthropic keys) are not environment variables: the panel saves them encrypted in the database (step 6). Beanstalk's `aws:elasticbeanstalk:application:environmentsecrets` namespace does this; check the current Beanstalk docs before relying on it. Plain environment properties (`eb setenv`) are visible to anyone with console access, so use them only for non-secret values.


| Variable | Value |
|---|---|
| `DATABASE_URL` | Supabase **transaction pooler**: `postgresql://postgres.<ref>:<password>@<region>.pooler.supabase.com:6543/postgres?uselibpqcompat=true&sslmode=require` (section 3) |
| `DB_POOL_MAX` | `10` on Beanstalk, `5` on the worker (section 3) |
| `REDIS_URL` | `redis://:<password>@<worker-host-private-ip>:6379` (section 4). With it the API only enqueues background jobs and the worker runs them; rate-limit counters are shared. Unset (one instance, development): jobs run inline, counters in memory |
| `APP_SECRET` | 32+ random bytes (`openssl rand -base64 32`), the API's one secret. **Use the same value** on the Worker (`wrangler secret put APP_SECRET`) and on any Node web host. Each use derives its own key (HKDF-SHA256, `src/config/app-secret.ts`): the panel's secret encryption (`settings`), signed `/files` links (`file-urls`, which the Worker checks too) and the proxy header (`proxy`, `X-Proxy-Secret`). **Required in production: the API refuses to start without it** (security: not in legacy). Once it's set, the API **refuses every request without the proxy header** (403), except `/api/v1/ping` and `/health`; the visitor IP in `X-Client-IP` is believed only with it. When testing the environment directly, send `-H 'X-Proxy-Secret: …'` (the derived proxy value; the Worker does this for real traffic). Changing it makes the panel's saved secrets unreadable (re-enter them), breaks links already handed out, and needs the new value on the Worker and the web host |
| `TRUST_PROXY` | `loopback` (Beanstalk's Nginx). The real visitor address comes from `X-Client-IP` |
| `CORS_ORIGINS` | `https://bodhiraai.com` |
| `WEB_URL` | `https://bodhiraai.com`. **Required in production** (the API refuses to start without it): notification links, and the origin of signed private-file links (`<WEB_URL>/files/…`, served by the Worker; links last 30 minutes) |
| Storage | Not an environment variable: production stores uploads in R2, whose account, keys, buckets (public, private, optional video) and public domain are set in the panel (Integrations → Storage), see step 6. Until it is configured, uploads answer 503 |
| `BILLING_GATEWAY`, `RAZORPAY_*`, `STRIPE_*` | Not environment variables any more: the gateway, keys and webhook secrets are set in the panel (Integrations → Payments), see step 6 |
| Demo checkout | Not an environment variable: without gateway keys, checkout used to activate plans with no payment (demo mode). In production that answers 503 `payment_unavailable` unless **Allow demo checkout in production** is on in the panel (Integrations → Payments). Leave it off |
| `OTP_LOGIN_ENABLED` | Retired, no longer read. Phone OTP sign-in (`/auth/otp/send`, `/auth/otp/verify`) is on when SMS is enabled in the panel (Integrations → SMS). Without it, production answers 503 `otp_unavailable`, because codes would never reach their owners |
| SMTP (panel: Mail settings, `/super/mail-settings`) | Outgoing mail is configured in the panel and stored in `mail_settings`. In production only a complete SMTP configuration sends; otherwise sending fails with a logged error (the app still starts, and the message is never logged). Settings are read on every send, so a save applies at once on every instance and the worker |
| `APP_NAME`, `APP_ENV` | Copy the legacy values |
| `files:make-private` flags | Cut-over only, not environment variables: `npm run files:make-private -- --origin https://bodhiraai.com` (the legacy site origin, so absolute legacy URLs are recognised). The legacy bucket (default `bodhira-legacy`) is the panel's Storage → `legacy_bucket` |
| `WORKER_CONCURRENCY` | Worker host only, optional: jobs run at once (default `5`) |
| Test-only knobs: `R2_ENDPOINT`, `MSG91_API_BASE`, `ANTHROPIC_BASE_URL` | Leave unset in production (tests point them at local stubs). |

**Trade-off:** the Cloudflare Worker and the web host now hold `APP_SECRET`, and that key also decrypts the panel's saved provider secrets. That matters only together with database access.


## 6. Deploy

Run `scripts/deploy.sh` from a workstation with the AWS CLI and EB CLI (`eb init` once, choosing the Node.js 22 platform). It deploys the checked-out commit in a fixed order, and stops at the first failure:

```bash
MIGRATE_DATABASE_URL='<session pooler URL>' WORKER_HOST=<ssh host of the worker> EB_ENV=<environment> scripts/deploy.sh
```

1. It refuses uncommitted changes, or a commit that isn't pushed.
2. Lint, unit tests, and `npm run build`. `dist/` is uploaded; `.ebignore` leaves out `src/`, tests, scripts and `.env*`.
3. Migrations against Supabase from the same machine, **at the same commit**, through the session pooler. A failure deploys nothing.
4. The worker, before the API (a new worker handles jobs from old and new API instances alike): the built `dist/`, `assets/` and package files go to `/opt/bodhiraai-api/releases/<commit>` over SSH (`WORKER_HOST` is an `ssh` destination, e.g. a `~/.ssh/config` entry; SSM Session Manager can carry it), `npm ci --omit=dev` there, the `current` link moves to it, the old PM2 worker stops gracefully and the new one starts from the new release (`pm2 save` keeps it for reboots). The script stops if the worker isn't `online`. The last three releases are kept; to roll back: `pm2 delete bodhira-worker && pm2 start /opt/bodhiraai-api/releases/<previous>/ecosystem.worker.config.js && pm2 save`. `SKIP_WORKER=1` skips this step (only when the worker code didn't change).
5. `eb deploy`, rolling one instance at a time with a temporary extra one, labelled with the commit. Then a ping through Cloudflare.
6. **Configure integrations in the panel** (Super Admin → Integrations and Mail settings). Providers are read only from the panel, so each stays off until saved. On the **first deploy**, copy the legacy values in before step 4, since the worker needs the providers too. `npm run settings:import-env` is a dry run that prints what it would save; `npm run settings:import-env -- --apply` saves. Run it with the production `DATABASE_URL` and `APP_SECRET`, and with the legacy values still in the environment. It skips any provider already saved in the panel, and it saves SMS disabled, so enable SMS there. Or fill in the panel by hand. Then check that each provider shows as configured:
   - Storage: account, keys, buckets and public URL. `private_bucket` (no public domain) holds invoices and private uploads; bind the same bucket to the Worker as `PRIVATE_FILES`.
   - **Lesson video upload (not in legacy):** the browser PUTs the file (up to 5 GB) straight to the API's own host, `https://api.<WEB_URL host>` (DNS-only in Cloudflare, so no Cloudflare limits), authorised by a signed `?t=` token. `.platform/nginx/conf.d/elasticbeanstalk/video-upload.conf` gives that one route `client_max_body_size 5G`, no request buffering and 3600 s timeouts; the API streams it into R2 (no R2 CORS needed). `CORS_ORIGINS` must list the site origin (PUT is allowed from it). The route is exempt from the `X-Proxy-Secret` rule (the token authorises it). Node's request timeout is raised to 1 h in `main.ts`; the ALB idle timeout is fine while bytes flow.
   - Lesson videos need no provider: they are transcoded by the worker (`ffmpeg`, section 4) and stored in the private R2 bucket.
   - Payments: gateway and keys. **Webhooks need the payment webhook secrets in the panel** (`razorpay_webhook_secret` or `stripe_webhook_secret`); without them the webhook answers a generic 400.

   Then remove the moved variables from the Beanstalk environment and the worker file, and send a test webhook from the gateway dashboard.

The script is a draft and hasn't been run against AWS yet. CI (`.github/workflows/ci.yml`) runs lint, type-check, unit tests and the build on every push. The e2e suite needs a database with the imported legacy data (its fixtures are specific users and ids), so it stays local. `npm run db:seed` fills an empty database with synthetic demo data instead (staging, demos); most e2e suites need the imported data, not the seed.

- Each instance installs the production dependencies itself from `package-lock.json`. `sharp` needs its Linux build, which is why `node_modules` isn't uploaded.
- **Health check:** the load balancer probes `/api/v1/ping`, which doesn't touch the database. A database blip therefore doesn't take every instance out.
- **Monitoring:** point monitoring at `/health` **with the `X-Proxy-Secret` header**. With the secret it runs the deep check below; without it (or without `APP_SECRET` outside production) the public answer is only `{"status":"ok"}` / `{"status":"degraded"}` (503), from a read-only `SELECT 1`, and error details stay in the server log. The deep check writes to the database (cache table round trip) and checks the database and the cache table and, when `REDIS_URL` is set, Redis. Redis being down answers 503 `degraded` (`checks.redis.status: down`, and `checks.queue.status: down`): requests still succeed, but rate limits are counted per instance in memory instead of shared and jobs run inline; legacy has no Redis check, so this one is an addition. `checks.queue` (not in legacy) also reports the job counts `waiting`, `active`, `delayed` and `failed`: alert when `failed` grows or `waiting` stays above ~50 for 10 minutes (the worker is down or stuck). Add CloudWatch alarms on the load balancer's 5xx count and unhealthy host count, and watch Supabase's database CPU, connections and disk in its dashboard (or its alerts).
- **Migration 0007 (Bodhira Direct, the default school)** carries a data step that runs with `npm run db:migrate`: on a database with users it creates the school and moves the students with no school (and parents whose children are all there) into it. It is **not** backward-compatible: code from before it would treat the moved students as members of a free, active school (no paywall) until the new version is live. Before cut-over that doesn't matter (no production traffic); on a live system, keep the gap between the migration and `eb deploy` short. On an empty database it does nothing; after a data copy run `npm run db:direct-school` (runbook step 5b).
- **Migrations must be backward-compatible** with the code already running, because a rolling deploy runs old and new code side by side. Schema changes go through `npm run db:generate`, and you review the generated SQL (see [docs/drizzle.md](docs/drizzle.md)).

**By GitHub Actions** (`.github/workflows/deploy.yml`, runs only in the live repo `aveniqinnovations/ba-api`; other copies skip it): after CI passes on a push to `main` (or by hand: Actions → Deploy → Run workflow), one job builds the app, runs the migrations against Supabase, deploys the worker over SSH (`scripts/deploy-worker.sh`: the build to `DEPLOY_PATH/releases/<commit>`, `npm ci --omit=dev` there, PM2 restart), then the web API to Beanstalk (`scripts/deploy-eb.sh`: an S3 bundle, a new application version, a rolling update, and a wait until the environment is Ready and on that version; Beanstalk's recent events are printed either way). AWS access is OIDC (an IAM role that trusts only this repo's `main`), so no AWS keys are stored in GitHub. Set up once:

1. On the worker host, as the deploy user: `ssh-keygen -t ed25519 -f bodhira-deploy -N ''`, append `bodhira-deploy.pub` to `~/.ssh/authorized_keys`, copy the private key into GitHub (below), then delete both files. Put the app's `.env` in `DEPLOY_PATH` (owned by the deploy user, `chmod 600`).
2. The host's security group allows SSH (22) from GitHub's runners. Their IPs change; either allow 0.0.0.0/0 with key-only login (`PasswordAuthentication no`), or use a self-hosted runner / bastion inside the VPC.
3. GitHub → Settings → Environments → `production`:
   - secret `WORKER_SSH_KEY` (the private key);
   - variables `WORKER_SSH_HOST`, `WORKER_SSH_USER`, `WORKER_SSH_KNOWN_HOSTS` (`ssh-keyscan -t ed25519 <host>`), `DEPLOY_PATH` (e.g. `/opt/bodhiraai-api`), optional `WORKER_SSH_PORT`.
   - secret `MIGRATE_DATABASE_URL` (the session pooler URL, port 5432);
   - variables `AWS_ROLE_ARN`, `AWS_REGION`, `EB_APPLICATION`, `EB_ENVIRONMENT`.
   - Optional: add yourself as a required reviewer to approve each deploy.
4. AWS (once): IAM → Identity providers → OpenID Connect `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`; a role trusting it for `repo:aveniqinnovations/ba-api:environment:production` with `AdministratorAccess-AWSElasticBeanstalk` (it also writes the bundle to Beanstalk's S3 bucket). Its ARN is `AWS_ROLE_ARN`.

`scripts/deploy.sh` stays as the manual fallback (same order, from your machine with the EB CLI).

## 7. Operations

- **Logs:** `.ebextensions/01-bodhira.config` streams instance logs to CloudWatch Logs (`/aws/elasticbeanstalk/<env>/…`), kept **30 days** and kept when the environment is terminated. 30 days is a default to confirm (cost vs. how far back incidents need to be traced); change `RetentionInDays` there. `eb logs` still works for the last few hundred lines. The instance profile needs `logs:CreateLogStream`/`PutLogEvents` (Beanstalk's default `aws-elasticbeanstalk-ec2-role` has them).
- **Scale:** web 1–10 instances on CPU (`.ebextensions`: up above 60 %, down below 25 %), or `eb scale <n>`. The worker is one EC2 instance; for more job throughput raise `WORKER_CONCURRENCY` (and its `DB_POOL_MAX` with it) before adding a second worker host.
- **Database shell:** `psql "<session pooler URL>"`, or Supabase's SQL editor.
- **Backups:** Supabase daily backups (Pro plan; add point-in-time recovery for production), plus a `pg_dump` over the session pooler before every cut-over or risky migration.
- **Background jobs** (worker host): `pm2 logs bodhira-worker` (files in `~/.pm2/logs/`, rotated by pm2-logrotate). Each attempt logs one line, `job=<name> id=<id> attempt=<n>/<max> status=done|failed ms=<ms>` (no personal data: ids only, email addresses masked in errors); a last failed attempt logs at error level. Retries back off exponentially (`JOB_POLICY` in `src/jobs/jobs.service.ts`); failed jobs are kept 14 days. Ship `~/.pm2/logs/` to CloudWatch with the CloudWatch agent if you want alarms on `status=failed`. After fixing the cause, retry every failed job from the worker host:
  ```bash
  cd /opt/bodhiraai-api/current && node --env-file=.env -e "new (require('bullmq').Queue)('jobs',{prefix:'bodhira',connection:{url:process.env.REDIS_URL}}).retryJobs({state:'failed'}).then(()=>process.exit(0))"
  ```
  A video import that failed for good has already marked its lesson `video_status: failed` (the editor sees "upload it again"); retrying it does nothing.
