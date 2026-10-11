# Playback reliability — Phase 2B

This change builds on the Phase 2A commit `6c9965a`. It does not change the library schema, cloud merge, tombstones, source identity or account files.

## Request lifetime

`PlayerManager.beginRequest()` creates a monotonically increasing generation and captures `Store.scope` at the IPC entry point. Library Play, legacy movie Play and direct URL Play pass that generation through mpv validation, AniSkip, URL renewal and launch. Each asynchronous boundary checks the generation and scope before applying metadata or starting a process. Stop, replacement, deletion of the requested unit/work and the cloud account-switch hook invalidate preparation. Shutdown rejects new launches. A cancelled HTTP request may finish, but its result cannot launch or update the library.

Source and language fallbacks retain the active generation and the Phase 2A persistent source IDs. The attempted-source set bounds retries. EOF/navigation from a superseded session cannot replace a newer preparation.

## Progress and shutdown

The player checkpoints the last observed position every five seconds. Position notifications cannot postpone that interval. Pauses flush immediately; seeks, playback restart after a seek and position jumps of at least five seconds schedule a single 250 ms checkpoint. Equal checkpoints do not create repeated mutations. The saved position is the position reported by mpv, including any keyframe/preroll offset, rather than the requested seek destination.

Checkpoints call `Store.setProgress()` for one local revision and flush the existing atomic Store write without adding a second revision or clearing `cloudDirty`. Unit lookup always uses saved IDs and the captured account scope, including after cloud object replacement. Previously watched units remain watched. EOF and the existing completion threshold retain their established semantics.

Stop checkpoints before requesting quit and waits for the process close. Final position/completion and watch history are flushed after close. Concurrent Stop calls share the same wait and remove temporary listeners. mpv gets 1.5 seconds to quit before termination is requested; the manager stops waiting after 2.5 seconds if close is never confirmed, retaining the latest observed checkpoint. Electron's `before-quit` prevents exit until that bounded stop and the final Store flush complete. The cloud outbox remains pending on disk for the next run. A disk write failure is reported and retried on subsequent checkpoints; hardware failure, an OS kill or process crash cannot guarantee the final unobserved position.

## Diagnostics

`MpvSession` records the initiating app intent, the `end-file` reason, code/signal, connection/loading milestones and forced termination. It collects both output streams until the child `close` event so the final stderr/stdout messages are available. Connection setup is bounded to ten seconds. A five-second heartbeat expects a reply within five seconds, including during pause; it does not retry sources. Loading has a thirty-second deadline and strict language detection a fifteen-second deadline.

Reasons distinguish app Stop, replacement/navigation, deletion, account switch, shutdown, external quit, EOF, IPC timeout/disconnection, load/track timeout, source error, network evidence and abnormal/unknown termination. HTTP/DNS/connection/TLS log hints are stored as observed evidence; they do not prove the underlying root cause. An EOF reported by mpv can also follow an incomplete stream. A zero exit code alone cannot prove user intent or natural EOF, and is recorded as unknown if mpv did not send an explanatory event.

The last 50 records live in `playback-diagnostics.json` under the app's userData directory. Records exclude arguments, headers, settings and source objects. URL paths, userinfo, queries and fragments, HTTP credentials, labelled secrets and JWTs are redacted. The file is bounded and written atomically only at session termination. Settings → Player diagnostics displays selectable text; relevant errors also use the existing player error notification. Diagnosing the previously reported spontaneous closure still requires a record from the affected session.

## Verification and rollback

Run `node --test test/playback-reliability.js test/playback-real.js`, `npm run check`, then `npm run dist`. Real tests use local synthetic PCM/Matroska files, a localhost HTTP fixture and isolated Electron/Store directories. Set `ANIME_PLAYER_TEST_MPV` to a test executable on platforms where the Windows managed path is unavailable. The test skips explicitly when mpv or a Linux display is unavailable; skips are not successful real-player verification.

No migration or automatic duplicate removal is introduced. Before deploying to personal data, close the app and copy the complete userData directory, including account library files, sync state and diagnostic records; the Phase 2A backup procedure remains applicable. Revert this commit to return to Phase 2A without a data conversion. Retain the backup rather than restoring over newer progress. Release builds and tests do not open the personal library or authenticate to cloud services.
