#!/usr/bin/env bash
# Update streamserver in place: pull main, install deps if needed, build UI, restart, check /health.
# Runs automatically after every merge into main (.github/workflows/deploy.yml on the self-hosted
# runner on mediaserver) and can be run by hand: /srv/storage/apps/streamserver/deploy.sh
set -euo pipefail

SERVICE="${SERVICE:-streamserver}"
cd "$(dirname "$(readlink -f "$0")")"

# Everything is inside main(): bash reads the whole function before running it, so `git pull`
# replacing this file mid-run is harmless. After the pull we re-run the *new* version of the script.
main() {
  if [ -z "${DEPLOY_PULLED:-}" ]; then
    local before
    before=$(git rev-parse HEAD)
    echo "==> git pull ($(git branch --show-current))"
    git pull --ff-only
    DEPLOY_PULLED=1 DEPLOY_BEFORE="$before" exec "$0" "$@"
  fi

  local before="${DEPLOY_BEFORE:-$(git rev-parse HEAD)}"
  local after
  after=$(git rev-parse HEAD)

  if [ ! -d node_modules ] || ! git diff --quiet "$before" "$after" -- package.json package-lock.json; then
    echo "==> npm ci (dependencies changed)"
    npm ci --no-audit --no-fund
  fi

  # Build into a new folder and swap: a failed build leaves the running UI untouched
  echo "==> build UI"
  rm -rf web/dist.new
  npm run build --silent -- --outDir dist.new
  rm -rf web/dist.old
  [ -d web/dist ] && mv web/dist web/dist.old
  mv web/dist.new web/dist
  rm -rf web/dist.old

  echo "==> restart $SERVICE"
  sudo /usr/bin/systemctl restart "$SERVICE"

  local port
  port=$(grep -E '^PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 || true)
  port="${port:-8090}"
  echo "==> health check on :$port"
  local code=""
  for _ in $(seq 1 30); do
    code=$(curl -s -o /tmp/streamserver-health.json -w '%{http_code}' "http://127.0.0.1:$port/health" || true)
    [ "$code" = "200" ] || [ "$code" = "503" ] && break
    sleep 1
  done

  case "$code" in
    200) ;;
    503)
      # the service runs, but something outside the code is wrong (e.g. the USB drive is not mounted)
      echo "!! $SERVICE is up but degraded: $(cat /tmp/streamserver-health.json)"
      ;;
    *)
      echo "!! $SERVICE did not answer on /health in 30s, last log lines:"
      journalctl -u "$SERVICE" -n 30 --no-pager || true
      exit 1
      ;;
  esac

  if [ "$before" = "$after" ]; then
    echo "==> OK, already up to date: $(git log -1 --format='%h %s')"
  else
    echo "==> OK, updated:"
    git log --format='   %h %s' "$before..$after"
  fi
}

main "$@"
