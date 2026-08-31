#!/usr/bin/env bash
# Manual smoke test using the real codex (not run in CI).
# Prerequisites: tinyd running (new code). A Codex profile (agent=codex) logged in:
#   ./node_modules/.bin/tsx src/cli.ts profiles add cx --agent codex
#   cp ~/.codex/auth.json ~/.tiny/profiles/cx/auth.json   (do not copy config.toml; it carries notification hooks etc.)
# One loop: create (ask) -> bash (a permission request may not appear; allow it if it does) -> complete -> send_user_file ->
#           interrupt -> resume (does it remember history?) -> show attach command -> usage
set -euo pipefail
cd "$(dirname "$0")/../packages/server"

TOKEN=$(cat "${TINY_HOME:-$HOME/.tiny}/secret")
PORT="${TINY_PORT:-7777}"
BASE="http://127.0.0.1:$PORT"
AUTH="Authorization: Bearer $TOKEN"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
SMOKE_CWD="${SMOKE_CWD:-$HOME/.tiny/smoke-codex}"
mkdir -p "$SMOKE_CWD"
if [ ! -d "$SMOKE_CWD/.git" ]; then
  git init -q "$SMOKE_CWD"
fi
PROFILE="${SMOKE_PROFILE:-cx}"

events() { curl -sf "$BASE/v1/sessions/$SID/events?since=0" -H "$AUTH" > "$TMP/events.json"; }
count() { node -e "const es=JSON.parse(require('fs').readFileSync('$TMP/events.json')).events; console.log(es.filter(e=>e.type==='$1').length)"; }
wait_for() { # $1=type $2=count $3=max seconds
  for i in $(seq 1 "$3"); do sleep 1; events; [ "$(count "$1")" -ge "$2" ] && return 0; done
  return 1
}
# Right after turn_completed the status may still be running (the next POST would 409) -> wait for idle
wait_idle() { for j in $(seq 1 30); do curl -sf "$BASE/v1/sessions/$SID" -H "$AUTH" > "$TMP/s.json" && node -e "process.exit(JSON.parse(require('fs').readFileSync('$TMP/s.json')).status==='idle'?0:1)" && return 0; sleep 1; done; }
terminals() { node -e "const es=JSON.parse(require('fs').readFileSync('$TMP/events.json')).events; console.log(es.filter(e=>e.type==='turn_completed'||e.type==='turn_failed').length)"; }
wait_terminal() { for i in $(seq 1 "$2"); do sleep 1; events; if [ "$(terminals)" -ge "$1" ]; then wait_idle; return 0; fi; done; echo "NG: turn never finished"; node -e "for (const e of JSON.parse(require('fs').readFileSync('$TMP/events.json')).events) console.log(e.type, JSON.stringify(e.payload).slice(0,120))"; exit 1; }

echo "== 1. Check profile"
curl -sf "$BASE/v1/profiles" -H "$AUTH" > "$TMP/profiles.json"
node -e "const p=JSON.parse(require('fs').readFileSync('$TMP/profiles.json')).profiles.find(x=>x.name==='$PROFILE'); if(!p){console.error('NG: profile $PROFILE not found');process.exit(1)} if(p.agent!=='codex'){console.error('NG: agent is not codex');process.exit(1)} if(!p.loggedIn){console.error('NG: not logged in (auth.json missing)');process.exit(1)} console.log('profile:', p.name, p.label, 'modes:', p.capabilities.permissionModes.map(m=>m.id).join('/'), 'usage:', p.capabilities.features.usage)"

echo "== 2. Create session (ask)"
curl -sf -X POST "$BASE/v1/sessions" -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"profile\":\"$PROFILE\",\"cwd\":\"$SMOKE_CWD\",\"permissionMode\":\"ask\"}" > "$TMP/sess.json"
SID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$TMP/sess.json')).id)")
echo "session: $SID"

echo "== 3. bash (a permission request may not appear; observed: safe commands auto-approve even on-request)"
curl -sf -X POST "$BASE/v1/sessions/$SID/turns" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"prompt":"Run exactly: echo tiny-smoke-ok . Then reply with only the word: done"}' > /dev/null
PERMISSION_SEEN=0
for i in $(seq 1 90); do
  sleep 1
  events
  if [ "$(count permission_requested)" -ge 1 ]; then PERMISSION_SEEN=1; break; fi
  if [ "$(terminals)" -ge 1 ]; then break; fi
done
if [ "$PERMISSION_SEEN" -eq 1 ]; then
  curl -sf "$BASE/v1/sessions/$SID/permissions" -H "$AUTH" > "$TMP/pending.json"
  REQ=$(node -e "const p=JSON.parse(require('fs').readFileSync('$TMP/pending.json')).pending[0]; console.log(p.id); console.error('permission:', p.toolName, p.kind, p.summary)")
  curl -sf -X POST "$BASE/v1/permissions/$REQ" -H "$AUTH" -H 'Content-Type: application/json' -d '{"behavior":"allow"}' > /dev/null
fi
wait_terminal 1 90
node -e "
const es=JSON.parse(require('fs').readFileSync('$TMP/events.json')).events;
console.log(es.map(e=>e.type).join(' > '));
const c=es.find(e=>e.type==='turn_completed');
if(!c){console.error('NG: no turn_completed');process.exit(1)}
const tools=es.filter(e=>e.type==='tool_started');
const exec=tools.find(e=>e.payload.kind==='execute' && typeof e.payload.summary==='string' && e.payload.summary.includes('echo tiny-smoke-ok'));
if(!exec){console.error('NG: no tool_started with kind=execute and summary containing echo tiny-smoke-ok');process.exit(1)}
console.log('permission:', $PERMISSION_SEEN ? 'yes' : 'no');
console.log('OK: executed ->', c.payload.resultText, 'contextTokens:', c.payload.contextTokens)
"

echo "== 4. send_user_file (via tiny mcp-server; [mcp_servers.tiny] in ~/.tiny/profiles/$PROFILE/config.toml)"
REPORT="$SMOKE_CWD/smoke-report.html"
printf '<h1>tiny codex smoke</h1>\n' > "$REPORT"
curl -sf -X POST "$BASE/v1/sessions/$SID/turns" -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"Call the MCP tool send_user_file from the tiny server with path $REPORT and caption smoke. Do nothing else. Then reply with only the word: sent\"}" > /dev/null
wait_terminal 2 90
node -e "
const es=JSON.parse(require('fs').readFileSync('$TMP/events.json')).events;
const s=es.find(e=>e.type==='file_sent');
if(!s){console.error('NG: no file_sent');process.exit(1)}
const t=es.find(e=>e.type==='tool_started' && typeof e.payload.toolName==='string' && e.payload.toolName.includes('send_user_file'));
if(!t){console.error('NG: no tool_started with toolName containing send_user_file');process.exit(1)}
console.log('OK: file_sent', s.payload.mime, s.payload.caption)
"

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
echo "manual check: CODEX_HOME=$HOME/.tiny/profiles/$PROFILE codex resume $AGENT_SID"

echo "== 8. usage"
curl -sf "$BASE/v1/profiles/$PROFILE/usage" -H "$AUTH" > "$TMP/usage.json"
node -e "
const u=JSON.parse(require('fs').readFileSync('$TMP/usage.json'));
if(!Array.isArray(u.limits) || u.limits.length < 1){console.error('NG: no limits', JSON.stringify(u));process.exit(1)}
for (const l of u.limits) console.log('limit:', l.kind, l.percent + '%', 'resetsAt:', l.resetsAt);
console.log('OK: usage')
"

echo "ALL OK"
