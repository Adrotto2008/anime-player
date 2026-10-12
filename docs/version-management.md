# Versions, update safety and mpv device configuration — 0.5.50

The existing `UpdateService`, electron-updater 6.8.10, cache verification, voluntary-exit installation and shutdown backup remain in use. Versions replaces the old Settings updater interface. Release notes are text nodes, including in the startup popup.

## Exact release selection

The main process requests the fixed public `Adrotto2008/anime-player` repository through GitHub's paginated Releases API (20 entries per page). Drafts and prereleases are excluded. The renderer supplies only a semantic version or a bounded page number; it cannot supply a feed, path, asset URL or credentials.

Selection re-fetches the official `vVERSION` release and its platform channel manifest from that release's download directory. The manifest version, exact package name, architecture, asset URL, size and SHA-512 are checked. A generic provider points electron-updater at that specific directory; `allowDowngrade` only enables comparison after validation. Differential download is disabled for explicit selections. Update-available/downloaded events must match the selected manifest's files. An explicit latest check restores the fixed GitHub provider. Installation rehashes the cached file, saves data, creates verified backups, and waits for shutdown as before.

Audited Windows NSIS x64 targets are 0.5.47 through 0.5.50, when the running version is also within this schema range. Older releases lack the updater and are blocked. Future versions outside the audited range cannot be downgrade sources without a new data-format audit and policy update. Linux/macOS downgrades and non-x64 explicit selection are blocked. Portable, source and DEB retain their existing installation limitations. Missing releases, manifests or matching packages are not installable.

Live GitHub validation on 2026-10-12 found only 0.5.49 in the audited range; 0.5.47 and 0.5.48 were not published releases (HTTP 404). Synthetic .47/.48 fixtures do not imply their availability. A real official .49 installer was downloaded through electron-updater into an isolated cache and rehashed; it was not executed.

## Data and preferences

`updates.json` stays in its existing profile location. Legacy `checkAtStartup=false` migrates to manual mode; true migrates to automatic mode. New fields are `mode`, `popupAtStartup` and `pinnedVersion`. Pinning prevents startup checks/popups and rejects downloading another version. A downloaded selected version can be pinned before installation. Returning to automatic mode restores startup checks on subsequent launches. Corrupt preferences are retained and automatic activity is disabled.

Backups include durable root files such as all library/account files, encrypted sessions, sync queues, update preferences and device configuration. Backups exclude Chromium caches and do not guarantee a complete operating-system/session rollback. Older application binaries can ignore newly introduced preference fields even though the files retain them. No separate incompatible profile or automatic backup restore is implemented; uncertified downgrades are blocked instead.

## Startup notification

The renderer signals readiness after UI initialization. The existing ten-second delayed network check then runs without blocking the UI. Only automatic mode with popup enabled can display an available stable update. An open dialog or active playback defers it until those conditions clear. A main-process session flag prevents repeat prompts even across renderer reloads. Later dismisses without scheduling installation; the next application process can notify again. View all versions navigates internally.

## mpv cause and fix

Previously startup detection saved only `mpvPath`, while the renderer decided solely from an account library's `onboardingComplete`. A detected or installed executable could therefore leave the flag false; account libraries also carried differing flags. Conversely, Later falsely set completion despite no usable executable. These are code-level causes; the personal profile was not inspected to attribute one particular historical instance.

`mpv-device.json` now stores a verified executable/path/version and managed installation directory independently of the account library. Startup validates the chosen executable with the existing bounded `mpv --version` check. Existing usable paths migrate even with a false legacy flag. Once configured, startup does not replace a chosen missing executable with a different detected copy: it offers repair. Failed validation/cancellation never completes configuration. Corrupt device state remains intact until a successful explicit repair, which first preserves a backup. Detection, browse, install and Settings save all record completion after verification and flush persistence. The original verified mpv installer remains available.

## Release/build requirements and remaining proof

No new GitHub Actions step or new manifest format is required: selected releases must retain their own `latest.yml`, matching Windows NSIS x64 installer, size and SHA-512. Blockmaps remain part of the normal distribution. Release metadata alone is not publisher code signing; local Windows builds remain unsigned.

The Linux transfer fixture now serves the platform channel name requested by electron-updater. The existing hover test uses a visible Electron process, points inside the card, actual hover activation and the same real PNG capture/write path with or without exported evidence. Motion assertions remain intact. The general renderer fixture now waits for startup initialization and mocks the new startup IPC endpoints. No application hover behavior changed.

Real NSIS upgrade/downgrade, restart into the selected build and preservation of synthetic accounts across that installation still require a disposable Windows VM/Sandbox. Linux/macOS packaging, signed releases and authenticated live Supabase are not certified by the local Windows tests. Never run these installer experiments against the personal installation.

The updater API was cross-checked against [the official NsisUpdater reference](https://www.electron.build/docs/api/electron-updater.class.nsisupdater/). Behavior is verified against the locally installed 6.8.10 implementation and real HTTP/checksum transfers, rather than inferred from a newer documentation version.
