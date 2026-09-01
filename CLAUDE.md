# tiny — agent entry point (auto-loaded every session)

Monorepo for a tool that drives Claude Code on a Mac from an iPhone and hands sessions
back to the CLI (`tiny attach`).
**Read HANDOFF.md first** (maintainer-local, untracked — skip this if your clone does
not have it) — current position (phase progress), what to do next, and every
field-tested trap live there.
Design sources of truth are in `docs/superpowers/specs/`, implementation plans in
`docs/superpowers/plans/` (both maintainer-local and untracked, like HANDOFF.md). This
file only holds operating rules and tooling usage.

## Git rules (the law of this repo)

- **No PRs.** When a unit of work is done, merge it into main and push:
  1. Work on a branch (`git checkout -b <topic>`)
  2. Completion bar: all tests PASS + typecheck PASS (+ real-device check for anything
     that changes behavior)
  3. `git checkout main && git merge <topic>` → run the tests again after merging →
     `git push` → delete the branch
- Direct commits to main are allowed only for small changes such as docs or HANDOFF
  updates
- Commit messages are conventional commits in English (`feat:` `fix:` `docs:` ...)
- The remote is `git@github.com:nasjp/tiny.git` (private). If the agent shell has no
  ssh-agent and push fails:
  `git -c credential.helper='!gh auth git-credential' push https://github.com/nasjp/tiny.git main:main`

## Command quick reference

**Run everything from the repository root.** Only the two iOS commands need a `cd`
(marked below).

### Development

```bash
pnpm install
pnpm test        # tests for all packages (server + relay)
pnpm typecheck   # tsc --noEmit for all packages
pnpm build       # bundles the server with tsup into dist/cli.js (the distributed artifact; package.json bin points here)
```

### Running the tiny CLI from source

`pnpm tiny` = `tsx src/cli.ts` in `packages/server`. Append subcommands as-is.

```bash
pnpm tiny serve                       # run tinyd in the foreground
pnpm tiny daemon install              # run it under launchd
pnpm tiny setup                       # one path: prerequisites → profile → login → URL → daemon → QR
pnpm tiny doctor                      # environment diagnosis (no options; `setup` takes [--agent <id>] [--profile <name>])
pnpm tiny ls | new | attach <id>      # list / create / hand a session to the CLI
pnpm tiny handoff [--auto] [--ended] [--profile <name>] [--session <id>] [--config-dir <dir>]  # hand the current session to tiny (reverse of attach)
#   ^ run it from inside the Claude Code session you want to hand over, typed as `!tiny handoff`.
#     Asking the agent in prose misfires: `handoff` collides with a skill name and the skill runs instead.
pnpm tiny live [on|off] [--profile <name> | --config-dir <dir>]  # auto-handoff of new sessions (default off; claude = hooks in the targeted config dir, codex/opencode = `--profile <name>` turns on the tinyd storage scan)
pnpm tiny profiles ls | add <name> | rename <old> <new> | login <name>
pnpm tiny pair                        # show the pairing QR
pnpm tiny devices                     # list paired devices
pnpm tiny config                      # server URL embedded in the QR (mandatory over Tailscale)
pnpm tiny push config                 # show/change the relay URL and push on/off
pnpm tiny push test                   # send a test notification to every paired device
```

### Reinstalling the distributed build on this Mac

**The resident tinyd is the dist build installed via npm -g, so editing `src/` does not
affect it.** Verify changes through this path.

```bash
pnpm build
pnpm -C packages/server pack --pack-destination /tmp
npm i -g /tmp/nasjp-tiny-<version>.tgz
tiny daemon install    # after reinstalling, use the tiny on PATH (the dist build)
tiny doctor            # detects "plist points at a different tiny" / daemon version mismatch
```

### relay (Cloudflare Workers)

```bash
pnpm -C packages/relay run deploy   # `run` is mandatory (`pnpm deploy` collides with a pnpm built-in)
pnpm -C packages/relay run dev      # wrangler dev --remote (local workerd cannot reach APNs)
```

### iOS

```bash
cd apps/ios/Tiny && xcodegen generate    # mandatory after touching project.yml
cd apps/ios/Tiny && xcodebuild test -project Tiny.xcodeproj -scheme Tiny \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
```

### Smoke tests and checks

```bash
bash scripts/smoke.sh                    # one full loop with real claude
bash scripts/smoke-opencode.sh           # real opencode (profile oc)
bash scripts/smoke-codex.sh              # real codex (cx)
SMOKE_AGENT=<id> SMOKE_PROFILE=<name> bash scripts/smoke-acp.sh   # any ACP agent
bash scripts/check-public.sh             # no publish-hostile identifiers/secrets (always run right before publishing)
bash scripts/check-ios-decrypt-only.sh   # shipped iOS crypto is decrypt-only (export-compliance basis)
ACP_CMD="<cmd>" node scripts/acp-probe.mjs new    # probe ACP agents (new / cancel / resume <id> / load <id>)
node scripts/codex-probe.mjs             # probe the Codex app-server
```

## Traps in this environment

- **`npx tsx` can be mangled by the rtk hook and break** → for the CLI use
  `pnpm tiny <subcommand>` (= `pnpm -C packages/server exec tsx src/cli.ts`). If you
  must call it directly, use `./node_modules/.bin/tsx`
- **Never read API JSON through a curl pipe** → write it to a file first, then read it
  (rtk transforms the output; scripts/smoke.sh shows the pattern)
- **Do not trust `git log --oneline -1` output as evidence of git state** (rtk sometimes
  drops merge commits from the display; this caused two misreadings in practice). Check
  state with commands that print **unambiguous output**, e.g. `git rev-parse HEAD` /
  `git merge-base --is-ancestor`
- **Any code that spawns child processes must strip `ANTHROPIC_API_KEY` from the env**
  (leaving it set bills the API pay-as-you-go instead of the subscription; every
  existing spawn path already strips it)
- Read test counts, not just pass/fail (currently server 643 / relay 37 / iOS unit 197
  + 4 demo-UI + 3 live E2E [need a real tinyd — see HANDOFF]). **`xcodebuild test |
  tail` exits 0 even on failure** — always check for the literal
  `** TEST FAILED **` / `** TEST SUCCEEDED **` strings
- **Usage comes through the Agent SDK's `Query.usage_EXPERIMENTAL_…()`** (`usage.ts`).
  The code paths that read, refreshed, or wrote back the Keychain OAuth token were
  removed on 2026-08-29 (per Anthropic legal-and-compliance: "developers may not
  collect, store, or intermediate Claude.ai credentials or session tokens").
  **Do not bring them back.** The SDK marks the method EXPERIMENTAL, so if an SDK update
  breaks typecheck, fix the single call site in `usage.ts`
- **`wrangler dev` (local workerd) fails to reach APNs because its fetch is not
  HTTP/2** (workerd #4841). Verify real APNs behavior with `wrangler dev --remote` or a
  deploy
- **relay deploys need `CLOUDFLARE_ACCOUNT_ID` in `packages/relay/.env`** (this Mac's
  wrangler is linked to 3 accounts and `wrangler.jsonc` carries no `account_id` [public
  repo]; `.env` is gitignored — without it a non-interactive deploy stalls)
- **The resident tinyd on this Mac is the dist build installed via npm -g**
  (`~/Library/LaunchAgents/com.tanirell.tinyd.plist` runs `node <prefix>/bin/tiny
  serve`). **Editing `src/` does not affect it** → verify via `pnpm build` →
  `pnpm pack` → `npm i -g <tgz>` → `tiny daemon install` (`tiny doctor` detects "plist
  points at a different tiny" and daemon version mismatches)
- **Claude Code's undocumented interfaces (the `~/.claude/sessions/` registry, the
  `<pid>.<hash>.key` peer tokens, the `/tmp/cc-socks/<pid>.sock` messaging socket, the
  `ps` argv heuristic) are touched only in `src/claude-peer.ts`.** Everything else goes
  through the `PeerBridge` dependency of `SessionManager`, and every function there
  degrades to null (or throws from send) so the caller falls back to refusing the turn
  with 409. Do not read those files anywhere else. `src/claude-live.ts` (read-only
  liveness) is the one pre-existing exception. **The same confinement holds per agent:
  Codex's rollout jsonl / thread-writer-locks live only in `src/codex-live.ts`, and
  OpenCode's opencode.db / locks only in `src/opencode-live.ts`** (both read-only,
  degrading to null/empty)
- **A CLI session's AskUserQuestion never reaches the transcript until it is answered**
  (measured on Claude Code 2.1.252: a question left on screen for 60s wrote nothing). The phone
  learns about it from the `PreToolUse` hook `tiny live on` installs (`tiny question --auto`, which
  carries `tool_use_id` + the questions), and answers it by injecting the chosen answers with
  `priority: "now"` — the CLI abandons its own prompt (recording the tool call as rejected, an echo
  tinyd drops) and takes the answers as a message. Everything the transcript reader can see —
  answers chosen at the Mac, a dismissed question — still comes from the jsonl
- **The rtk hook rewrites `git diff` / `grep` / `awk` pipelines too**, not just `npx` —
  a review diff generated through it showed modified lines as unchanged context. Run
  scripts that produce diffs for another reader with `rtk proxy bash <script>`, and
  read API JSON with a Node `fetch` script rather than `curl`
- The src/dist launch split lives only in `src/entry.ts` (shared by the plist in
  `daemon.ts` and the `tiny mcp-server` spawn in `mcp-launch.ts`). **Do not add more
  code that locates files relative to `import.meta.url`** (tsup splits chunks)

## Layout

- `packages/server` — tinyd daemon + `tiny` CLI (Phase 1, complete; Phase 2 added
  PushClient, push settings (`config.json`), `tiny devices` / `tiny push config` /
  `tiny push test`). Distributed as tsup's `dist/cli.js` (npm `@nasjp/tiny`,
  `tiny setup` / `tiny doctor`). **Agent definitions live in `src/agents/<id>.ts`
  (driver: adapter / launch / label / homeEnv / stripEnv / login / attach /
  capabilities / prepareProfile).** There are 3 adapters (`src/claude-adapter.ts` =
  Agent SDK / `src/acp-adapter.ts` = generic ACP [opencode, cursor; droid / gemini are
  defined but unregistered] / `src/codex-adapter.ts` = codex app-server) and
  `buildAdapters()` in `src/adapters.ts` maps agent id → adapter. `send_user_file` is
  provided by `tiny mcp-server` (stdio, `src/mcp-server.ts`); agents launch with
  session-scoped env (`TINY_SERVER_URL` / `TINY_TOKEN` = **turn-scoped session token**
  (the CLI token is never passed) / `TINY_SESSION_ID`) — except Codex, which goes
  through `[mcp_servers.tiny]` in `$CODEX_HOME/config.toml`
- `packages/relay` — push relay (Cloudflare Workers, Phase 2, complete; deployed at
  https://tiny-push-relay.tanirell.workers.dev)
- `apps/ios` — SwiftUI app + Notification Service Extension (Phase 3, complete; real-
  device E2E done + two UX overhaul waves. Remaining: TestFlight distribution → App
  Store submission; see HANDOFF)
- Data lives in `~/.tiny/` (secret / tiny.db / profiles=CLAUDE_CONFIG_DIR / outbox /
  config.json = relay URL + push-enabled flag)
