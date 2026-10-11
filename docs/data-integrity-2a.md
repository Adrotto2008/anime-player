# Data integrity — Phase 2A

Scope: AP-04, AP-05, AP-06. No personal library or live account is used by the tests or build.

## Backup and reversible migration plan (before implementation)

- Keep work, unit and source IDs; never deduplicate different UUIDs by number, `single` or a release key. Existing ambiguous duplicates remain separate and require a later explicit review.
- Legacy source IDs will be additive, deterministic within the saved unit, and retained across URL renewal. Migration does not remove links, headers, progress, ratings, preferences or tombstones.
- Before the first write of a structurally migrated library, copy its exact existing bytes into an exclusive adjacent `*.pre-integrity-*.bak` file. Import replacement also creates a backup. A failed backup must prevent the write. Never overwrite a backup.
- Load/migration must be idempotent. A migration may move a legacy TV unit into parts with the SAME UUID; it may not infer equivalence to another UUID. Tombstoned units must not be recreated by refresh or old snapshots.
- Rollback: close the app and pause cloud on all devices, keep a copy of current library and sync files, restore the corresponding backup to its original filename, and use the previous binary. Backups are local rollback points, not a way to overwrite a newer remote snapshot. Do not launch old and new versions against the same cloud concurrently.
- Do not start, install or sync this build on the personal profile automatically. Before an authorized rollout, back up all `library*.json`, owner marker and `supabase-sync*.json` files with the app closed. Verify counts and saved IDs/progress/ratings/headers/preferences on a copy first. Existing duplicates are preserved, not automatically repaired.

## Verification

Add regression fixtures BEFORE application changes. They exercise the actual IPC playback handler, Store import/reopen/migration, PlayerManager renewal and cloud requests held at explicit promise barriers. Verify empty/valid/failed AniSkip, repeated playback and refresh, duplicate `single` keys, source renewal after object replacement, mutations/deletions during upload, revision conflicts and account changes. Only synthetic temporary libraries and mocked HTTP responses are used.

Run `node --test test/data-integrity.js`, `npm run check`, and the repository-required isolated `npm run dist`. No added dependencies or Supabase schema change.

## Implemented format and conflict rules

- Source `id`, unit `automaticSources` identity/header descriptors, `settingsUpdatedAt`, `personalRatingUpdatedAt`, and unit tombstone `number`/`kind`/`key` are additive. Legacy IDs are filled deterministically within the original unit; existing IDs are never regenerated. Older tombstones lacking a number still protect their UUID in cloud merging; no number is guessed from a deleted UUID.
- Cloud TV units carry every saved manual source in `manualSources`; legacy `sourcePattern` remains readable. No new URL is synthesized for a missing link in the new format. Automatic descriptors omit stream URLs and resolver credentials.
- The local Store revision is a runtime counter, independent of `Date.now`; `cloudDirty` persists the outbox across restart. Account epoch plus Store file/scope reject old responses even for an A→B→A switch. Acknowledgement with intervening edits uses a three-way rebase (original local snapshot, latest local state, acknowledged merge), so same-millisecond edits and explicit array removals survive. An unchanged upload cleans without replacing objects.
- Remote compare-and-swap conflicts do not apply unacknowledged data. They reset the known remote revision and schedule a retry. Different work/unit UUIDs are never coalesced. Deletion tombstones dominate stale metadata/progress for their UUID; a restored item requires an explicit restore workflow, which this phase does not add. Same-ID metadata/progress use the existing timestamp conflict policy; progress, measured duration and video preference retain their independent merge rules. Personal ratings have an independent timestamp: a metadata refresh cannot erase them, and a newer explicit clear is honored. Legacy non-null ratings are preserved when an unstamped empty value provides no evidence of a user clear.
- Ambiguous duplicate part keys stop discovery/import of new sources into that key. Manual editing and playback of each existing unit by ID remain available. This preserves data while a later explicit duplicate review is prepared.
- New snapshots require this version on all syncing devices. Rollback requires restoring a complete backup with cloud paused; an older client can otherwise remove identity/descriptors and collapse independent same-number units.
- Independent units targeting the same numbered shared episode catalogue row are excluded from optional catalogue progress/history sync. Their private UUID snapshot still syncs; unique catalogue mappings remain available.
