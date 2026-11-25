#!/usr/bin/env bash
# Deploys the built worker (dist/) to the worker host over SSH and restarts it
# under PM2 (DEPLOY.md §4, §6). Used by scripts/deploy.sh and by the GitHub
# Actions workflow .github/workflows/deploy-worker.yml.
#
#   scripts/deploy-worker.sh <ssh-destination> <commit-sha>
#
# Run `npm run build` first. DEPLOY_PATH: the app's folder on the host (default
# /opt/bodhiraai-api); it holds releases/, current and the .env. The host needs
# Node 22+, PM2 and $DEPLOY_PATH/.env.
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${1:?usage: scripts/deploy-worker.sh <ssh-destination> <commit-sha>}"
SHA="${2:?usage: scripts/deploy-worker.sh <ssh-destination> <commit-sha>}"
[ -f dist/main.js ] || { echo "dist/main.js missing: run npm run build first." >&2; exit 1; }

ROOT="${DEPLOY_PATH:-/opt/bodhiraai-api}"
REL="$ROOT/releases/${SHA:0:12}"
echo "== Worker ($HOST:$ROOT, ${SHA:0:12})"
ssh "$HOST" "mkdir -p $REL"
rsync -az --delete dist assets package.json package-lock.json ecosystem.worker.config.js "$HOST:$REL/"
# The old worker stops gracefully (running jobs finish, up to kill_timeout), then the
# new release starts from its own directory; fails if it isn't online.
ssh "$HOST" "set -e; cd $REL; npm ci --omit=dev --silent
  test -f $ROOT/.env || { echo 'Missing $ROOT/.env on the worker host' >&2; exit 1; }
  ln -sfn $ROOT/.env $REL/.env
  ln -sfn $REL $ROOT/current
  pm2 delete bodhira-worker >/dev/null 2>&1 || true
  pm2 start $REL/ecosystem.worker.config.js && pm2 save
  sleep 5; pm2 jlist | node -e \"const a=JSON.parse(require('fs').readFileSync(0)).find(p=>p.name==='bodhira-worker');process.exit(a&&a.pm2_env.status==='online'?0:1)\" || { pm2 logs bodhira-worker --nostream --lines 30; exit 1; }
  ls -dt $ROOT/releases/* | tail -n +4 | xargs -r rm -rf"
echo "Worker online."
