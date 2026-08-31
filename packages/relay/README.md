# @nasjp/tiny-relay — push-relay

A Cloudflare Worker that does nothing but forward **opaque ciphertext** received from tinyd to APNs.
The APNs p8 lives only in this Worker's secrets and is never distributed to users' Macs.
The notification title, body, kind, and session-id are all inside the ciphertext, so the relay operator cannot see them.

## API

### `POST /v1/push`

```json
{
  "deviceToken": "<APNs device token (hex)>",
  "apnsEnv": "production | sandbox",
  "payload": "<base64: nonce(12) ‖ ciphertext ‖ tag(16)>",
  "collapseId": "<optional, 64 bytes max>",
  "priority": 10
}
```

| Response | Meaning |
|---|---|
| 200 `{ok:true, status:200, apnsId}` | APNs accepted |
| 200 `{ok:false, status, reason, apnsId}` | APNs rejected. On `BadDeviceToken` / `Unregistered` the caller should invalidate the token |
| 400 `{error}` | Malformed request, or payload exceeds 4096 bytes |
| 429 `{error:"rate limited"}` | Per-device-token rate limit (default 60 per minute) |
| 502 `{error:"apns unreachable"}` | Could not reach APNs |

### `GET /v1/health`

Just returns `{"ok": true}`.

## About retries

**There are no retries anywhere along the path.** No segment of tinyd → relay → APNs
detects failures and resends. When sending to APNs, the relay sets `apns-expiration`
to one hour from now so APNs holds the notification for devices out of coverage, but
**after that hour the notification is lost**. If tinyd needs resending, implement it
separately.

## Self-hosting

```bash
cd packages/relay
pnpm install

# 0. Deploy target account (only when wrangler is logged into multiple accounts)
#    cp .env.example .env and fill in CLOUDFLARE_ACCOUNT_ID (do not commit .env)

# 1. Point the bundle ID at your own app
#    Edit vars.APNS_TOPIC in wrangler.jsonc

# 2. Set the secrets (values via interactive prompt / file; never as command arguments)
pnpm exec wrangler secret put APNS_TEAM_ID
pnpm exec wrangler secret put APNS_KEY_ID
pnpm exec wrangler secret put APNS_SIGNING_KEY < /path/to/AuthKey_XXXXXXXXXX.p8

# 3. Deploy
pnpm run deploy

# 4. Tell tinyd the URL
tiny push config --relay https://tiny-push-relay.<subdomain>.workers.dev
```

## Development notes

- **Under `wrangler dev` (local workerd), fetches to APNs fail because they never upgrade
  to HTTP/2** (workerd #4841). Verify against the real APNs with `pnpm run dev`
  (= `wrangler dev --remote`) or after deploying
- Unit tests (`pnpm test`) stub `fetch` and do not need workerd
- To use secrets locally, copy `.dev.vars.example` to `.dev.vars` and fill it in
  (do not commit `.dev.vars`)
- Workers Rate Limiting is best-effort per colocation, not a globally strict 60 per minute
