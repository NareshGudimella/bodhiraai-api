#!/usr/bin/env bash
# Deploys the built API (dist/) to Elastic Beanstalk with the AWS CLI and waits
# until the environment is Ready and Green on the new version (DEPLOY.md §6).
# Used by .github/workflows/deploy.yml. Run `npm run build` first; AWS
# credentials and region come from the environment.
#
#   scripts/deploy-eb.sh <application> <environment> <version-label>
#
# The bundle is what .ebignore lets `eb deploy` upload: dist/, assets/, package
# files, Procfile, .ebextensions/, .platform/. Dependencies install on the instance.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="${1:?usage: scripts/deploy-eb.sh <application> <environment> <version-label>}"
ENV_NAME="${2:?usage: scripts/deploy-eb.sh <application> <environment> <version-label>}"
LABEL="${3:?usage: scripts/deploy-eb.sh <application> <environment> <version-label>}"
[ -f dist/main.js ] || { echo "dist/main.js missing: run npm run build first." >&2; exit 1; }

# A wrong name or region otherwise fails only after the upload, with no hint.
FOUND="$(aws elasticbeanstalk describe-environments --application-name "$APP" --environment-names "$ENV_NAME" \
  --no-include-deleted --query 'Environments[0].EnvironmentName' --output text)"
if [ "$FOUND" != "$ENV_NAME" ]; then
  echo "::error::No Beanstalk environment $ENV_NAME in application $APP (region ${AWS_REGION:-default}). What exists there (application, environment, status):"
  aws elasticbeanstalk describe-environments --no-include-deleted \
    --query 'Environments[].[ApplicationName,EnvironmentName,Status]' --output text
  exit 1
fi

BUNDLE="$(mktemp -d)/$LABEL.zip"
zip -qr "$BUNDLE" dist assets package.json package-lock.json Procfile .ebextensions .platform
# Beanstalk's own bucket for this account and region (created once, then reused).
BUCKET="$(aws elasticbeanstalk create-storage-location --query S3Bucket --output text)"
KEY="$APP/$LABEL.zip"
echo "== Upload s3://$BUCKET/$KEY ($(du -h "$BUNDLE" | cut -f1))"
aws s3 cp --only-show-errors "$BUNDLE" "s3://$BUCKET/$KEY"

echo "== Version $LABEL"
aws elasticbeanstalk create-application-version --application-name "$APP" \
  --version-label "$LABEL" --description "${GITHUB_SHA:-manual} run ${GITHUB_RUN_ID:-local}" \
  --source-bundle "S3Bucket=$BUCKET,S3Key=$KEY" --process >/dev/null

echo "== Deploy to $ENV_NAME"
START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
aws elasticbeanstalk update-environment --environment-name "$ENV_NAME" --version-label "$LABEL" >/dev/null

# Rolling deploys take minutes; poll up to 30 min.
for _ in $(seq 1 90); do
  sleep 20
  read -r STATUS HEALTH VERSION < <(aws elasticbeanstalk describe-environments \
    --environment-names "$ENV_NAME" \
    --query 'Environments[0].[Status,Health,VersionLabel]' --output text)
  echo "   status=$STATUS health=$HEALTH version=$VERSION"
  [ "$STATUS" = Ready ] && break
done

events() {
  aws elasticbeanstalk describe-events --environment-name "$ENV_NAME" --start-time "$START" \
    --query 'Events[].[EventDate,Severity,Message]' --output text | sort | tail -n 25
}
if [ "$STATUS" != Ready ] || [ "$VERSION" != "$LABEL" ] || [ "$HEALTH" = Red ]; then
  echo "::error::Beanstalk deploy failed: status=$STATUS health=$HEALTH version=$VERSION (expected $LABEL)"
  events
  exit 1
fi
events
echo "Web API on $LABEL (health $HEALTH)."
