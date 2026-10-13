# Changelog

This file archives the project version notes, including GitHub comparison links where a release did not include a detailed summary. The README keeps only the two latest summaries.

## Watch Party resynchronization shortcuts — 0.5.56

- `Ctrl+Alt+R` resynchronizes your own player; `Ctrl+Alt+Shift+R` resynchronizes every connected participant when requested by the host. Both can be remapped or disabled on the existing Shortcuts page, with live mpv binding checks.
- The host has a Resync everyone button. This action is independently restricted to the host by the Worker and rejects stale content epochs; granting shared seek/playback permissions does not grant global resynchronization.
- Explicit resynchronization reattaches individually paused players, including the host, and immediately seeks when drift exceeds the configured deadband. A room paused by the host remains paused. Periodic corrections retain the existing gradual speed adjustment and seek cooldown.
- Followers apply the latest room state on source load. Brief real buffering can still occur; the change does not bypass source or edition checks.

## Watch Party — 0.5.55

- Create public code rooms or private rooms with host approval and ten-minute friend invitations. Registered accounts are verified through Supabase; guests use temporary identities. The existing Cloudflare Worker coordinates rooms through SQLite Durable Objects and hibernatable WebSockets.
- Host controls are the default. Hosts can grant shared play/pause, seeking, episode changes and opening/ending skips, moderate participants and revoke room bans. Abrupt disconnects reserve membership for 30 seconds, then a connected participant becomes host. The last departure closes the room.
- Each client resolves its own source through the existing library and provider engine. Files and credential URLs are not transmitted. Missing or incompatible sources require manual selection. Individual pause, Resync, library indicators and mpv notifications are available; `Ctrl+Alt+W` shows RTT and drift and can be remapped.
- Synchronization adjusts mpv speed for small drift and seeks beyond configurable thresholds. The 500 ms target depends on network, buffering and matching editions; it is not a guarantee for arbitrary sources.
- Install Worker development dependencies with `npm ci --prefix watchparty-server` before `npm run check` or `npm run dist`. Release CI prepares a verified draft; final publication and its report reuse those packages.
- See [Watch Party setup, protocol and verification](docs/watchparty.md). The Supabase schema is unchanged.

## Automatic source discovery — 0.5.54

- Provider search now includes verified title aliases beyond the first three queries; strict title, catalogue ID, format, year and episode-count checks still decide whether a result is accepted.
- The two established Re:Zero AniList 100049 components (Memory Snow and The Frozen Bond) resolve independently to their existing canonical episodes using component titles, years and MAL IDs. Provider work/unit IDs and provider episode numbers remain attached for safe renewal; no library identities or progress are merged.

## Five-second recovery — 0.5.53

- Stalled playback switches links after 5 seconds, including an unfinished seek; there is no additional seek grace. The next eligible provider is preferred, preserving observed time and language.

## Source engine and interrupted playback — 0.5.52

- Automatic discovery now uses the independently tested source laboratory engine: strict title/catalog identity, complete pagination, validated TLS/DNS/redirects, and literal parsing of provider data. HLS and direct files retain separate stable identities. StreamingCommunity stays disabled.
- A remote source that stops advancing for 5 seconds triggers recovery, checked every second. Seeking uses the same 5-second threshold. Intentional pause, navigation and normal EOF do not. A stall immediately tries another eligible source of the same library item; network errors may renew the original source once.
- Recovery preserves the observed time and requested language, rejects incompatible duration or an unfulfilled resume seek, and stops after finite attempts. A different edit can still share a similar duration; matching durations do not prove frame-exact alignment.
- A private local proxy keeps provider cookies/Referer and HLS keys out of mpv URLs. Highest compatible HLS resolution is selected from the manifest; real mpv tracks are checked separately. Manual URLs, library UUIDs, ratings and franchise relationships remain intact.
- See [source recovery and verification boundaries](docs/source-recovery.md). Windows builds and bounded live tests do not certify a full-film uninterrupted viewing session.

## Account password recovery — 0.5.51

- The sign-in dialog includes “Forgot password?”. Anime Player sends Supabase Auth's recovery email without revealing whether the address belongs to an account.
- The email link opens Anime Player through the `animeplayer://auth/reset-password` protocol. The app verifies the Supabase session, prompts for a new password, and updates it through Auth.
- Add `animeplayer://auth/reset-password` to the Supabase project's Authentication → URL Configuration → Redirect URLs before enabling this build. Recovery email delivery also depends on the project's email provider and recovery template.

## Versions and persistent mpv setup — 0.5.50

- Versions is a main navigation page with release history, pagination, explicit release selection, automatic/manual/pinned modes and optional startup notifications. Existing preferences are preserved.
- Selected releases use their own official manifest and package with SHA-512 verification. Windows NSIS x64 downgrades to audited 0.5.47–0.5.49 are supported; older or unaudited formats are blocked. Backup is required; full rollback is not guaranteed.
- Device configuration is completed only after mpv validation and persisted independently of account libraries. Missing configured executables trigger repair. Dismissal leaves setup incomplete. Startup notifications wait for dialogs and playback to finish.
- See [version selection, compatibility boundaries and mpv persistence](docs/version-management.md) for implementation and remaining installation tests.

## Home banner color — 0.5.49

- The large featured banner on Home now has a teal overlay, making this release easy to identify while keeping the current anime artwork and text readable.

## Startup update popup — 0.5.48

- Each launch with automatic checks enabled shows a blocking popup when a newer valid release is found. Update downloads and restarts when playback is stopped; Close dismisses the popup for this session without scheduling installation. The same available release is offered again on the next launch.
- The popup shows progress and plain-text release notes. Downloads may continue during playback or after dismissal; installation still requires stopping playback and an explicit action. Portable/DEB link to the official release instead.

## In-app updates — 0.5.47

- Versions checks the fixed official GitHub repository, shows release notes, downloads with progress, and offers restart or installation on the next voluntary exit. Startup checks are delayed and optional; playback blocks restart. Portable and DEB display explicit alternative paths.
- electron-updater verifies downloads; the app rechecks the cached SHA-512 before installation. Shutdown awaits playback progress/save and creates verified backups of durable profile files. Library schemas, identities, account files and encrypted sessions retain their existing paths.
- Tag-triggered GitHub Actions builds Windows/Linux and optionally signed macOS, verifies complete artifacts, uploads to a draft and publishes only after verifying uploads. Cloud releases require an explicit public config variable; unsigned macOS releases are excluded.
- Windows x64 builds are verified locally. Real upgrade/installation, remote publication, Linux and macOS await the documented external tests; previous release gates still apply. See [configuration, first release and verification boundaries](docs/automatic-updates.md).

## Pre-release blockers — 0.5.46 (Phase 7B)

For a cloud-enabled Windows package, build with an explicitly supplied public configuration: set `SUPABASE_CONFIG_FILE` to a JSON file containing `url` and `publishableKey`, then run `npm run dist`. Verify the resulting packages with `node scripts/verify-windows-packages.js <report.json> <same-config.json>`. Without that input the build deliberately remains offline. The verifier checks the bundled configuration without logging the key; never supply credentials or secret keys.

- Recognized root fields are explicit, including optional legacy fields. Unknown root data fails closed before load, import, merge, cloud transfer or replacement. Original files remain intact; failed backups stop transformations.
- Logout immediately invalidates account requests and preserves the departing account's local outbox. Remote session revocation is limited to five seconds and reported separately; late replies cannot alter a newer account or login generation.
- Electron is pinned to 44.7.0, electron-builder to 26.15.3; a build-only global-agent 4.1.3 override removes the remaining vulnerable logging chain. Sandbox, context isolation and IPC restrictions stay enabled. Source/build tooling requires Node.js >=22.12.0.
- Offline Windows candidates remain separate from the original repository. Live cloud, interactive upgrade/uninstall, long sessions and Linux/macOS are not certified. See [decisions, compatibility and remaining release gates](docs/pre-release-blockers-7b.md).

## Stabilization audit — 0.5.45 (Phase 7)

- Existing unreadable, truncated or structurally invalid library files stop opening with a clear error and retain their original bytes. Only a missing file starts a new library. A failed account-file switch restores the previous valid Store and invalidates old requests.
- Every production IPC validates the originating window, main frame and application entry. External navigation, webviews and permissions are blocked; ordinary HTTP/HTTPS guide links remain available through the browser.
- Regression fixtures exercise corrupted files, account-switch failures and real Electron navigation/IPC isolation. No library schema migration, dependency upgrade, live cloud test or integration into the original repository is performed. See [release readiness and remaining gates](docs/release-readiness-7.md).

## mpv shortcuts and manual skips — 0.5.44 (Phase 6)

- Settings → Playback → Shortcuts captures combinations directly, validates conflicts and supports disabling or restoring each action. Default skips are Ctrl + Shift + o / e; Page Down / Up change episodes. Existing saved custom or empty values are retained.
- Native weak mpv Lua bindings work in fullscreen and update during playback. The application no longer overrides or writes input.conf; personal strong bindings are protected by live conflict detection. ASCII case preserves mpv Shift semantics.
- Manual skips use the current episode's known opening/ending intervals and actual mpv time/duration, with exact seek, bounded OSD and guards against repetition, old episodes and late replies. Missing data never produces a guessed seek.
- Isolated Windows tests cover real mpv, Electron capture, live preferences, private snapshot roundtrips and prior playback/card regressions. Packaging remains Windows x64 portable/NSIS, offline, in `dist`. See [architecture, rules and verification limits](docs/mpv-shortcuts-6.md).

## Physical cards — 0.5.43 (Phase 5B)

- Cards can be dragged directly during ordinary navigation, with an 8 px mouse threshold and a 380 ms touch hold. Brief clicks open content; internal buttons, search, menus and collection management remain available. Home section headings also support direct dragging. No Organize mode or visible corner handles remain; cards keep the default system cursor.
- Pointer position drives restrained 3D hover with damped springs. Dragged cards follow the pointer directly and tilt with velocity; neighboring cards spring into the preview position, including direction changes. Release lands the lifted card before refreshing the view; Escape and invalid destinations animate back without saving.
- Keyboard reorder controls appear on focus: Space/Enter picks up, arrows move, Ctrl + arrows changes compatible sections, Enter commits and Escape cancels. Reduced motion removes tilt, lift and animated movement. Existing organization transactions and explicit membership confirmation remain in use without a data schema change.
- Visible Windows Electron tests include temporal frame sequences and synthetic 100/400/1000 card benchmarks. Packaging is offline into `dist`. See [Phase 5B architecture and manual verification](docs/physical-cards-5b.md) for scope and remaining limits.

## Home and library organization — 0.5.42 (historical Phase 5)

- Organize mode provides separate pointer/touch handles, a moving preview, animated neighboring cards, clear drop targets, edge scrolling and Escape cancellation. Keyboard: Space/Enter picks up, arrows move, Ctrl + arrows switch compatible sections, Enter saves. Reduced motion skips reorder animation; normal card navigation and management menus remain available.
- Home sections, library franchises/standalone works, continue/recent cards and works within franchise categories retain manual ordering. Explicit visual collections organize library cards without changing AniList metadata, franchise membership or linked franchises. Empty categories/collections become drop targets in Organize mode. Category changes and detachment show a confirmation and use existing membership validation.
- Additive organization preferences have their own per-list, per-placement and per-collection timestamps. Relative drop commands operate on current IDs, retain unseen/concurrently added works and reject stale membership, anchors or account scopes. Background saves defer DOM replacement during drag. Import/export, reopen and private snapshot sync retain the layout; late acknowledgements rebase entire preferences and membership decisions and keep unsent edits pending.
- Real visible Windows Electron tests cover mouse/keyboard, emulated touch, animation, cancellation, background updates, responsive windows and reduced motion, with synthetic 100/400/1000-work benchmarks. Node tests exercise rollback and held CloudService requests. No new dependency, schema migration, personal data or live account is used. See [Phase 5 design, conflict rules and safe manual checks](docs/home-organization-5.md).
- Windows portable and NSIS outputs for this phase use `dist-phase5`; earlier packages are preserved. Builds remain offline by default.

## Phase 4 completion — 0.5.41

- Descriptions always show the saved original (or legacy description). Automatic translation is a retired product feature. No translation IPC/request or language selector remains; existing translation caches and preferences are retained as archival data through refresh and import/export/cloud.
- Source runs use the checkout-local, ignored .isolated-user-data profile. They never open the installed personal app profile or inherit Supabase keys. Packaged app profiles retain their normal behavior.
- npm run dist builds Windows x64 portable and NSIS into dist-phase4-complete. Builds default to offline with an empty bundled Supabase config, replace stale checkout build resources without reading them, and never consult AppData. No previous packages are deleted.
- To opt into public client configuration, explicitly set SUPABASE_CONFIG_FILE to a JSON file containing only url and publishableKey. Private/secret/service_role keys, credentials, session fields and credential-bearing URLs are rejected. Neither implicit SUPABASE_URL nor key environment variables are packaging inputs. The build does not log keys or contact Supabase. This completion was built offline.
- See [Phase 4 report and isolated manual plan](docs/async-loading-descriptions-4.md).

## Independent linked franchises — 0.5.39

- Membership and franchise links are separate. Linked franchises appear after internal categories, with Create franchise / Open franchise, an immutable preview, explicit confirmation, exclusions and manual type editing. A link never moves or deletes works.
- Directed AniList IDs and evidence govern relevance through the existing classifier. CHARACTER alone stays secondary; an explicit high-ranked Crossover tag supplies independent evidence. Films and seasons resolve to a shared external root where reciprocal chronology proves it. No title blacklist or Quartet-specific rule is used.
- Stable link IDs, independently timestamped manual decisions and exclusions survive import/export, refresh and cloud conflicts. Edits during upload are rebased atomically and remain pending. Creation rechecks identity, reuses safe ungrouped works, commits atomically and blocks ambiguous duplicates or manual membership conflicts.
- No personal profile or live cloud data is used. See [Phase 3B architecture, limits and rollback](docs/franchise-links-3b.md).

## Work relationships and classification — 0.5.38

- Initial movie imports and later relation scans share one AniList evidence policy. Reciprocal side-story/parent or prequel/sequel links can associate films and extras; conflicting parents, mixed relations and incomplete metadata remain proposals. Titles alone never establish membership. Later scans use the same bounded season resolver as initial addition.
- Work format, persistent UUID and display category remain separate. ONA side stories stay out of main TV seasons, and Break Time stays a spin-off. Isekai Quartet retains its own group and character-sharing links without importing the originating universes. Steins;Gate 0 is exposed through the explicit alternate 23β episode as a separate proposal, not invented as television season 2.
- AniList represents Re:Zero's Memory Snow and The Frozen Bond together as OVA work 100049 with two episode units. Source discovery resolves the existing provider entries using their separate MAL IDs and maps each to its existing episode; it does not create or merge library works or convert them into TV seasons.
- Existing Manage content controls now include an optional relationship label (cour/part, prequel, sequel, spin-off, crossover, remake/reboot and others). Manual category, label, order and detachment take precedence through refresh, reopen, import and cloud snapshots. Provider evidence and concise reasons appear on cards/details; uncertain alternatives are not claimed as proven remakes or reboots.
- No destructive migration, automatic duplicate cleanup, schema change or dependency is introduced. Tests use sanitized public AniList graphs and isolated synthetic libraries. See [Phase 3 decisions and rollback](docs/relation-classification-3.md) for scope and limitations.

## IMDb chart reliability and performance — 0.5.37

- IMDb requests have explicit loading, ready, empty, ambiguous and error states with bounded timeouts and page progress. A failed or partial refresh keeps the last available chart; Refresh works without concurrent duplicate requests. Chart requests no longer wait for AniList/Kitsu.
- Saved IMDb IDs are respected. Exact title, work type and the original work's release year distinguish titles such as One Piece (1999/2023). Insufficient evidence shows candidates with ID, year, type and cast for a saved explicit choice.
- Chart and local-unit indexes replace nested per-cell searches. Snapshot updates prepare derived ratings once; navigation reuses mappings. Confirmed mappings, cour safeguards and the Black Clover crosswalk remain intact. Partial pages cannot prove new title uniqueness or a complete season range.
- Cursor pagination supports more than 1,000 episodes and checks totals, empty/missing pages, duplicate cursors and finite limits. Season 0 and unrated episodes remain visible. Records without usable IMDb numbering are retained separately and reported; no numbers or votes are invented.
- Synthetic Electron benchmarks cover 150, 400 and 1,200 episodes. Regression tests retain the Phase 2A/2B suites and cover errors, ambiguity, pagination, object replacement, navigation, cache reuse and account changes. See [Phase 2C notes](docs/imdb-ratings-2c.md) for limits and rollback.

## mpv playback reliability — 0.5.36

- Play is cancelled from the IPC entry point through mpv checks, AniSkip and URL renewal. Stop, newer Play, requested-content deletion and account switching invalidate older requests while active source fallbacks retain their generation.
- Playback progress is saved every five seconds, on pause/seek and at exit. Electron waits for the final bounded player stop and library flush; checkpoints preserve Phase 2A local revisions and pending cloud edits.
- Settings → Player diagnostics shows the last 50 redacted session records, including observed EOF/quit, app intent, IPC/loading timeouts, source/network evidence and abnormal exits. An unknown termination stays unknown until evidence is available.
- Regression tests include real headless mpv and Electron shutdown with synthetic data. See [the Phase 2B technical notes](docs/mpv-reliability-2b.md) for timing, diagnostics, limits and rollback.

## Data integrity and concurrent cloud synchronization — 0.5.35

- Movie and one-shot OVA/ONA/special playback skips TV AniSkip requests. Episode skip updates address the saved unit ID and cannot create a missing unit. Repeated refresh/migration retains IDs and does not recreate units deleted with the new tombstone metadata.
- Cloud merging uses work and unit UUIDs. Distinct cuts/episodes remain independent even when they share `single`, a release key or a number. Ambiguous source imports stop for explicit review; existing duplicates are preserved. Sources acquire stable IDs retained through object replacement, URL renewal, import and provider rediscovery. Custom headers and manually classified links remain attached to their source.
- A Store revision and account/file scope protect requests in flight. Acknowledgements clean only the transmitted revision; subsequent edits/deletions are rebased by ID, persisted and left pending for another sync. Conditional remote revision conflicts retry without replacing local data. Personal rating edits/clears have their own timestamp. Stale responses from another account are discarded throughout the sync pipeline, and playback flushes before switching libraries. Later anonymous edits are no longer erased by signing in again.
- Private snapshots preserve all manual URLs, IDs, headers and classifications, including opaque links. Automatic stream URLs stay local; provider identity descriptors preserve saved IDs and custom headers for rediscovery. Old pattern-only snapshots remain readable. Concurrent use of older binaries against this snapshot format is unsupported.
- The optional shared numbered episode catalogue skips ambiguous multiple local units targeting one remote row. Their independent progress still syncs through the private UUID snapshot.
- The first structural migration write creates an exclusive backup of the original file bytes; import and account transfer have separate rollback copies. A failed backup blocks that write. No automatic duplicate cleanup is performed. See [backup and rollback procedure](docs/data-integrity-2a.md).
- Isolated regression tests hold HTTP requests at explicit barriers and cover playback, AniSkip failures, refresh/reopen/import, duplicate keys/numbers, renewal, upload edits/deletions, revision conflicts, account changes and backup failure. Existing real mpv and Electron checks also run. No personal library or live Supabase account is used; live two-device synchronization remains unverified.

## Manageable franchises and linked content — 0.5.34

- Franchises are persistent entities with stable IDs, title, cover, banner and suggestions. Existing group IDs and saved work/episode IDs remain intact. Separate Seasons, Movies, OVAs and specials, Spin-offs and Other content sections appear only when populated. Manual membership, category, order and per-field artwork/title changes survive metadata updates and cloud snapshot conflicts.
- Group management supports adding an AniList work or an existing library record, moving, detaching, reclassifying and reordering. Merge previews identify repeated AniList IDs; merging requires an explicit choice to keep duplicate records standalone, preserving every record's independent links, progress, ratings and preferences. The destination artwork/title is used, and source group custom metadata is archived in the merged entity.
- Complete deletion confirms the name and counts for all categories, stops member playback, cancels queued sources and rejects late metadata/discovery writes. Series and group tombstones prevent stale snapshots from recreating deleted groups. The renderer remains responsive to native keyboard search after confirmation or cancellation.
- Related-work discovery follows trusted works for at most two additional levels and 96 related records. Confirmed parent/side-story evidence can add movies, OVAs and specials; spin-offs, summaries, alternatives and ambiguous links are proposed for confirmation and never traversed into another franchise. A work appears once per group; legacy duplicate records remain accessible for explicit conflict handling. Size/depth limits are shown, with manual search available for additional works.
- Movies and one-shot OVA/SPECIAL/ONA records use file/part units instead of synthetic television episodes. Existing single-work episodes and old movie links migrate without changing saved IDs, progress, ratings or headers. Removed migrated links stay removed on restart. Complete-film releases and multipart releases remain separate, including a complete DUB version versus split SUB files. Each provider multipart release keeps its own layout: equal file counts do not prove identical cuts. Episodic OVA/specials retain their ordinary episode structure.
- Each work exposes source search and manual links, video language preference, managed playback, signed URL renewal, fallback and progress. Provider numbering remains separate from file identity. AnimeWorld checks detail-page format/external IDs for exact aliases whose movie/OVA marker is omitted; insufficient format evidence, TV conflicts, recap/remake conflicts and ambiguous candidates remain rejected. Search can retrieve the franchise prefix of a colon-delimited film title without using that prefix as identity evidence.
- New entities, manual membership and film progress/manual links survive import/export and cloud snapshot merging; automatic film URLs stay local and are rediscovered. No Supabase schema/auth change is needed. Old binaries do not manage the new entities; concurrent use of older versions is not supported. Film/part progress uses the library snapshot, without inventing entries in the cloud TV episode catalogue.
- Isolated regression libraries cover migrations, reopen/import/cloud merge, all management operations, duplicate preservation, async cancellation, file layouts and source lifecycle. Real mpv fixtures exercise AU failure → AW same-language fallback and renewal. Bounded live probes observed playback of AniList 192809 on AnimeWorld and Naruto movie 442 (SUB) on AnimeUnity; Naruto DUB resolved but was not played. Live One Piece graph discovery kept Monsters as a proposal. Other provider works, live two-device cloud synchronization and GPU Anime4K rendering remain unverified.

## Franchise roots and one-shot prequels — 0.5.33

- AniList's PREQUEL/SEQUEL relations describe story chronology. A known single-episode work no longer counts as a season or leads traversal into another series. Adding One Piece keeps AniList ID 21 as the main record and franchise root; Monsters (ONA, one episode) is not automatically imported as its first season. Episodic ONA seasons, including unknown episode counts, remain supported. Missing, truncated, cyclic or branched season graphs fall back to the selected title.
- Existing groups rooted in a one-shot are repaired on load, import and cloud application only when saved relations prove one unambiguous remaining season chain. The series and its movies receive the proper root; the saved one-shot remains a standalone record. Only grouping fields and their timestamps change; saved IDs, links, headers, progress, ratings, covers, video preferences and Anime4K presets are retained. No provider resolver or playback changes are needed.
- Tests use a sanitized real AniList graph and isolated libraries for exact selection, one-shot boundaries, ONA seasons, uncertain graphs, startup/reopen/import/cloud repair and preserved user data. Personal library files are read only for diagnosis and integrity verification; live cloud synchronization is not exercised.

## Dubbed releases and long-series links — 0.5.32

- A single audio track in a provider/manual-declared version keeps that version's classification when the container tag disagrees. The player selects the same track and shows a metadata warning; it retains both the declaration and observed tag without claiming verified spoken language. Multi-track ambiguity and release-name-only suggestions still cannot override conflicting tags automatically.
- One Piece E1 AnimeWorld already resolved to `OnePiece_Ep_001_ITA.mp4`; the 0.5.31 failure was caused by its single audio track tagged `en`. A bounded live mpv probe now observes playback through PlayerManager with Italian selected. HEAD returned 200 for the provider's three-digit URL and 404 for the four-digit spelling. No permanent stream URL or credential is stored in tests/documentation.
- Cloud manual templates are fitted against observed URLs, so three-digit padding does not disappear when most episodes are numbered 100 or higher. A consistently classified template uses its own observed episode range rather than the full series range, avoiding synthetic DUB links past the known DUB range; legacy unclassified templates keep their existing range behavior. Provider URLs are still copied as returned, with no padding inferred from AniList totals.
- AnimeUnity pagination no longer stops at 500 episodes (bounded at 10,000). Fixtures cover SUB 1180/DUB 938, three versus four digits, missing DUB E939, persisted conflicting tags, cloud/manual padding and full DUB pagination. Real local mpv fixtures cover a mislabeled single track and retain the existing multi-audio/fallback tests.

## Per-season video languages — 0.5.31

- Each season saves Automatic, Italian, or Japanese with Italian subtitles. The compact selector counts episodes with resolved/classified links; unresolved embeds do not count. Old links remain unclassified and Automatic keeps its existing fallback behavior.
- Both providers retain safe SUB and DUB matches as separate sources for the same library episode. Explicit preferences try AnimeUnity, AnimeWorld, then classified manual links within that version. Other versions and unknown-language links require an explicit, single-use choice for that episode; Stop, a new playback request or preference change cancels pending consent.
- Provider declarations, release-name suggestions and manual classification remain separate from mpv's observed track tags. A release label is not verification of spoken language or subtitle content. Multi-audio files use native mpv audio/subtitle IDs and remain one source. Strict playback starts paused until track selection; contradictory audio tags reject that source. Hardcoded subtitles and tracks without language tags rely on the declared/suggested classification and are not reported as verified language.
- Stable provider episode/server IDs coalesce signed URL rotation without conflating SUB/DUB. Editing retained links preserves metadata and custom headers; URL changes clear playback and track observations. Saved links, progress, ratings, covers, Anime4K and existing renewal remain intact.
- Preferences carry a field timestamp for deterministic cloud conflict resolution independent of metadata refresh. Null/legacy fields cannot replace valid choices. Compact cloud snapshots retain preferences and consistent manual template classifications; automatic sources are rediscovered as before. No Supabase schema/auth change is needed.
- Isolated fixtures cover version availability, priority, failure/consent, renewal/deduplication, migration, reopen/import and two-device cloud conflicts. Real mpv plays a locally generated multitrack Matroska over local HTTP, testing expired-URL refresh, AU 403 → AW Italian and preference switching to Japanese/Italian subtitles. Electron tests exercise the native keyboard selector, availability, consent and cancellation. No personal library or live account is used. Live provider audio content and live two-device cloud synchronization remain unverified.

## AniList request limits — 0.5.30

- Search, franchise traversal and metadata refresh share a paced queue. HTTP/GraphQL 429 responses respect Retry-After and X-RateLimit-Reset, with bounded retries and a useful retry time when the service remains unavailable.
- Identical requests share in-flight work; successful search results and media records are cached briefly in memory. Adding a search result reuses its metadata instead of fetching the same record again. Errors are never cached as valid metadata.
- If franchise discovery stays rate limited, the selected cached anime can still be added; the app explains that related seasons require a later retry. A missing cached record fails before writing the library.
- Tests simulate rate limits and check preserved user data; the fix does not require resetting the library.

## Season recognition — 0.5.29

- Both providers retain AniList/MAL IDs and available format/release metadata. Conflicting IDs, years, counts, seasons, parts and media variants veto a match.
- Structured matching understands ordinal seasons and numeric suffixes without deleting numbers or subtitles. Missing story arcs/first parts need independent identity or year/count evidence; Part 2 cannot silently become an unsplit season. Ambiguous candidates remain unselected.
- Generated season/franchise search queries improve retrieval, including capped AnimeWorld quick search. Franchise order is never assumed to be a season number. The verified 0.5.27 aliases remain available.
- Diagnostics distinguish missing titles, rejected candidates, missing episodes, unresolved URLs, and resolved links whose playback is still unverified. Existing sources, progress, ratings, cloud records, Anime4K and stream renewal are preserved.

## Source lifecycle and mpv window fixes — 0.5.28

- Unresolved AnimeUnity embeds are reported as found URLs and excluded from automatic playable-source import. Resolution is separate from playback observed by mpv.
- Signed automatic URLs are refreshed before playback using provider episode IDs (legacy links repeat strict discovery for that episode). Token rotation updates the existing automatic source and clears verification of the previous URL; manual links, custom headers, ratings and progress are preserved.
- Failed source state and redacted mpv diagnostics retain exit codes. IPC end-file errors trigger fallback even when mpv exits with code 0; a 30-second loading timeout prevents indefinite startup. Another provider is tried before duplicate cached tokens, and Stop cancels pending refresh.
- Verified aliases for specific AniList IDs resolve Black Clover 2 and Re:Zero 2/2 Part 2/3/4; exact-title, year, episode-count and ambiguity checks remain in force. Diagnostics retain candidates and exclusion reasons.
- Repeated episode thumbnails remain visible without changing their design. Live Re:Zero Season 2 has only one Kitsu thumbnail; AniList returns episodes 51–66, which cannot safely fill this season.
- Tests include real mpv HTTP 403 → alternative-source playback, URL rotation/import, strict matching, protected user data, and an Electron check that duplicate thumbnails remain visible. Live bounded probes observed E1 playback on both providers for Monster, Black Clover 2 and Re:Zero 2, 2 Part 2 and 4. Other episodes and the original intermittent Monster failure remain unverified.

## Regression audit — 0.5.26

- AnimeUnity retains records whose title is only in `title_eng`; AnimeWorld uses its full search page when quick search omits an exact title, including Monster. AniList aliases include native titles and synonyms. Conflicting or ambiguous matches are rejected.
- Provider diagnostics distinguish titles without a safe match, missing episodes, HTTP/parsing errors, found URLs, resolved URLs and playback actually observed by mpv. Discovery remains independent for both providers and keeps saved links and headers.
- Adding an AniList result opens that exact record. Franchise grouping preserves every AniList ID and uses explicit season labels; cour/part order does not define an IMDb season.
- IMDb ratings and chart navigation share an explicit episode mapping. Black Clover's AniList record `97940` covers episodes 1–170 across IMDb seasons 1–4; AniList sequel `195604` corresponds to IMDb season 5. Missing or uncertain episode mappings do not receive an IMDb rating.
- Metadata refresh and cloud snapshot merging retain existing covers and measured durations. Episode duration from mpv has priority; metadata-only duration is labeled, and series average duration is stored separately.
- Deletion uses an asynchronous renderer dialog and clears stale selections without reloading. Regression tests exercise Windows Electron keyboard input after deleting a season, the last season and a standalone title. The original reported native-dialog freeze was not reproduced, so this specific incident remains partially verified.
- `npm run check` includes provider fixtures, metadata/cloud regression tests, mpv IPC/playback when installed, and Electron DOM/input tests. Linux without a display explicitly skips the Electron UI suite; run it under xvfb or a desktop session.
## v0.5.22

The original release notes linked to the [full comparison with v0.5.19](https://github.com/Adrotto2008/anime-player/compare/v0.5.19...v0.5.22) without listing individual changes.

## v0.5.19 — mpv setup and source discovery

- More robust mpv setup checks the saved path, Anime Player’s persistent managed copy, `PATH`, and common locations. It verifies the executable’s version and that it starts before saving the path.
- First-run setup can open the official mpv guide, let you select the executable manually, or be postponed. If mpv is missing, setup is offered again when playback is requested.
- AnimeWorld source discovery runs automatically for added series; manual links remain available.
- Friend-request acceptance and rejection are handled atomically.
- The release provided Windows x64 packages; mpv was not included or downloaded by the app.

## v0.5.15 — early social update

The release notes describe this as a “social network” update but do not list individual changes.

## v0.5.3

The original release notes link to the [comparison with the initial public release](https://github.com/Adrotto2008/anime-player/compare/AnimePlayer...v0.5.3) without an itemized summary.

## v0.3.0 — initial public release

Initial public release.
