# Security Policy

tiny is a tool that **runs coding agents (processes holding a shell) on your own Mac and
drives them from your iPhone**. Vulnerability reports are very welcome.

## How to report

- **GitHub Private vulnerability reporting** (Security tab of this repository → "Report
  a vulnerability"). Please do not post details in a public issue
- If you cannot use it, open an issue that only says you want to discuss a security
  matter, without details, and I will provide a contact channel

Reports in English or Japanese are both fine. You will get a reply within one week of
receipt, and fixes ship as a new version of `@nasjp/tiny` on npm.

## Scope

- `packages/server` (the tinyd daemon, the `tiny` CLI, `tiny mcp-server`) — npm `@nasjp/tiny`
- `packages/relay` (push relay, Cloudflare Workers)
- `apps/ios` (the iPhone app and its Notification Service Extension)

Only **the latest 0.x** (`npm i -g @nasjp/tiny@latest`) is supported.

## Design assumptions (not bugs)

- tinyd is meant to be reached **from your own iPhone inside your LAN / Tailscale
  network**. Do not expose tinyd directly to the internet (pairing is a local QR code
  and auth is two layers — bearer token + E2E encryption — but operating it over a
  public path is out of scope)
- The iPhone app allows plaintext HTTP over Tailscale (an ATS exception). Notification
  bodies are encrypted per device with ChaCha20-Poly1305; the relay cannot decrypt them
- The push relay is **unauthenticated by design**. A third party who knows a device
  token can send ciphertexts, but they fail to decrypt, so contents cannot be forged —
  notification spam and rate-limit exhaustion are possible (default 60/min per device)
- Agent permission modes (`bypassPermissions` / `auto` / `bypass`) can be selected from
  the iPhone. **Pair only devices you trust** (list them with `tiny devices` and remove
  any you no longer need)
- Pairing-code redemption has no attempt limit. This is judged **not brute-forceable**:
  the code is 8 chars from a 32-char alphabet (~1.1 trillion keys), valid for 10
  minutes, single-use, and tinyd is only reachable from the LAN or Tailscale — hitting
  even a 1% success chance within 10 minutes would take ~18 million requests per second.
  **If you ever shorten the code, add rate limiting first.**

## For developers

`scripts/check-public.sh` verifies that tracked files contain no secrets or personal
identifiers. The code path that strips API keys (`ANTHROPIC_API_KEY` etc.) from child
process environments lives in `stripEnv` in `packages/server/src/agents/*.ts`.
