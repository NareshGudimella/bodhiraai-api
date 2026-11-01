#!/usr/bin/env bash
# Deploys the commit checked out here to Elastic Beanstalk (see DEPLOY.md §6):
#   1. refuses uncommitted changes or a commit that isn't on the remote
#   2. lint, unit tests, build
#   3. migrations on the EC2 operations host, at this same commit (SSM)
#   4. eb deploy, labelled with the commit, then a ping through Cloudflare
#
#   OPS_INSTANCE_ID=i-0123... [EB_ENV=bodhiraai-api-prod] [SITE_URL=https://bodhiraai.com] scripts/deploy.sh
#
# Needs the AWS CLI and EB CLI configured for the account. Draft: not yet run
# against AWS.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${OPS_INSTANCE_ID:?set OPS_INSTANCE_ID to the EC2 operations host}"
EB_ENV="${EB_ENV:-}"
SITE_URL="${SITE_URL:-https://bodhiraai.com}"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Uncommitted changes: commit or stash them first." >&2
  exit 1
fi
SHA="$(git rev-parse HEAD)"
git fetch --quiet origin
if [ -z "$(git branch -r --contains "$SHA")" ]; then
  echo "Commit $SHA isn't on origin: push it first (the EC2 host checks it out)." >&2
  exit 1
fi

echo "== Checks ($SHA)"
npm ci
npx eslint "{src,apps,libs,test}/**/*.ts"
npm test
npm run build

echo "== Migrations on $OPS_INSTANCE_ID"
CMD_ID="$(aws ssm send-command \
  --instance-ids "$OPS_INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "bodhiraai-api migrate $SHA" \
  --parameters "commands=[\"set -e\",\"cd /opt/bodhiraai-api\",\"git fetch --quiet origin\",\"git checkout --quiet $SHA\",\"npm ci --silent\",\"npm run db:migrate\"]" \
  --query Command.CommandId --output text)"
aws ssm wait command-executed --command-id "$CMD_ID" --instance-id "$OPS_INSTANCE_ID" || true
STATUS="$(aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$OPS_INSTANCE_ID" --query Status --output text)"
aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$OPS_INSTANCE_ID" --query StandardOutputContent --output text | tail -20
if [ "$STATUS" != "Success" ]; then
  echo "Migrations failed ($STATUS); nothing deployed." >&2
  exit 1
fi

echo "== eb deploy"
eb deploy ${EB_ENV:+"$EB_ENV"} --label "${SHA:0:12}-$(date +%Y%m%d%H%M%S)"

echo "== Ping"
curl -fsS "$SITE_URL/api/v1/ping"
echo
