# Phase 7 — release readiness, 0.5.45

Two reproduced defects are corrected: existing malformed/unreadable libraries fail closed before normalization or writes; production Electron IPC accepts only the application's main frame. Navigation, webviews and permissions are denied. A failed library-file load during account switching restores the previous valid Store and invalidates outstanding requests.

The user authorized fail-closed loading. Valid-data schemas and dependencies are unchanged. Tests cover byte preservation, failed switching, access errors, startup failure, cross-feature persistence and real Electron navigation/IPC.

## Release gates

- Unknown top-level JSON fields are dropped on save without a backup when the input already has the current migration fields. The user chose to document this defect rather than change persistence during this audit.
- Logout waits for an outstanding sync promise; a stalled request delays account termination. Reproduced with an isolated simulation. The user chose documentation.
- Electron 33.4.11 is an unsupported shipped runtime with high advisories. npm production-only audit reports zero but excludes this devDependency, which is distributed in the application. Full audit: 18 affected packages, one critical, 13 high, four moderate. No automatic major upgrade was applied.
- Synthetic full refresh at 1,000 works measured about 1.1 seconds; drag avoids full rerenders but this does not eliminate general refresh stalls.
- Live two-device cloud, remote-provider playback, interactive old-to-new NSIS upgrade/uninstall, extended playback and Linux/macOS remain unverified.

Windows offline packages are test candidates, not an authorized release. Original repository integration, publishing, signing and dependency upgrades require a separate decision. Automatic updating is not implemented.

See Electron's [security guidance](https://www.electronjs.org/docs/latest/tutorial/security) and [supported release policy](https://www.electronjs.org/docs/latest/tutorial/electron-timelines). Full evidence and integration/rollback plans are external Phase 7 deliverables.
