#!/usr/bin/env bash
# Verify that Node's sealForDevice -> Swift CryptoKit's ChaChaPoly.open round-trips.
# Guards the payload contract ahead of the Phase 3 NSE implementation. macOS only.
set -euo pipefail
cd "$(dirname "$0")/.."

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

PLAIN='{"v":1,"type":"permission_requested","sessionId":"test","body":"Requesting permission to run Bash"}'

./packages/server/node_modules/.bin/tsx -e "
import crypto from 'node:crypto';
import { sealForDevice } from './packages/server/src/crypto.ts';
const key = crypto.randomBytes(32).toString('base64');
console.log(key);
console.log(sealForDevice(key, process.argv[1]));
" "$PLAIN" > "$TMP/sealed.txt"

KEY=$(sed -n '1p' "$TMP/sealed.txt")
BLOB=$(sed -n '2p' "$TMP/sealed.txt")

swift scripts/cryptokit-check.swift "$KEY" "$BLOB" > "$TMP/opened.txt"

if [ "$(cat "$TMP/opened.txt")" = "$PLAIN" ]; then
  echo "OK: CryptoKit decrypted Node's sealed blob (the Phase 3 NSE only needs ChaChaPoly.open)"
else
  echo "NG: decrypted output does not match"
  echo "expected: $PLAIN"
  echo "actual  : $(cat "$TMP/opened.txt")"
  exit 1
fi
