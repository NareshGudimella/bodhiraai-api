#!/usr/bin/env bash
# Deploys the commit checked out here to Elastic Beanstalk (see DEPLOY.md §6):
#   1. refuses uncommitted changes or a commit that isn't on the remote
#   2. lint, unit tests, build
#   3. migrations against Supabase from here, at this same commit
#   4. the background-job worker on the worker host (SSH), before the API
#   5. eb deploy, labelled with the commit, then a ping through Cloudflare
#
#   MIGRATE_DATABASE_URL='postgresql://…:5432/postgres?uselibpqcompat=true&sslmode=require' \
#     WORKER_HOST=bodhira-worker [EB_ENV=bodhiraai-api-prod] [SITE_URL=https://bodhiraai.com] scripts/deploy.sh
#
# WORKER_HOST is an ssh destination (e.g. a ~/.ssh/config entry) for the worker
# host set up as in DEPLOY.md §4; SKIP_WORKER=1 deploys the API only.
#
# MIGRATE_DATABASE_URL is Supabase's *session* pooler (port 5432): migrations need a
# session, which the transaction pooler (6543, the app's DATABASE_URL) doesn't keep.
#
# Needs the AWS CLI and EB CLI configured for the account. Draft: not yet run
# against AWS.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${MIGRATE_DATABASE_URL:?set MIGRATE_DATABASE_URL to the Supabase session pooler URL (port 5432)}"
EB_ENV="${EB_ENV:-}"
if [ -z "${WORKER_HOST:-}" ] && [ "${SKIP_WORKER:-}" != 1 ]; then
  echo "Set WORKER_HOST (the worker host's ssh destination), or SKIP_WORKER=1 to deploy the API only." >&2
  exit 1
fi
SITE_URL="${SITE_URL:-https://bodhiraai.com}"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Uncommitted changes: commit or stash them first." >&2
  exit 1
fi
SHA="$(git rev-parse HEAD)"
git fetch --quiet origin
if [ -z "$(git branch -r --contains "$SHA")" ]; then
  echo "Commit $SHA isn't on origin: push it first (deploys are of pushed commits only)." >&2
  exit 1
fi

echo "== Checks ($SHA)"
npm ci
npx eslint "{src,apps,libs,test}/**/*.ts"
npm test
npm run build

echo "== Migrations (Supabase)"
# A failure stops here, so nothing is deployed against an unmigrated database.
DATABASE_URL="$MIGRATE_DATABASE_URL" npm run db:migrate

if [ "${SKIP_WORKER:-}" != 1 ]; then
  # Before the API: the new worker runs jobs from old and new API instances alike.
  scripts/deploy-worker.sh "$WORKER_HOST" "$SHA"
fi

echo "== eb deploy"
eb deploy ${EB_ENV:+"$EB_ENV"} --label "${SHA:0:12}-$(date +%Y%m%d%H%M%S)"

echo "== Ping"
curl -fsS "$SITE_URL/api/v1/ping"
echo
