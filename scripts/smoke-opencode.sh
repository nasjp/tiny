#!/usr/bin/env bash
# OpenCode-specific shorthand. Delegates to scripts/smoke-acp.sh (generalized via SMOKE_AGENT).
SMOKE_PROFILE="${SMOKE_PROFILE:-oc}" SMOKE_AGENT=opencode exec "$(dirname "$0")/smoke-acp.sh"
