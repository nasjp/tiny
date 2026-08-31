# For developers

How to install as a user is covered in [README.md](README.md). This page is for people
who clone the repo and run it from source.

## External contributions

Opening an issue first (bug report / agent request templates provided) saves back-and-
forth before you send a PR. PRs are reviewed by the maintainer and merged into main (the
"no PRs" rule below is the maintainer's own workflow, not yours). Adding an ACP-capable
agent takes one driver-definition file plus one smoke run — see "Adding an agent" below.

## Layout

- `packages/server` — the tinyd daemon + `tiny` CLI (npm `@nasjp/tiny`)
- `packages/relay` — push relay (Cloudflare Workers, `@nasjp/tiny-relay`, private)
- `apps/ios` — SwiftUI app + Notification Service Extension

## server

**Run commands from the repository root** (only iOS needs a `cd`).

```bash
pnpm install
pnpm test        # tests for all packages (server + relay)
pnpm typecheck   # tsc --noEmit for all packages
pnpm build       # bundles the server with tsup into dist/cli.js (the distributed artifact)
```

**`pnpm test` means different things depending on where you run it.** At the root it
runs every package; `pnpm -C packages/server test` runs just that package. When in
doubt, run it at the root.

To run the CLI from source use `pnpm tiny <subcommand>` (= `tsx src/cli.ts` in
`packages/server`).

```bash
pnpm tiny serve      # run tinyd in the foreground
pnpm tiny doctor
node packages/server/dist/cli.js --version   # run the built artifact directly
```

Do not use `npx tsx` (it breaks in this environment). Use `pnpm tiny`, or invoke
`./node_modules/.bin/tsx` directly.

### Installing the built package on your own Mac (same path as users)

```bash
pnpm -C packages/server pack --pack-destination /tmp   # prepack runs the build
npm i -g /tmp/nasjp-tiny-<version>.tgz
tiny doctor && tiny daemon install                     # points the launchd plist at the dist build
```

After this, **the resident tinyd runs from the npm -g dist build**. Editing `src/` does
not affect it — to verify a change, repeat pack → `npm i -g` → `tiny daemon install`
(if you want the daemon on src during development, `tiny daemon uninstall` and then
`pnpm tiny serve`).

### Smoke tests and checks (use real agents; not run in CI)

```bash
bash scripts/smoke.sh                                             # claude (auto-selects a logged-in claude profile)
bash scripts/smoke-opencode.sh                                    # profile oc
bash scripts/smoke-codex.sh                                       # profile cx
SMOKE_AGENT=cursor SMOKE_PROFILE=cur bash scripts/smoke-acp.sh    # generic ACP
ACP_CMD="<cmd>" node scripts/acp-probe.mjs new                    # probe an ACP agent
node scripts/codex-probe.mjs                                      # probe the Codex app-server
```

Two agent-free checks (always run before publishing):

```bash
bash scripts/check-public.sh             # no publish-hostile identifiers/secrets in tracked files
bash scripts/check-ios-decrypt-only.sh   # shipped iOS crypto is decrypt-only (export-compliance basis)
```

### Adding an agent (ACP-capable: one code file + one smoke run)

1. Probe it: `ACP_CMD="<launch command>" node scripts/acp-probe.mjs new` (plus
   `ACP_PERMISSION=1` / `cancel` / `resume <id>`). Note the capabilities from
   initialize, the configOptions from session/new, the tool_call kind/title, the
   request_permission options, and where the auth file lives (a table in the PR speeds
   up review a lot)
2. Write the driver definition in `packages/server/src/agents/<id>.ts`
   (`adapter: "acp"`, `launch`, `homeEnv` (falls back to `HOME` when the agent has no
   dedicated env var), `stripEnv` (env vars that would cause API-key billing),
   `isLoggedIn`, `login`, `attach`, `capabilities` (permissionModes are ask / auto — by
   convention the ACP adapter treats the id `auto` as auto-approve), and
   `prepareProfile` if needed). Add it to the registry in `src/agents/index.ts` and add
   one case to `test/agents.test.ts`
3. `tiny profiles add <name> --agent <id>` → `tiny profiles login <name>` →
   `SMOKE_AGENT=<id> SMOKE_PROFILE=<name> bash scripts/smoke-acp.sh` must print `ALL OK`
4. iOS needs no changes (labels and permission modes are served by the server). Check
   the list, permission banner and file card once on a real device
5. No new native adapters (Claude and Codex only). If an agent's ACP implementation is
   incomplete (no resume, no images), be honest about it in `capabilities`

## relay

```bash
pnpm -C packages/relay test
pnpm -C packages/relay run typecheck
pnpm -C packages/relay run deploy      # `run` is mandatory; `pnpm deploy` collides with a pnpm built-in
```

If more than one account is logged into wrangler, `cp .env.example .env` and set
`CLOUDFLARE_ACCOUNT_ID` (never commit `.env`; do not put `account_id` in
`wrangler.jsonc`).

`wrangler dev` (local workerd) cannot fetch APNs (workerd #4841). Verify against real
APNs with `wrangler dev --remote` or a deploy.

## iOS

```bash
cd apps/ios/Tiny            # only this section works inside apps/ios/Tiny
xcodegen generate           # mandatory after touching project.yml
xcodebuild test -project Tiny.xcodeproj -scheme Tiny -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
```

`xcodebuild test | tail` exits 0 even on failure. Always check for
`** TEST FAILED **` / `** TEST SUCCEEDED **` in the output.

## Notes

- Any code that spawns child processes must strip `ANTHROPIC_API_KEY` from the env
  (leaving it set bills the API pay-as-you-go instead of the subscription)
- Usage comes through the Agent SDK's `Query.usage_EXPERIMENTAL_…()` (`usage.ts`). The
  code path that read tokens from the Keychain was removed — do not bring it back
- No PRs (maintainer workflow): branch → all tests + typecheck → merge into main →
  re-test → push → delete the branch
