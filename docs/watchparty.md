# Watch Party (0.5.55)

## Client

Open Watch Party in the sidebar. Create a public room (its eight-character code permits admission) or a private room (host approval or a targeted friend invitation permits admission). The default capacity is 16; the server setting accepts 2–64. Hosts retain all controls and can enable each shared action for participants. A guest ban applies to that temporary identity in this room; someone who obtains a new guest identity cannot be identified as the same person.

Registered hosts select existing friends from the account's friend list. Invites appear in the recipient's app and expire after ten minutes. Acceptance supplies the room's admission grant without asking the recipient to type its code. The Worker independently checks the caller's Supabase session and friendship under existing RLS. Guest rooms do not require registration.

Playback uses each device's existing mpv configuration, provider discovery, source preparation, renewal, language preferences and shortcuts. Catalogue identity and episode/part metadata travel through the room. Resolved URLs are shared only when the user enables the option and they pass the conservative public HTTPS filter (no credentials, query, fragment, IP address or local hostname). This filter cannot certify the licensing or durability of a URL; sharing defaults off. A local file is represented by its full SHA-256 and basename, and an equivalent file must be selected independently. Files, cookies, Referer headers, account tokens and library paths are not forwarded to other participants.

For a missing source or incompatible duration, choose an equivalent URL/file manually. Matching durations alone cannot establish identical edits or timing. Individual pause leaves other clients playing; Resync restores the current room timeline. Small drift adjusts speed (default at most ±4%); drift beyond 1.25 seconds can seek, with a five-second cooldown. All thresholds have bounded settings. The shortcut `Ctrl+Alt+W` displays RTT, drift and sync state in mpv and is configurable on the existing shortcut page. Host buffering temporarily holds followers; follower buffering stays local.

Closing mpv does not close a room. Explicit leave removes membership immediately; loss of the socket reserves it for 30 seconds. After that, one randomly selected connected participant becomes host if necessary. The last departure deletes room data. Bans and invites exist only for that room's lifetime.

## Worker

The endpoint is `https://watchparty-server.adrianopalmeri02.workers.dev`. The repository reuses Worker `watchparty-server`, binding `MY_DURABLE_OBJECT`, class `MyDurableObject` and SQLite migration `v1`. Additive migration `v2-watchparty` supplies class `InviteInbox`/binding `INVITE_INBOX` for per-user invitation mailboxes and short-lived admission rate counters. No Supabase migration or new table is needed. The dormant Supabase Watch Room IPC has been retired; historical CloudService compatibility methods remain unused.

From `watchparty-server`:

```sh
npm ci
npm run cf-typegen
npm run check
npx wrangler secret put PARTY_SIGNING_KEY
npx wrangler secret put SUPABASE_PUBLIC_KEY
npm run deploy
```

Use a random signing key of at least 32 bytes. Keep the existing key on subsequent deploys so active guests can reconnect. `SUPABASE_PUBLIC_KEY` is the same public/publishable key used by the app, never a `service_role` key. `SUPABASE_URL`, `ROOM_MAX_PARTICIPANTS=16` and `RECONNECT_GRACE_MS=30000` are configured in Wrangler. Do not change the existing namespace or remove migration history. Generated types must be regenerated after binding changes. Secrets belong in Wrangler secret storage, or ignored `.dev.vars` for local development.

SQLite Durable Objects and hibernation work on [Workers Free](https://developers.cloudflare.com/durable-objects/platform/pricing/). An idle eligible object does not incur active duration; repeated playback traffic keeps a room active. Current Free quotas include 100,000 DO requests/day, 13,000 GB-s/day, 100,000 SQL rows written/day, 5 million SQL rows read/day and 5 GB storage/account. Incoming WebSocket messages are billed as requests at 20:1; outgoing messages are not charged as requests. Workers have their own [100,000 requests/day Free quota](https://developers.cloudflare.com/workers/platform/limits/). Free overages fail rather than automatically purchasing a plan. Limits are shared with other workloads and must be checked against current [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) before large usage.

For a rough upper bound, one continuously active room uses about 450 GB-s/hour at 128 MiB. Default host snapshots (every two seconds) plus 16 participants' ten-second pings generate roughly 7,560 messages/hour, about 378 request units before HTTP, reconnect, moderation and alarms. Frequent user commands and reconnects increase this. Playback snapshots update memory and host socket attachments, not SQLite on every tick; membership, permissions and one-use grants persist. Hibernation reconstructs the latest host anchor from its attachment. This estimate is not an account usage measurement or a guarantee of uninterrupted Free availability.

## Protocol and security

The renderer has an explicit IPC allowlist. Electron main owns HTTPS/WebSocket transport and Auth credentials. The production endpoint is fixed; only source checkouts with a test profile under `work/` may use a loopback test endpoint. Packaged applications ignore the test variables.

`POST /api/v1/guests` signs a one-hour ephemeral identity; it conveys no room permissions. Room/inbox upgrades require one-use, 30-second tickets attached through the `Sec-WebSocket-Protocol` header, never URLs. Room tickets are scoped to the room's Durable Object. Registered grants last at most five minutes and are renewed through remote Supabase `getUser` verification; revocation is bounded by this window, rather than instantaneous. Invitations are recipient-specific and expire in ten minutes. Private approval requests expire in one minute. Reconnect retains the same identity and replaces its old socket.

HTTP admission is rate limited per hashed address; WebSocket messages are limited to 16 KiB and 15 messages/second. Every state-changing message checks active membership, socket replacement, identity expiry, host/per-action permission and playback epoch. Stale episode commands are rejected. Rate counters and used/expired grants are removed by alarms. WebSocket keepalive auto-responses use the hibernation API. Telemetry reports a minimum-RTT clock offset over recent samples; it never broadcasts measured network credentials or player files.

## Verification

`npm run check` includes Worker TypeScript, protocol/drift/credential tests and a real local workerd suite with multiple WebSockets: public/private admission, guest/account verification, invitation delivery, cap, permissions, old epochs, moderation, bans, reconnect, host election, final deletion, room/inbox isolation, ticket replay, expired identities and flood rejection. Registered fixture identities are not evidence of real Supabase login.

`node test/watchparty-e2e.js` opens two source Electron instances and real visible mpv windows with generated test video and isolated profiles. `node test/watchparty-accounts.js` additionally opens two login windows for distinct real test accounts; this harness disables library/history synchronization and profile writes, retaining production Auth, existing friendship reads and Party IPC. It requires manual login and existing friendship. Neither test reads personal library data. See the version's release report for the scenarios actually completed, screenshots, measured drift, live Worker evidence and package hashes.

The 500 ms target is evaluated under the test's controlled network/media conditions. Heterogeneous remote sources, very long viewing sessions, frame alignment, arbitrary device hardware and all possible network outages require separate coverage. Release CI uploads verified drafts; the final release step attaches its report and publishes existing assets, with macOS included only when its signed/notarized build is enabled and succeeds.
