# Phase 7B — approved pre-release corrections (0.5.46)

## Root compatibility
Recognized root keys: settings, settingsUpdatedAt, organization, series, franchises, franchiseLinks, deletedFranchises, deletedSeries, deletedEpisodes, updatedAt, cloudDirty. Only series is required at the root; newer optional keys may be absent in old libraries. Existing structural validation still applies. No schemaVersion or arbitrary extension is assumed safe. Nested historical settings/content fields retain their existing policy.

Shared validation runs before load/normalization, import, Store snapshot/export, private-cloud compression/expansion/merge and cloud envelope application. save also validates current data and the disk file, preventing a delayed save from replacing a root made incompatible after opening. Unknown keys are never copied into export or cloud and never deleted to make a file pass. writeLibraryFile validates before changing Store targets. Import/cloud/replacement require backups before transformations; backup failure preserves current state. Startup uses the existing clear error and exits; other operations report a recoverable error without resetting data.

Cloud envelope keys are library/history/sync, with a valid library mandatory; legacy sync state keys are mappings/favorites/removedFavorites/history/settingsUpdatedAt/libraryRevision. Incompatible snapshots fail before local merge/upload. Current and legacy roots are tested against actual Store modules from all commits 0.5.34–0.5.45. This is synthetic compatibility evidence, not a scan of personal files.

## Account lifecycle
Logout first flushes the departing library and outbox into their account-specific files, preserving cloudDirty/history/favorites. A write failure explicitly stops logout. It then invalidates account epoch, Store scope and auth generation, aborts cancellable requests, detaches the pending sync slot and prevents late continuations/finalizers from changing a new account, including A→B→A.

During the local file transition, production IPC rejects mutations. A failed target load leaves account data intact and blocks account operations until the incompatible file is recovered. No automatic repair or data deletion is performed.

The old SDK client is retired on logout and on every sign-in/sign-up attempt. Generation-bound encrypted storage prevents old continuations from erasing a newer session. A real SDK test deliberately returns an uncancellable A login after B and verifies the B SDK session and encrypted file remain unchanged. Auth callbacks, profile/Social/watch-room results and multi-step operations carry account context. Stale remote logout does not update a newer auth UI.

Remote revocation uses the public SDK logout endpoint with the departing user's JWT and scope **local**, through a stateless client. No service-role key is involved. Revocation targets that session, not all devices; global revocation could cancel a later A login. Total remote deadline is **5000 ms**, with abort and confirmed/timeout/error states. Confirmation means the endpoint confirmed session/refresh-token revocation; an already-issued access JWT can remain valid until expiry. Timeout/error is explicitly shown as unconfirmed. SDK HTTP success/failure is exercised only against a controlled localhost endpoint; live provider behavior remains unverified.

## Runtime and tooling
Electron 33.4.11 → **44.7.0**, builder 25.1.8 → **26.15.3**, both exact pins. Production libraries remain @supabase/supabase-js2.109.0, cheerio1.1.2, ws8.22.0. Build-only override global-agent3.0.0 → **4.1.3** removes roarr/sprintf-js advisory GHSA-hp3w-g68c-fv3c. The CommonJS bootstrap contract is checked; proxy deployment behavior is not universally certified.

npm registry latest/44-x-y confirmed 44.7.0. No audit fix --force was run. Full and production npm audits reached zero reported advisories in this run; this is not a guarantee of future vulnerabilities.

Relevant upgrade changes: newer console-message event uses named details/string severity; tests still collect errors and retain old-event compatibility. The hidden-window capture produced UnknownVizError and is now performed on the actual visible controlled test window, without skipping capture or assertions. Electron binary download is on demand; existing ensure-electron still resolves install.js. Node >=22.12 is required for tooling. Electron44 requires macOS13+, drops 32-bit Windows/ARM Linux artifacts, and changes ANGLE distribution; app target remains Windows x64. No security preference was disabled.

Sources: [Electron changes](https://www.electronjs.org/docs/latest/breaking-changes), [Supabase signOut](https://supabase.com/docs/reference/javascript/auth-signout), [global-agent releases](https://github.com/gajus/global-agent/releases).

## Boundaries
Original repository and personal library/input.conf/account remain untouched. Old commit, lock/manifest and .45 packages are retained. Rollback environment: use a separate checkout at db9d461 and its lockfile with npm ci under the appropriate OS, then check/build; never roll back a personal migrated profile without its raw backup.

The three approved blockers are corrected within the tested scope. Release remains on hold: no original integration/publication, live cloud/two devices/RLS/Social, interactive NSIS upgrade/uninstall, Linux/macOS, physical accessibility or extended GPU sessions. AP13 large-library refresh limitation and AP14 personal spontaneous exit cause remain documented.
