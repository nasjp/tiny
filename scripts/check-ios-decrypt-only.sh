#!/usr/bin/env bash
# Verify that the shipped iOS targets (Tiny / TinyNSE / Shared) contain no encryption.
#
# Why: the App Store export-compliance declaration ITSAppUsesNonExemptEncryption = false
# rests on Apple exemption (c), "limited to authentication, digital signatures, and
# decryption of data or files" (see the "Decisions (do not relitigate)" section of
# HANDOFF.md). The condition is that the shipped binary only decrypts, so bringing
# sealing (encryption) back into production source breaks that basis. The sealing used
# for tests lives in a helper on the TinyTests side.
#
#   bash scripts/check-ios-decrypt-only.sh
set -u
cd "$(dirname "$0")/.."

SRC="apps/ios/Tiny/Tiny apps/ios/Tiny/Shared apps/ios/Tiny/TinyNSE"

# Encryption call sites. SealedBox(combined:) reads an already-sealed box, i.e. the
# decryption side, so it is excluded. CryptoKit sealing APIs start with .seal(
# (both ChaChaPoly and AES.GCM)
PATTERNS=(
  '\.seal\('
  'SealedBox\(nonce:'
  'sealingKey|encrypt\('
)

hits=0
for p in "${PATTERNS[@]}"; do
  # Exclude comment lines (starting with /// or //)
  out=$(grep -rnE --include='*.swift' -- "$p" $SRC 2>/dev/null | grep -vE ':[0-9]+:[[:space:]]*(//|\*)' || true)
  if [ -n "$out" ]; then
    echo "NG  encryption-like call in a shipped target: $p"
    echo "$out" | sed 's/^/    /'
    hits=$((hits + 1))
  fi
done

if [ "$hits" -eq 0 ]; then
  echo "OK: crypto in the shipped iOS targets is decrypt-only"
  exit 0
fi
echo "NG: $hits patterns hit (breaks the export-compliance basis; see the Decisions section of HANDOFF)"
exit 1
