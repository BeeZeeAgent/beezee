#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VPS_HOST="${VPS_HOST:-root@46.62.236.54}"
VPS_PATH="${VPS_PATH:-/opt/launchpad-cloud-relay}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/hetzner_new}"

SSH=(ssh)
RSYNC=(rsync -az --delete)
if [[ -n "$SSH_KEY" ]]; then
  SSH=(ssh -i "$SSH_KEY")
  RSYNC=(rsync -az --delete -e "ssh -i $SSH_KEY")
fi

echo ">>> Building cloud relay frontend"
(cd "$PROJECT_ROOT/web" && npm run build)

echo ">>> Syncing cloud relay to $VPS_HOST:$VPS_PATH"
"${SSH[@]}" "$VPS_HOST" "mkdir -p '$VPS_PATH'"
"${RSYNC[@]}" \
  --exclude=node_modules \
  --exclude=.env \
  --exclude=data/store.json \
  "$PROJECT_ROOT/" \
  "$VPS_HOST:$VPS_PATH/"

echo ">>> Building and restarting container"
"${SSH[@]}" "$VPS_HOST" "cd '$VPS_PATH' && if [ ! -f .env ]; then cp .env.example .env && secret=\$(openssl rand -hex 32) && sed -i \"s/replace-with-a-long-random-secret/\$secret/\" .env; fi && docker compose up -d --build"

echo ">>> Health check"
"${SSH[@]}" "$VPS_HOST" "cd '$VPS_PATH' && set -a && . ./.env && set +a && docker exec launchpad_cloud_relay node -e \"fetch('http://127.0.0.1:' + (process.env.PORT || '8789') + '/health').then(async r => { console.log(await r.text()); process.exit(r.ok ? 0 : 1); }).catch(err => { console.error(err); process.exit(1); })\""
