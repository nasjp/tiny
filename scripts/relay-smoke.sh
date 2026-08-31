#!/usr/bin/env bash
# Send a nonexistent device token to the deployed relay and expect BadDeviceToken from APNs.
# Even without the real device app, this proves the JWT signing, TeamID, KeyID, topic, and HTTP/2 path.
#   - Broken auth would yield 403 InvalidProviderToken / ExpiredProviderToken
#   - A wrong topic would yield 400 BadTopic
# So BadDeviceToken means "everything except the device token is correct".
set -euo pipefail

RELAY_URL="${1:-${TINY_RELAY_URL:-}}"
if [ -z "$RELAY_URL" ]; then
  echo "usage: relay-smoke.sh <relay-url>   (e.g. https://tiny-push-relay.xxx.workers.dev)" >&2
  exit 2
fi
RELAY_URL="${RELAY_URL%/}"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "== 1. health"
# rtk mangles piped output, so write to a file instead of piping
curl -sS "$RELAY_URL/v1/health" -o "$TMP/health.json"
cat "$TMP/health.json"; echo

echo "== 2. push with a nonexistent token (sandbox)"
BOGUS=$(printf 'a%.0s' $(seq 1 64))
curl -sS -X POST "$RELAY_URL/v1/push" \
  -H 'Content-Type: application/json' \
  -d "{\"deviceToken\":\"$BOGUS\",\"apnsEnv\":\"sandbox\",\"payload\":\"c2VhbGVk\"}" \
  -o "$TMP/push.json"
cat "$TMP/push.json"; echo

if grep -q 'BadDeviceToken' "$TMP/push.json"; then
  echo "OK: reached APNs. JWT, TeamID, KeyID, topic, and HTTP/2 are all correct"
elif grep -q 'InvalidProviderToken\|ExpiredProviderToken' "$TMP/push.json"; then
  echo "NG: APNs rejected the auth. Check APNS_TEAM_ID / APNS_KEY_ID / APNS_SIGNING_KEY" >&2; exit 1
elif grep -q 'BadTopic\|TopicDisallowed' "$TMP/push.json"; then
  echo "NG: bad topic. Check vars.APNS_TOPIC in wrangler.jsonc" >&2; exit 1
else
  echo "NG: unexpected response" >&2; exit 1
fi
