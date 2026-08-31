# @nasjp/tiny

Drive the coding agents on your Mac (Claude Code / Codex / OpenCode / Cursor) from the tiny iPhone app, and hand any session back to the agent's own CLI.

```bash
npm i -g @nasjp/tiny
tiny setup              # checks node + agent CLIs → creates a profile and logs in → Tailscale URL → launchd daemon → pairing QR
tiny doctor             # re-run the checks any time
```

Prerequisites: macOS, Node 22+, and the CLI of the agent you want to use (`claude`, `codex`, `opencode` or `cursor-agent`) installed and logged in. Tailscale is recommended so the phone can reach the Mac from anywhere.

After upgrading (`npm i -g @nasjp/tiny@latest`) or changing Node, run `tiny daemon install` again so launchd picks up the new paths.

Docs, source and the iPhone app: https://github.com/nasjp/tiny
