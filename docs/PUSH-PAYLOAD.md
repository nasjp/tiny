# Push notification payload contract

The Notification Service Extension (NSE) in the iPhone app is implemented against this
shape. The source of truth is `PushIntent` in `packages/server/src/push-client.ts` and
`buildApnsBody` in `packages/relay/src/apns.ts`.

## What APNs carries (assembled by the relay, fixed)

```json
{
  "aps": {
    "alert": { "title": "tiny", "body": "New activity" },
    "mutable-content": 1,
    "sound": "default"
  },
  "p": "<base64: nonce(12) ‖ ciphertext ‖ tag(16)>"
}
```

- `aps.alert` is a **placeholder**. The relay is unauthenticated, so a third party who
  knows a device token can throw arbitrary `payload`s at it. The payload is AEAD, so the
  contents cannot be forged and decryption always fails — but if the NSE displayed this
  placeholder as-is, it would become a **spam channel for empty notifications**.
  **Suppress notifications that fail to decrypt** (e.g. hand empty content to the NSE's
  `contentHandler`). Do not treat "the placeholder shows as a fallback when decryption
  fails" as acceptable behavior.
- Without `mutable-content: 1` the NSE is never invoked.
- All actual content lives inside `p`. The relay operator cannot read it.

## The JSON obtained by decrypting `p`

```json
{
  "v": 1,
  "type": "permission_requested",
  "sessionId": "b6b1c0de-....",
  "eventId": 42,
  "title": "my-repo",
  "body": "Requesting permission to run Bash",
  "category": "tiny.permission",
  "level": "time-sensitive",
  "reqId": "9f2c...."
}
```

| Field | Type | Description |
|---|---|---|
| `v` | `1` | Payload version. **Treat an unknown `v` (a future `2`, etc.) the same as a decryption failure and suppress the notification** — this lets an old app safely ignore newer payloads |
| `type` | `permission_requested` / `turn_completed` / `turn_failed` / `auth_error` / `session_added` | Kind of notification. `session_added` announces a session that appeared from the Mac side (a CLI hook, `tiny handoff`, `tiny new`); it is not derived from an event, so its `eventId` is `0` and tapping it simply opens the session |
| `sessionId` | string | The session to open on tap. `tiny push test` may send the non-existent ID `"push-test"` (`packages/server/src/api.ts`), so the NSE / app must not crash on a `sessionId` it cannot resolve |
| `eventId` | number | Fetch the rest with `GET /v1/sessions/:id/events?since=<eventId-1>` |
| `title` | string | Session title, falling back to the basename of the cwd (max 40 chars) |
| `body` | string | Body text (max 120 chars) |
| `category` | `tiny.permission` / `tiny.question` / `tiny.info` | Goes into the NSE's `categoryIdentifier`. `tiny.permission` carries allow/deny actions. `tiny.question` is for AskUserQuestion and has no actions (tapping opens the app to answer the choices) |
| `level` | `time-sensitive` / `active` | Goes into the NSE's `interruptionLevel` |
| `reqId` | string (optional) | Only for `permission_requested`. Used with `POST /v1/permissions/:reqId` |

## Decryption (Swift)

`e2eKey` is the base64 32-byte key returned by `POST /v1/devices` at pairing time.
It lives in the App Group Keychain, shared between the NSE and the main app.

```swift
import CryptoKit

func decryptPush(payloadBase64: String, e2eKeyBase64: String) throws -> Data {
    guard let key = Data(base64Encoded: e2eKeyBase64),
          let combined = Data(base64Encoded: payloadBase64) else {
        throw CocoaError(.coderInvalidValue)
    }
    let box = try ChaChaPoly.SealedBox(combined: combined)
    return try ChaChaPoly.open(box, using: SymmetricKey(data: key))
}
```

`combined` is `nonce ‖ ciphertext ‖ tag`, which CryptoKit interprets directly — no
manual splitting needed. This interoperability is verified by `scripts/crypto-interop.sh`.

## Collapse policy

`apns-collapse-id` (the `collapseId` sent to the relay) is **always sent, regardless of
notification type**. If it were sent for some types and not others, the relay could tell
"this is a pending permission request" from the mere presence of `collapseId` — a 1-bit
side channel in plaintext. To close it:

- `turn_completed` / `turn_failed` / `auth_error` / `session_added` use the first 32 hex chars of
  `HMAC-SHA256(key = e2eKey, sessionId)`, per session. The value is stable within a
  session, so APNs replaces notifications with the same value and only the latest one
  remains.
- `permission_requested` uses `HMAC-SHA256(key = e2eKey, "sessionId:eventId")` **per
  event**. The value differs every time, so APNs never replaces them — the "do not
  collapse" behavior is achieved by sending a different value each time rather than by
  omitting the value (collapsing multiple pending permissions would lose some of them).
- The key is the device-specific `e2eKey`, so the relay can infer neither the session id
  nor whether two devices are the same.

## Hard requirement for the app: APNs token re-registration

When tinyd receives `BadDeviceToken` / `Unregistered` from APNs, it **deletes** that
device's token from the DB (`DEAD_TOKEN_REASONS` in `packages/server/src/push-client.ts`).
There is no recovery path on the relay side —
**the only way back is the app re-sending its token via `PATCH /v1/devices/me`.**
The app must therefore send its current APNs device token to `PATCH /v1/devices/me` on
every launch (sending it when unchanged is fine).

## Size limit

Regular APNs notifications are capped at 4096 bytes. The relay measures the result of
`buildApnsBody` and returns 400 before hitting APNs if it exceeds the cap. With `title`
truncated to 40 chars and `body` to 120, payloads normally land around 600 bytes.
