#!/usr/bin/env bash
# Verify that no identifiers or secrets unfit for a public repo are under git control.
#   bash scripts/check-public.sh            # current tree (tracked files at HEAD). exit 0 when hits are 0
#   bash scripts/check-public.sh --history  # informational scan of the full history (git log -p --all); author lines excluded
# Exclusions: pnpm-lock.yaml / .secrets (gitignored). apps/ios is also scanned since 2026-08-30 (Phase F)
#   - after real Tailscale IPs were replaced with synthetic values. The Team ID stays by user decision, so it is not on the identifier list
#
# Three stages: (1) SECRET_PATTERNS = shapes of secrets themselves (2) SHAPE_PATTERNS = "shapes"
# of device UDIDs, local absolute paths, etc. (also catch values not yet known)
# (3) IDENT_PATTERNS = the fixed list of real values in .secrets.
# Identifier patterns are read from .secrets/check-public.patterns (gitignored; not in this repo).
#   - One extended regex (-E) per line. Blank lines and lines starting with `#` are ignored.
#   - If the file is missing, the identifier check is skipped and only SECRET_PATTERNS decide (can still exit 0).
#   - For what belongs in that file (APNs Key ID, Cloudflare account_id, the owner's Gmail,
#     ASC API Key ID, real Tailscale IPs, absolute home paths, etc.) see HANDOFF.md and the maintainer's memory.
set -u
cd "$(dirname "$0")/.."

PATTERNS_FILE=".secrets/check-public.patterns"

# Patterns that catch by "shape". Unlike the fixed list in .secrets, they also hit values not yet known.
# In the 2026-08-30 pre-publication audit, the fixed list alone let device UDIDs, devicectl IDs,
# and agent scratchpad absolute paths slip through (3 cases, since cleaned up).
SHAPE_PATTERNS=(
  '0000[0-9A-F]{4}-[0-9A-F]{16}'                 # iPhone UDID (ECID format)
  '(--device|udid|UDID)[ =:"]+[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}'  # devicectl device ID
  '/private/tmp/claude-|/var/folders/[a-z0-9_]+/'    # agent/OS scratchpad absolute paths
  '-Users-[A-Za-z0-9._-]+-'                          # macOS username from a path (slashes flattened to -)
  '/Users/[A-Za-z0-9._-]+/'                          # real home paths (synthetic names excluded via SYNTHETIC_HOMES below)
  'DerivedData/[A-Za-z0-9]+-[a-z]{20,}'              # real DerivedData hashes
  'claude\.ai/code/session_[A-Za-z0-9]{10,}'         # Claude session URLs (from commit trailers)
)

# Synthetic home names allowed in docs and tests. Any name not listed here counts as a real one
SYNTHETIC_HOMES='/Users/(u|you|x|a|me|alice|bob|USER|<[^>]+>)/'

# Secrets themselves (if found, consider scrubbing them from history)
SECRET_PATTERNS=(
  'MIG[HI]A[A-Za-z0-9+/=]{40,}'  # real PEM base64 (P-256/RSA pkcs8 prefix; template "..." or AQID do not match)
  'sk-ant-[A-Za-z0-9_-]{20,}'
  'gh[pousr]_[A-Za-z0-9]{30,}'
  'npm_[A-Za-z0-9]{30,}'
  'xox[bpa]-[A-Za-z0-9-]{20,}'
  'AKIA[0-9A-Z]{16}'
  'eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}'
)

IDENT_PATTERNS=()
if [ -f "$PATTERNS_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    IDENT_PATTERNS+=("$line")
  done < "$PATTERNS_FILE"
else
  echo "warn: .secrets/check-public.patterns is missing; skipping the identifier check (secret patterns only)"
fi

hits=0
if [ "${1:-}" = "--history" ]; then
  echo "== full history (patch bodies only; commit headers excluded)"
  for p in "${SECRET_PATTERNS[@]}" ${IDENT_PATTERNS[@]+"${IDENT_PATTERNS[@]}"}; do
    n=$(git log -p --all --format= --no-color | grep -c -E -- "$p" || true)
    [ "$n" -gt 0 ] && { echo "  $n  $p"; hits=$((hits + n)); }
  done
  echo "(identifiers stay in history unless it is rewritten. The Gmail address is also in git author -> see the pre-publication checklist)"
  exit 0
fi

for p in "${SECRET_PATTERNS[@]}" ${IDENT_PATTERNS[@]+"${IDENT_PATTERNS[@]}"}; do
  out=$(git grep -n -I -E -- "$p" -- . ':!pnpm-lock.yaml' || true)
  if [ -n "$out" ]; then
    echo "NG  $p"; echo "$out" | sed 's/^/    /'; hits=$((hits + 1))
  fi
done

# The shape-based pass. Excludes synthetic home names and this check's own definition lines
for p in "${SHAPE_PATTERNS[@]}"; do
  out=$(git grep -n -I -E -- "$p" -- . ':!pnpm-lock.yaml' ':!scripts/check-public.sh' \
        | grep -vE "$SYNTHETIC_HOMES" || true)
  if [ -n "$out" ]; then
    echo "NG(shape) $p"; echo "$out" | sed 's/^/    /'; hits=$((hits + 1))
  fi
done
if [ "$hits" -eq 0 ]; then echo "OK: no publication-sensitive identifiers or secrets in tracked files"; exit 0; fi
echo "NG: $hits patterns hit"; exit 1
