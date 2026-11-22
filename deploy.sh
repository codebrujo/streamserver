#!/usr/bin/env bash
# Update streamserver on the server: pull, install deps if needed, build UI, restart service.
# Usage: ./deploy.sh
set -euo pipefail

SERVICE="${SERVICE:-streamserver}"
cd "$(dirname "$(readlink -f "$0")")"

before=$(git rev-parse HEAD)
lock_before=$(sha1sum package-lock.json | cut -d' ' -f1)

echo "==> git pull ($(git branch --show-current))"
git pull --ff-only

if [ "$(sha1sum package-lock.json | cut -d' ' -f1)" != "$lock_before" ] || [ ! -d node_modules ]; then
  echo "==> npm install (dependencies changed)"
  npm install --no-audit --no-fund
fi

echo "==> build UI"
npm run build --silent

echo "==> restart $SERVICE"
sudo systemctl restart "$SERVICE"
sleep 2

if systemctl is-active --quiet "$SERVICE"; then
  after=$(git rev-parse HEAD)
  if [ "$before" = "$after" ]; then
    echo "==> OK, already up to date: $(git log -1 --format='%h %s')"
  else
    echo "==> OK, updated:"
    git log --format='   %h %s' "$before..$after"
  fi
else
  echo "!! $SERVICE failed to start, last log lines:"
  journalctl -u "$SERVICE" -n 20 --no-pager
  exit 1
fi
