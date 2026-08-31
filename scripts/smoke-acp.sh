#!/usr/bin/env bash
# Generic manual smoke test using a real ACP agent (not run in CI).
# Prereq: tinyd running (new code). The target profile (agent=$SMOKE_AGENT) is logged in:
#   ./node_modules/.bin/tsx src/cli.ts profiles add <name> --agent <id>
#   ./node_modules/.bin/tsx src/cli.ts profiles login <name>
#   SMOKE_AGENT=<id> SMOKE_PROFILE=<name> bash scripts/smoke-acp.sh
# One loop: create (ask) -> bash triggers a permission request (skippable with SMOKE_EXPECT_PERMISSION=0) -> allow -> complete ->
#           send_user_file -> interrupt -> resume (does it remember history?) -> show attach command
set -euo pipefail
cd "$(dirname "$0")/../packages/server"

SMOKE_AGENT="${SMOKE_AGENT:-opencode}"
SMOKE_PROFILE="${SMOKE_PROFILE:-$SMOKE_AGENT}"
SMOKE_EXPECT_PERMISSION="${SMOKE_EXPECT_PERMISSION:-1}"

TOKEN=$(cat "${TINY_HOME:-$HOME/.tiny}/secret")
PORT="${TINY_PORT:-7777}"
BASE="http://127.0.0.1:$PORT"
AUTH="Authorization: Bearer $TOKEN"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
SMOKE_CWD="${SMOKE_CWD:-$HOME/.tiny/smoke-$SMOKE_AGENT}"
mkdir -p "$SMOKE_CWD"
PROFILE="$SMOKE_PROFILE"

events() { curl -sf "$BASE/v1/sessions/$SID/events?since=0" -H "$AUTH" > "$TMP/events.json"; }
count() { node -e "const es=JSON.parse(require('fs').readFileSync('$TMP/events.json')).events; console.log(es.filter(e=>e.type==='$1').length)"; }
wait_for() { # $1=type $2=count $3=max seconds
  for i in $(seq 1 "$3"); do sleep 1; events; [ "$(count "$1")" -ge "$2" ] && return 0; done
  echo "NG: $1 did not reach $2 occurrence(s)"; node -e "for (const e of JSON.parse(require('fs').readFileSync('$TMP/events.json')).events) console.log(e.type, JSON.stringify(e.payload).slice(0,120))"; exit 1
}
# Right after turn_completed the status may still be running (the next POST would 409) -> wait until idle
wait_idle() { for j in $(seq 1 30); do curl -sf "$BASE/v1/sessions/$SID" -H "$AUTH" > "$TMP/s.json" && node -e "process.exit(JSON.parse(require('fs').readFileSync('$TMP/s.json')).status==='idle'?0:1)" && return 0; sleep 1; done; }
terminals() { node -e "const es=JSON.parse(require('fs').readFileSync('$TMP/events.json')).events; console.log(es.filter(e=>e.type==='turn_completed'||e.type==='turn_failed').length)"; }
# Auto-allow permission requests that arrive while waiting (agents that ask permission for MCP tool calls = Cursor etc.)
allow_pending() {
  curl -sf "$BASE/v1/sessions/$SID/permissions" -H "$AUTH" > "$TMP/pending.json" || return 0
  for req in $(node -e "for (const p of JSON.parse(require('fs').readFileSync('$TMP/pending.json')).pending) console.log(p.id)"); do
    echo "  (auto-allow: $req)"
    curl -sf -X POST "$BASE/v1/permissions/$req" -H "$AUTH" -H 'Content-Type: application/json' -d '{"behavior":"allow"}' > /dev/null || true
  done
}
wait_terminal() { for i in $(seq 1 "$2"); do sleep 1; events; if [ "$(terminals)" -ge "$1" ]; then wait_idle; return 0; fi; allow_pending; done; echo "NG: turn never finished"; node -e "for (const e of JSON.parse(require('fs').readFileSync('$TMP/events.json')).events) console.log(e.type, JSON.stringify(e.payload).slice(0,120))"; exit 1; }

echo "== 1. Check profile"
curl -sf "$BASE/v1/profiles" -H "$AUTH" > "$TMP/profiles.json"
node -e "const p=JSON.parse(require('fs').readFileSync('$TMP/profiles.json')).profiles.find(x=>x.name==='$PROFILE'); if(!p){console.error('NG: profile $PROFILE not found');process.exit(1)} if(p.agent!=='$SMOKE_AGENT'){console.error('NG: agent is not $SMOKE_AGENT');process.exit(1)} if(!p.loggedIn){console.error('NG: not logged in (auth file missing)');process.exit(1)} console.log('profile:', p.name, p.label, 'modes:', p.capabilities.permissionModes.map(m=>m.id).join('/'), 'usage:', p.capabilities.features.usage)"

echo "== 2. Create session (ask)"
curl -sf -X POST "$BASE/v1/sessions" -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"profile\":\"$PROFILE\",\"cwd\":\"$SMOKE_CWD\",\"permissionMode\":\"ask\"}" > "$TMP/sess.json"
SID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$TMP/sess.json')).id)")
echo "session: $SID"

echo "== 3. bash -> permission request -> allow"
curl -sf -X POST "$BASE/v1/sessions/$SID/turns" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"prompt":"Use your bash tool to run exactly: echo tiny-smoke-ok . Then reply with only the word: done"}' > /dev/null
if [ "$SMOKE_EXPECT_PERMISSION" -eq 1 ]; then
  wait_for permission_requested 1 90
  curl -sf "$BASE/v1/sessions/$SID/permissions" -H "$AUTH" > "$TMP/pending.json"
  REQ=$(node -e "const p=JSON.parse(require('fs').readFileSync('$TMP/pending.json')).pending[0]; console.log(p.id); console.error('permission:', p.toolName, p.kind, p.summary)")
  curl -sf -X POST "$BASE/v1/permissions/$REQ" -H "$AUTH" -H 'Content-Type: application/json' -d '{"behavior":"allow"}' > /dev/null
fi
wait_terminal 1 90
node -e "
const es=JSON.parse(require('fs').readFileSync('$TMP/events.json')).events;
console.log(es.map(e=>e.type).join(' > '));
const t=es.find(e=>e.type==='tool_started');
if(!t||!t.payload.kind){console.error('NG: tool_started has no kind');process.exit(1)}
const c=es.find(e=>e.type==='turn_completed');
if(!c){console.error('NG: no turn_completed event');process.exit(1)}
const seenPermission=es.some(e=>e.type==='permission_requested');
console.log('permission:', seenPermission ? 'yes' : 'no');
console.log('OK: allowed ->', c.payload.resultText, 'contextTokens:', c.payload.contextTokens)
"

echo "== 4. send_user_file (via tiny mcp-server)"
REPORT="$SMOKE_CWD/smoke-report.html"
printf '<h1>tiny %s smoke</h1>\n' "$SMOKE_AGENT" > "$REPORT"
curl -sf -X POST "$BASE/v1/sessions/$SID/turns" -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"Call the MCP tool send_user_file (from the tiny server) with path $REPORT and caption smoke. Do nothing else. Then reply with only the word: sent\"}" > /dev/null
wait_terminal 2 90
node -e "const es=JSON.parse(require('fs').readFileSync('$TMP/events.json')).events; const s=es.find(e=>e.type==='file_sent'); if(!s){console.error('NG: no file_sent event');process.exit(1)} console.log('OK: file_sent', s.payload.mime, s.payload.caption)"

echo "== 5. Interrupt"
curl -sf -X POST "$BASE/v1/sessions/$SID/turns" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"prompt":"Count from 1 to 500, one number per line, no other text."}' > /dev/null
sleep 4
curl -sf -X POST "$BASE/v1/sessions/$SID/interrupt" -H "$AUTH" > /dev/null
wait_terminal 3 30
node -e "const es=JSON.parse(require('fs').readFileSync('$TMP/events.json')).events; const last=es.filter(e=>e.type==='turn_completed'||e.type==='turn_failed').at(-1); if(last.type!=='turn_failed'||last.payload.error!=='interrupted'){console.error('NG: interrupt did not end as turn_failed{interrupted}', JSON.stringify(last));process.exit(1)} console.log('OK: interrupted')"

echo "== 6. resume (does it remember the previous turn?)"
curl -sf -X POST "$BASE/v1/sessions/$SID/turns" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"prompt":"Earlier in this session I asked you to run a shell command. What exact command was it? Reply with just the command."}' > /dev/null
wait_terminal 4 90
node -e "const es=JSON.parse(require('fs').readFileSync('$TMP/events.json')).events; const c=es.filter(e=>e.type==='turn_completed').at(-1); const t=c.payload.resultText||''; if(!t.includes('tiny-smoke-ok')){console.error('NG: resume does not remember history:', t);process.exit(1)} console.log('OK: resume ->', t)"

echo "== 7. attach command (for manual verification)"
curl -sf "$BASE/v1/sessions/$SID" -H "$AUTH" > "$TMP/s.json"
AGENT_SID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$TMP/s.json')).agentSessionId)")
echo "Manual check: tiny attach ${SID:0:8}  (from the repo: ./node_modules/.bin/tsx src/cli.ts attach ${SID:0:8})"
echo "(success if the $SMOKE_AGENT driver attaches by passing $AGENT_SID internally)"
echo "ALL OK"
