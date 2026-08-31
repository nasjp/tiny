# tiny — App Store metadata (draft, 2026-08-27)

Draft as of the first half of Task 14 (icon + metadata prep). Actual App Store Connect
registration, Archive, and upload are not done yet (out of scope for that Task). After
registration, append the measured values (App ID etc.) to this file.

## Basics

- **App name (max 30 chars)**: Tiny - Agent Remote Control (registered. "tiny" and
  "Tiny Agents" are taken by other accounts and return 409. The Home Screen label stays
  "Tiny" via CFBundleDisplayName)
- **Subtitle (max 30 chars, 29)**: Control Claude Code, anywhere
- **bundle id**: `com.tanirell.tiny` (App ID registered, Team `TS295VKGNA`. Push
  Notifications / Time Sensitive Notifications enabled) / SKU `tiny`
- **App Store Connect**: registered (2026-08-28, via the iris internal API).
  **App ID `6805950603`**, primary language en-US, version 1.0
- **Category**: primary = Developer Tools, secondary = Productivity
  (chosen per the design spec's classification: "a utility that connects to the user's
  own server — same family as SSH clients and Happy Coder". Regulated categories such
  as healthcare do not apply)
- **Distribution**: Japan only (initially) / Language: Japanese
- **Price**: free. No in-app purchases or subscriptions
  (design spec: "no IAP or external-subscription unlocks")

## Promotional text (max 170 chars)

See and drive your Mac's Claude Code sessions from your iPhone: live progress, one-tap
permission approvals, files viewable in place. Back at the Mac, `tiny attach` resumes
the same session in the CLI. Your Mac is the only server — no external cloud.

## Description

tiny is a remote client dedicated to your own Mac, for watching and driving Claude Code
sessions running on it from your iPhone.

■ Connects directly to your own Mac
- Only your paired iPhone connects to tinyd, a self-hosted daemon resident on your Mac
- No external cloud services or account sign-up. Like an SSH client, it is strictly a
  "tool that connects to your own server"

■ Session progress from anywhere
- Shows messages, tool executions, and completion of the sessions Claude Code is
  working on, in real time
- Operations that need permission (file changes, command execution, and so on) can be
  allowed or denied on the spot with a tap
- Generated files (reports, code diffs, and so on) open right inside the app

■ Hand off to the Mac's CLI when you're done
- A session advanced on your iPhone hands off to a plain `claude --resume` via
  `tiny attach` once you're back at the Mac. History is never broken

■ Notifications are encrypted
- Push notifications tell you about session completion and pending permissions
- Notification contents are encrypted with a key shared between your devices (E2E);
  the relay server cannot decrypt them

■ Pricing
- Free. No in-app purchases or subscriptions

■ Requirements
- You must first set up tinyd (https://github.com/nasjp/tiny) on your Mac and pair it
  with this app via QR code
- While the Mac is off or tinyd is stopped, the app cannot operate (and no
  notifications arrive)

## Keywords (max 100 chars)

Claude,ClaudeCode,AI agent,terminal,CLI,remote,SSH,developer,programming,coding,sessions,push,Mac

## Screenshots

Not generated yet (out of scope for Task 14). In the second half of Task 14 or a
separate Task, prepare 5 shots: pairing screen, session list, chat (progress view),
permission buttons, file viewer. Demo mode allows capturing them without a real Mac
connection.

## Review notes (App Review Information → Notes)

- **This app's classification is "a utility that connects to a self-hosted daemon
  (tinyd) running on the user's own Mac" — the same family as SSH clients.** There is
  no app-specific backend in the cloud; the target of every operation is always a Mac
  the reviewer themselves prepared.
- **Reviewers can inspect the app's entire UI without preparing a Mac or tinyd, via the
  "Try demo mode" button on the launch screen.** Demo mode performs no network
  communication at all and reproduces the full production screen flow using mock
  sessions (messages, tool executions, permission prompts, file delivery, completion).
- **Push notifications are E2E encrypted; the relay server (push-relay) cannot read
  their contents.** They are encrypted with ChaCha20-Poly1305 using a device-specific
  key issued at pairing, and decryption happens only on-device in the Notification
  Service Extension. The relay server holds only ciphertext and the metadata needed for
  delivery (APNs device token, etc.).
- No login (no Apple ID or other account creation), so there is no dedicated review
  account. Please use demo mode above instead.
- Pairing requires a QR code issued on the Mac side. Contact us separately if you need
  to verify real-device pairing.

## Privacy nutrition label

- No collection of personally identifying information. No user accounts or login
- The app communicates with (1) tinyd on the Mac the user prepared themselves (URL
  obtained at pairing) and (2) the relay server for push delivery (APNs device-token
  registration and relaying of the encrypted notification body only; the relay server
  can never store or view session conversations, code, etc.)
- No tracking. No data provided to third parties for advertising or analytics

## Age rating

Expected 4+ (a developer tool; nothing that falls under age-restricted content).

## Misc

- **Icon**: v1 (`store/make_icon.py`; deep teal-to-black gradient ground, terminal-style
  ">" prompt + rounded cursor rectangle, no lettering)
- **releaseType**: undecided (out of scope for Task 14)
