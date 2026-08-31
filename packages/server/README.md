# @nasjp/tiny

Drive the coding agents on your Mac (Claude Code / Codex / OpenCode / Cursor) from the tiny iPhone app, and hand any session back to the agent's own CLI.

```bash
npm i -g @nasjp/tiny
tiny setup              # checks node + agent CLIs → creates a profile and logs in → Tailscale URL → launchd daemon → pairing QR
tiny doctor             # re-run the checks any time
```

Prerequisites: macOS, Node 22+, and the CLI of the agent you want to use (`claude`, `codex`, `opencode` or `cursor-agent`) installed and logged in. Tailscale is recommended so the phone can reach the Mac from anywhere.

After upgrading (`npm i -g @nasjp/tiny@latest`) or changing Node, run `tiny daemon install` again so launchd picks up the new paths.

## Sending to a session the CLI still has open

Once a session is handed off, you can keep the terminal open and still use it from the phone as
if nothing were different. tinyd hands your message to the running Claude Code process itself
(over its local messaging socket), so it shows up in the terminal as `› Message from @tiny: …`
and the reply reaches both places. Stop works too (the terminal abandons the turn). Attached
photos are saved under `~/.tiny/outbox` and referenced by path.

One thing stays in the terminal's hands: permission prompts. While Claude Code waits for an
answer there, the phone shows "Waiting in the terminal". Closing the terminal hands the session
back to tinyd for the next message.

Claude Code only. Requires Claude Code ≥ 2.1.251 on the Mac; tinyd falls back to refusing the
send ("open in the CLI") when it cannot reach the process.

tinyd tells Claude Code that the message comes from a session in the same permission mode as the
terminal, so a `--dangerously-skip-permissions` session takes it right away instead of parking it
behind its "held message" review prompt — the phone is treated as the same person sitting at that
terminal. Only sessions handed to tiny are reachable this way; keep `tiny live` off if you want to
hand sessions over one at a time.

Docs, source and the iPhone app: https://github.com/nasjp/tiny
