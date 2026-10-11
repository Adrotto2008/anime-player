# mpv shortcuts and manual opening/ending skips — Phase 6, v0.5.44

## Behavior and defaults

Settings → Playback → Shortcuts opens direct keyboard capture. Change, Escape to cancel, Disable, per-action Reset and Save are available. Save reports whether the running player acknowledged the update or it will apply on the next launch. Defaults: next episode Page Down, previous Page Up, opening Ctrl + Shift + o, ending Ctrl + Shift + e. mpv represents the last two as `Ctrl+O` and `Ctrl+E`: uppercase ASCII means Shift. Explicit empty bindings and existing custom/legacy preferences survive upgrades; Reset is required to replace a saved older value.

Capture supports letters/numbers, Ctrl/Alt/Shift/Meta, navigation and F1–F24. Unsupported punctuation, dead keys and AltGraph report an error; nothing is silently invented. Modifier order, ASCII case and mpv's treatment of Shift on non-letter text are normalized. Duplicate combinations, common mpv controls and Anime4K presets are rejected. Keyboard layouts can require a custom combination. A candidate Ctrl+Alt+e failed a native Windows test, so both default skips use Ctrl+Shift instead.

## Native binding architecture and personal configuration

The renderer shares `playback-shortcuts.js` with Node. Main validates preferences, asks PlayerManager to update the active session, then saves only if the account scope still matches. Session updates serialize snapshots and carry current session/generation/scope guards. During direct capture, the Electron DevTools shortcuts are suspended so Ctrl+Shift+i/F12 reach the input; success, cancellation and blur release this state. The Electron runner exercises the production before-input listener.

PlayerManager copies the bundled `ap-shortcuts.lua` to its own isolated/application userData and loads that one script into the mpv process it launches. It does not write input.conf or add an --input-conf override. mpv loads its ordinary configuration normally. No global hook, forced binding, focus transfer or desktop-wide interception is used.

Lua checks the live `input-bindings` property before replacing its own bindings and acknowledges the result by correlated IPC. Existing strong personal input.conf bindings take precedence; a conflicting requested shortcut fails while the previous application bindings remain active. Anime4K uses separate weak native bindings and is checked for conflicts too. Page Up/Down deliberately replace only mpv's ordinary weak defaults; custom strong navigation bindings are protected. Extra arguments remain user-controlled, including an explicitly supplied config directory or input-conf.

The compatibility helper `buildInputConf` remains for older callers/tests but the application launch path does not use it. No personal configuration file was read, modified or inspected for verification: a temporary synthetic input.conf established that its strong custom actions survive.

## Exact seek rules

AniSkip metadata uses MAL ID plus episode number and retains typed per-episode intervals. Manual opening accepts op/mixed-op; ending accepts ed/mixed-ed (and the previous cached mixed-ending alias). Recaps and unknown types are ignored.

Each action reads current time and actual duration from the active mpv session. A valid interval has finite numeric timestamps, 0 ≤ start < end ≤ actual duration. From inside an interval or within two seconds before its start, seek to its exact end. From farther before, at/after the end, or with absent/invalid metadata, do not seek. Multiple intervals select the current interval first, then the closest eligible upcoming interval, deterministically. No guessed 90-second skip and no series intro/outro duration fallback is used.

One request may run at a time. A 1.2-second cooldown and a repeated-destination guard prevent held/repeated keys from chaining adjacent intervals. Late replies after episode/source change, Stop, process exit or account change cannot command the new session. UI offers carry request/series/episode identity and are revalidated at click time.

Discrete 1.2-second mpv OSD reports Opening/Ending skipped or unavailable in the selected language, with notification throttling. Neither success nor missing data opens an Electron dialog. Existing automatic-skip preferences remain separate; manual defaults do not enable them.

## Preferences and regressions

Shortcuts remain an additive settings field. Reopen, export/import and the existing private-library cloud snapshot preserve values. Store settings/import/private-sync events update a loaded session; invalid legacy preferences remain stored and report an error rather than overwriting user choices. No cloud schema, shared source policy, UUID, source headers, library organization or progress migration is introduced.

`npm run check` includes normalization/validation, isolated persistence, late responses and account guards, real mpv synthetic-media tests, the Electron capture/settings runner, existing Phase 2B reliability tests and Phase 5B interaction regressions. Real mpv tests cover native bindings, OP/ED seeks, missing intervals, configuration conflicts, live changes, episode/source changes and restart. Native Windows fullscreen verification is recorded separately with actual playback positions and screenshots.

## Verification scope and manual checks

Windows is the tested platform. Linux/macOS builds, arbitrary keyboard layouts, real personal configuration combinations, a real cloud login/sync and interactive NSIS installation are not established by these tests. Windows package verification extracts both executable payloads, compares every production source and shader to the checkout, checks version/x64/identical ASAR and confirms empty offline Supabase configuration; it does not install into the personal environment.

For a short manual check, use an isolated test profile and the already prepared synthetic video with opening 10–30s and ending 60–80s. Play fullscreen, press Ctrl+Shift+o around 15s and Ctrl+Shift+e around 65s, check destinations and OSD. Retry after each end, disable/rebind a shortcut while playing, then change episode/source and Stop/restart. Saved older empty/custom values require Reset to try the new defaults. Do not enable automatic skip during this manual check.

## References

- [mpv Lua native bindings](https://mpv.io/manual/stable/#lua-scripting): ordinary versus forced bindings, removal and script messages.
- [mpv input configuration](https://mpv.io/manual/stable/#input-conf) and [runtime properties](https://mpv.io/manual/stable/#properties).
- [AniSkip's official typed API client](https://github.com/aniskip/aniskip-extension/blob/main/src/api/aniskip-http-client/aniskip-http-client.types.ts).
