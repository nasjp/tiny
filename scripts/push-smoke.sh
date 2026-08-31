#!/usr/bin/env bash
# Exercise the tinyd -> relay -> APNs path without the real device app.
# Pairs one fake device, registers a nonexistent APNs token, pushes, and
# verifies the token is auto-invalidated after receiving BadDeviceToken.
# Prerequisites: tinyd running, `tiny push config --relay <url>` done
set -euo pipefail
cd "$(dirname "$0")/../packages/server"

TOKEN=$(cat "${TINY_HOME:-$HOME/.tiny}/secret")
PORT="${TINY_PORT:-7777}"
BASE="http://127.0.0.1:$PORT"
AUTH="Authorization: Bearer $TOKEN"
TMP=$(mktemp -d)
DEV_ID=""
# The fake device holds a valid bearerToken, so always delete it even on failure.
cleanup() {
  rm -rf "$TMP"
  if [ -n "$DEV_ID" ]; then
    node -e "
      const os = require('node:os');
      const path = require('node:path');
      const Database = require('./node_modules/better-sqlite3');
      const home = process.env.TINY_HOME || path.join(os.homedir(), '.tiny');
      const db = new Database(path.join(home, 'tiny.db'));
      db.prepare('DELETE FROM devices WHERE id = ?').run('$DEV_ID');
      db.close();
    " && echo "cleanup: deleted fake device $DEV_ID"
  fi
}
trap cleanup EXIT

echo "== 1. Check config"
./node_modules/.bin/tsx src/cli.ts push config

echo "== 2. Pair a fake device"
curl -sf -X POST "$BASE/v1/pair/start" -H "$AUTH" -o "$TMP/pair.json"
CODE=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$TMP/pair.json')).code)")
curl -sf -X POST "$BASE/v1/devices" -H 'Content-Type: application/json' \
  -d "{\"code\":\"$CODE\",\"name\":\"push-smoke\"}" -o "$TMP/dev.json"
DEV_TOKEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$TMP/dev.json')).bearerToken)")
DEV_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$TMP/dev.json')).deviceId)")
echo "device: $DEV_ID"

echo "== 3. Register a nonexistent APNs token (sandbox)"
BOGUS=$(printf 'b%.0s' $(seq 1 64))
curl -sf -X PATCH "$BASE/v1/devices/me" \
  -H "Authorization: Bearer $DEV_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"apnsToken\":\"$BOGUS\",\"apnsEnv\":\"sandbox\"}" -o "$TMP/patch.json"
./node_modules/.bin/tsx src/cli.ts devices

echo "== 4. Test notification"
./node_modules/.bin/tsx src/cli.ts push test

echo "== 5. Token must now be invalidated (unregistered)"
./node_modules/.bin/tsx src/cli.ts devices
curl -sf "$BASE/v1/devices" -H "$AUTH" -o "$TMP/devices.json"
node -e "
const d = JSON.parse(require('fs').readFileSync('$TMP/devices.json')).devices.find(x => x.id === '$DEV_ID');
if (!d) { console.error('device not found'); process.exit(1); }
if (d.hasApnsToken) { console.error('NG: token remains despite receiving BadDeviceToken'); process.exit(1); }
console.log('OK: invalidated token was cleaned up automatically');
"
