#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VPS_HOST="${VPS_HOST:?VPS_HOST is required (e.g. user@your-server)}"
VPS_PATH="${VPS_PATH:-/opt/beezee-relay}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_rsa}"

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
"${SSH[@]}" "$VPS_HOST" "cd '$VPS_PATH' && bash -s" <<'REMOTE'
set -euo pipefail

APP="launchpad_cloud_relay"
IMAGE="launchpad-cloud-relay:$(date +%Y%m%d%H%M%S)"
HOST_PORT="${HOST_PORT:-8788}"
APP_PORT="${PORT:-8789}"
DATA_DIR="$PWD/data"
CANDIDATE="${APP}_candidate"

if [ ! -f .env ]; then
  cp .env.example .env
  secret=$(openssl rand -hex 32)
  sed -i "s/replace-with-a-long-random-secret/$secret/" .env
fi
mkdir -p "$DATA_DIR"

echo ">>> Building image $IMAGE"
docker build -t "$IMAGE" .

active=""
for name in "${APP}_red" "${APP}_green" "$APP"; do
  if docker ps --format '{{.Names}}' | grep -qx "$name"; then
    active="$name"
    break
  fi
done

case "$active" in
  "${APP}_red") next="${APP}_green" ;;
  *) next="${APP}_red" ;;
esac

echo ">>> Starting candidate container"
docker rm -f "$CANDIDATE" >/dev/null 2>&1 || true
docker run -d \
  --name "$CANDIDATE" \
  --env-file .env \
  -e PORT="$APP_PORT" \
  -v "$DATA_DIR:/app/data" \
  "$IMAGE" >/dev/null

echo ">>> Candidate health check"
healthy=0
for _ in $(seq 1 30); do
  if docker exec "$CANDIDATE" node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '$APP_PORT') + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"; then
    healthy=1
    break
  fi
  sleep 1
done

if [ "$healthy" != "1" ]; then
  echo "Candidate failed health check; leaving active deployment untouched." >&2
  docker logs --tail 80 "$CANDIDATE" >&2 || true
  docker rm -f "$CANDIDATE" >/dev/null 2>&1 || true
  exit 1
fi

docker rm -f "$CANDIDATE" >/dev/null 2>&1 || true
docker rm -f "$next" >/dev/null 2>&1 || true

echo ">>> Switching traffic to $next"
if [ -n "$active" ]; then
  docker stop "$active" >/dev/null
fi

if ! docker run -d \
  --name "$next" \
  --restart unless-stopped \
  --env-file .env \
  -e PORT="$APP_PORT" \
  -p "$HOST_PORT:$APP_PORT" \
  -v "$DATA_DIR:/app/data" \
  "$IMAGE" >/dev/null; then
  echo "New container failed to start; rolling back to $active." >&2
  if [ -n "$active" ]; then docker start "$active" >/dev/null || true; fi
  exit 1
fi

switched=0
for _ in $(seq 1 30); do
  if docker exec "$next" node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '$APP_PORT') + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"; then
    switched=1
    break
  fi
  sleep 1
done

if [ "$switched" != "1" ]; then
  echo "New container failed post-switch health check; rolling back to $active." >&2
  docker logs --tail 80 "$next" >&2 || true
  docker rm -f "$next" >/dev/null 2>&1 || true
  if [ -n "$active" ]; then docker start "$active" >/dev/null || true; fi
  exit 1
fi

if [ -n "$active" ]; then
  docker rm "$active" >/dev/null 2>&1 || true
fi

docker image prune -f --filter "label!=keep" >/dev/null 2>&1 || true
echo "Active deployment: $next on :$HOST_PORT"
REMOTE

echo ">>> Health check"
"${SSH[@]}" "$VPS_HOST" "cd '$VPS_PATH' && active=\$(docker ps --format '{{.Names}}' | grep -E '^launchpad_cloud_relay_(red|green)$' | head -n1) && docker exec \"\$active\" node -e \"fetch('http://127.0.0.1:' + (process.env.PORT || '8789') + '/health').then(async r => { console.log(await r.text()); process.exit(r.ok ? 0 : 1); }).catch(err => { console.error(err); process.exit(1); })\""
