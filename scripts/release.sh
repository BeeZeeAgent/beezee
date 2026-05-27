#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(node -e "console.log(require('./package.json').version)")
echo ">>> Releasing BeeZee v$VERSION"

# Stop any running server so the native bun compile can bind the port
SERVER_PID=$(lsof -ti :4242 2>/dev/null || true)
if [[ -n "$SERVER_PID" ]]; then
  echo ">>> Stopping server (PID $SERVER_PID)"
  kill "$SERVER_PID"
  sleep 1
fi

echo ">>> Building frontend"
cd frontend && npm run build && cd ..

echo ">>> Embedding frontend"
node scripts/embed-frontend.js

echo ">>> Compiling binaries"
bun build --compile --target=bun-linux-arm64  server.js --outfile beezee-linux-arm64  &
bun build --compile --target=bun-linux-x64    server.js --outfile beezee-linux-x64    &
bun build --compile --target=bun-darwin-arm64 server.js --outfile beezee-darwin-arm64 &
bun build --compile --target=bun-darwin-x64   server.js --outfile beezee-darwin-x64   &
node scripts/bundle-windows.js &
wait
echo ">>> All binaries compiled"

echo ">>> Restarting server"
nohup ./beezee-linux-arm64 > /tmp/beezee-server.log 2>&1 &
sleep 2
curl -sf http://localhost:4242/api/update/check | grep -o '"currentVersion":"[^"]*"'

echo ">>> Updating GitHub release v$VERSION"
gh release delete "v$VERSION" --yes 2>/dev/null || true
git tag -d "v$VERSION" 2>/dev/null || true
git tag "v$VERSION"
git push origin "v$VERSION" --force

gh release create "v$VERSION" \
  beezee-linux-arm64 \
  beezee-linux-x64 \
  beezee-darwin-arm64 \
  beezee-darwin-x64 \
  dist/beezee-windows-x64.zip \
  --title "v$VERSION" \
  --notes "$(gh release view "v$VERSION" --json body -q .body 2>/dev/null || echo "Release v$VERSION")"

echo ">>> Done — v$VERSION released"
