#!/usr/bin/env bash
# Manual smoke test using real claude. Not run in CI.
# Prereq: tiny profiles add work && tiny profiles login work done, tinyd running
set -euo pipefail
cd "$(dirname "$0")/../packages/server"

TOKEN=$(cat "${TINY_HOME:-$HOME/.tiny}/secret")
PORT="${TINY_PORT:-7777}"
BASE="http://127.0.0.1:$PORT"
AUTH="Authorization: Bearer $TOKEN"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
SMOKE_CWD="${SMOKE_CWD:-$HOME/.tiny/smoke-work}"
mkdir -p "$SMOKE_CWD"

echo "== 1. health / agents / profiles"
curl -sf "$BASE/v1/health" > "$TMP/health.json"
cat "$TMP/health.json"; echo
curl -sf "$BASE/v1/agents" -H "$AUTH" > "$TMP/agents.json"
cat "$TMP/agents.json"; echo
curl -sf "$BASE/v1/profiles" -H "$AUTH" > "$TMP/profiles.json"
# Profile comes from SMOKE_PROFILE, else the first logged-in one
# Profile comes from SMOKE_PROFILE, else the first logged-in claude profile (never pick another agent's profile)
PROFILE="${SMOKE_PROFILE:-$(node -e "const p=JSON.parse(require('fs').readFileSync('$TMP/profiles.json')).profiles.find(x=>x.loggedIn && x.agent==='claude'); console.log(p?p.name:'')")}"
[ -n "$PROFILE" ] || { echo "no logged-in profile"; exit 1; }
echo "profile: $PROFILE"
node -e "const p=JSON.parse(require('fs').readFileSync('$TMP/profiles.json')).profiles.find(x=>x.name==='$PROFILE'); console.log('agent:', p.agent, p.label, 'models:', p.capabilities.models.length, 'modes:', p.capabilities.permissionModes.map(m=>m.id).join('/'))"

echo "== 2. Create session"
curl -sf -X POST "$BASE/v1/sessions" -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"profile\":\"$PROFILE\",\"cwd\":\"$SMOKE_CWD\",\"permissionMode\":\"acceptEdits\"}" > "$TMP/sess.json"
SID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$TMP/sess.json')).id)")
echo "session: $SID"

echo "== 3. Run a turn (real claude, subscription quota)"
curl -sf -X POST "$BASE/v1/sessions/$SID/turns" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"prompt":"Compute 1+1 and reply with only the answer"}'
echo "Running... polling events"
for i in $(seq 1 60); do
  sleep 2
  curl -sf "$BASE/v1/sessions/$SID/events?since=0" -H "$AUTH" > "$TMP/events.json"
  if grep -q 'turn_completed\|turn_failed' "$TMP/events.json"; then break; fi
done
node -e "for (const e of JSON.parse(require('fs').readFileSync('$TMP/events.json')).events) console.log(e.type)"
# Right after turn_completed the status may still be running (the next POST would 409) -> wait for idle
for i in $(seq 1 30); do curl -sf "$BASE/v1/sessions/$SID" -H "$AUTH" > "$TMP/s.json"; node -e "process.exit(JSON.parse(require('fs').readFileSync('$TMP/s.json')).status==='idle'?0:1)" && break; sleep 1; done

echo "== 4. send_user_file (via tiny mcp-server)"
REPORT="$SMOKE_CWD/smoke-report.html"
rm -f "$REPORT"
curl -sf -X POST "$BASE/v1/sessions/$SID/turns" -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"Write the file $REPORT containing exactly <h1>tiny smoke</h1> and then call the send_user_file tool with path $REPORT and caption smoke. Reply with just: sent\"}"
echo "Running... waiting for file_sent"
for i in $(seq 1 90); do
  sleep 2
  curl -sf "$BASE/v1/sessions/$SID/events?since=0" -H "$AUTH" > "$TMP/events2.json"
  if node -e "const es=JSON.parse(require('fs').readFileSync('$TMP/events2.json')).events; const done=es.filter(e=>e.type==='turn_completed'||e.type==='turn_failed').length>=2; process.exit(done?0:1)"; then break; fi
done
node -e "
const es=JSON.parse(require('fs').readFileSync('$TMP/events2.json')).events;
const tools=es.filter(e=>e.type==='tool_started').map(e=>e.payload.toolName+'['+e.payload.kind+'] '+e.payload.summary);
console.log('tools:', tools.join(' | '));
const sent=es.find(e=>e.type==='file_sent');
if(!sent){ console.error('NG: no file_sent event'); process.exit(1); }
console.log('file_sent:', sent.payload.mime, sent.payload.caption, sent.payload.name);
if(!tools.some(t=>t.includes('['))){ console.error('NG: tool_started has no kind'); process.exit(1); }
console.log('OK: send_user_file via tiny mcp-server');
"

echo "== 5. Show attach command (for manual verification)"
AGENT_SID=$(curl -sf "$BASE/v1/sessions/$SID" -H "$AUTH" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).agentSessionId))")
echo "Manual check: tiny attach ${SID:0:8}  (from the repo: ./node_modules/.bin/tsx src/cli.ts attach ${SID:0:8})"
echo "(success if it opens claude --resume $AGENT_SID internally)"
