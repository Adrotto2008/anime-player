# Anime Player

Anime Player **v0.5.42** is a cross-platform Electron library for anime links. It stores the
links you add or discover through AnimeUnity and AnimeWorld, displays metadata from AniList and Kitsu, and opens videos
with the external **mpv** player and **Anime4K** shaders. It does not download
episodes. Automatic episode-link discovery tries AnimeUnity first, then AnimeWorld.

## Home and library organization — 0.5.42

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
- AniList currently represents Re:Zero's Memory Snow and The Frozen Bond together as OVA work 100049 with two episode units. Those units retain separate IDs/titles; the application does not invent two provider works or convert them into TV seasons.
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

## Features

- AniList search and series metadata: poster, banner, description, genres,
  year, format, episode count, and AniList score when available.
- AniList PREQUEL/SEQUEL chains group related seasons into one franchise page;
  linked movies remain separate playable records and do not receive synthetic episodes.
- Grouping keeps season records, episode IDs, links, ratings, presets, and watch
  progress independent. Ambiguous relation graphs fall back to the selected title.
- IMDb overall anime score and episode-by-episode ratings across all seasons.
- Visual IMDb episode rating chart/heatmap in the series view (styled after
  Series Graph tier charts: Awesome, Great, Good, Regular, Bad, Garbage),
  recognizing the overall anime franchise across seasons.
- Kitsu episode titles and thumbnails. Missing ratings fallback gracefully; no
  values are invented.
- AniList cast and related-series metadata in a compact series panel.
- AniSkip opening/ending availability is shown per episode after its skip data
  has been checked.
- Episode links are discovered automatically in the background when adding a series, including existing seasons with missing links. AnimeUnity runs first; failures and unusable results still fall back to AnimeWorld. Original AniList titles are retained for matching translated provider titles. Manual retry remains available and preserves saved links and progress.
- HTTP availability checks beside each episode link; redirects and inconclusive responses are labeled separately.
- Direct video links, HLS playlists, local files, and yt-dlp-supported pages.
- Multiple fallback links per episode.
- Signed-in users privately sync their complete library, saved manual links and
  headers, metadata, playback progress,
  deletion records, watch history, and shared app preferences
  across devices. Each account has a separate local library and cloud snapshot.
  Automatic stream URLs stay on the device and are rediscovered.
- Automatic episode-number detection, patterns (`{ep}` and `{ep:02}`),
  newline lists, and `.m3u`/`.m3u8` import.
- Exact playback progress (flushed during playback and on exit), watched state, resume cards, autoplay, and
  per-series Anime4K presets.
- A prominent per-series resume/next-episode action and optional manual opening/
  ending skip buttons. Configure opening and ending durations in each series'
  Advanced options; skipping is always explicit and never automatic.
- Statistics with general totals and per-series details: watched/total
  episodes, completion percentage, calculated watch time, last activity,
  genres, year, format, and score.
- JSON library export/import with validation.
- Responsive default and compact themes.
- Premium streaming-style UI with a violet design system, featured library hero,
  richer continue-watching cards, poster hover actions, and redesigned series
  surfaces.
- Wide desktop composition with a visible cinematic backdrop, denser poster grid,
  stronger section headers, and a compact streaming toolbar.
- Refined navigation, dialogs, settings, statistics, episode actions, and compact
  responsive layouts across the app.
- Clicking an episode rating in the chart opens the anime page and scrolls to that
  episode when it is present in the library.
- Live library search with preserved focus/cursor position, progress filters, and a clear-search control.
- Deleting a series returns to the library with cleared search and progress filters.
- English and Italian UI translations, selectable at runtime and persisted in
  the library. New installations default to English. Existing libraries
  created before language support are migrated to Italian rather than having
  their current experience silently changed.
- Social profiles with nickname/avatar, profile search by email or nickname,
  friend requests, and a friends list. Accepting or declining a request is
  handled atomically; search results update without replacing the focused input.
- Displays the Supabase-confirmed email status on the Social profile.

## Requirements

- Windows 10/11, macOS 12+, or Linux (AppImage and Debian packages).
- mpv is required for playback. On Windows x64 and ARM64, **Configure mpv** can
  ask where to install the official mpv Windows build,
  verify its GitHub release SHA-256, and confirm it starts before selecting it.
  Other platforms can use the official [mpv installation guide](https://mpv.io/installation/)
  and manual executable selection. First-run setup verifies mpv by running
  `mpv --version`, searches the saved path, Anime Player's persistent managed
  runtime directory, PATH, and common locations, and offers manual selection.
  If automatic setup is unavailable, the official [mpv installation guide](https://mpv.io/installation/)
  opens and you can select the executable manually. Anime Player does not run
  package managers or privileged install commands.
- Account creation without email confirmation depends on the Supabase project's
  **Confirm Email** setting being disabled. Supabase treats addresses as verified
  when that setting is off; the setting is controlled by the hosted project.
- Node.js 20.18.1+ only when running from source or building installers.

## Development install

```bash
npm ci
npm start
```

Install dependencies on each computer/operating system; do not copy
`node_modules` between Windows, macOS, and Linux. `npm start` and `npm run dist`
check and repair the platform-specific Electron binary before running, which
also handles incomplete downloads. If installation still fails, run `npm ci`
again with a working network connection. Node.js 22 LTS is recommended.

The first-run setup explains that Anime4K shaders are included in the app, while
mpv is installed automatically on supported Windows architectures when you choose
**Configure mpv**. Choose a folder; the app puts a dedicated copy under `mpv/<platform>-<architecture>` and adds `mpv` to the current user's Start menu. Other platforms can install it separately. Setup asks for the executable and the
default Anime4K preset. **Detect** verifies the candidate's version and ability
to launch; **Browse** does the same before saving a selected executable. **Later**
lets you use the library and other features without mpv. Setup is offered again
when you try to play an episode, and can also be opened from **Settings**.
An optional app-managed copy is searched at
`<userData>/mpv/<platform>-<architecture>/mpv[.exe]`; the stable user-data
location survives app upgrades.

## Installed versus portable builds

Run:

```bash
npm run dist
```

The build targets the operating system where the command runs:

- Windows: portable executable and NSIS installer.
- macOS: DMG and ZIP application packages.
- Linux: AppImage and DEB packages.

Builds preserve previous packages and write Phase 5 outputs into dist-phase5. npm run check runs tests, syntax checks, and whitespace validation without building. Run
`npm run dist` to perform those checks and build packages for the current OS.
Build each platform on that platform; macOS signing/notarization needs an Apple
developer identity, and Windows/Linux cross-builds may need additional tools.

The installed/portable application does not need Node.js, `npm install`, or
`npm start`. The library is stored separately in
`%APPDATA%\Anime Player\library.json`; uninstalling does not delete it.

## Usage

1. Choose **Add series** and search AniList, or add a title manually. Anime
   Player searches AnimeUnity first and AnimeWorld next, adding exact matches;
   you can retry from the series page or add links manually. Open an episode's
   **Links** dialog to check whether each saved URL responds.
2. Select **Watch** or **Resume**. Progress is saved from mpv playback,
   including short sessions stopped before ten seconds.
3. Open **Statistics** for totals, recent activity, and per-anime details.
4. Open **Settings** to configure mpv, language, theme, autoplay, audio and
   subtitle preferences, or extra mpv arguments. In a series' **Advanced
   options**, set opening/ending durations to expose manual skip buttons in the
   player bar.

Opening an AniList-linked series refreshes its online metadata and ratings in
the background. The refresh preserves user-entered links, playback progress,
watched state, and local episode entries. AniList supplies base metadata, while
IMDb supplies the overall series score, per-episode ratings across all seasons,
and the rating matrix chart. API failures leave the last stored values in place.

## Anime4K

The app bundles the Anime4K v4.0.1 shader files and supports the official
Mode A, B, C, A+A, B+B, and C+A Fast/HQ chains plus Off. The default is Mode
A+A HQ, but it can be changed globally, per series, or while mpv is playing.

## Data and privacy

The app keeps an offline local JSON copy of the library and can sync a private
copy to the signed-in user's Supabase account. It contacts AniList, Kitsu, and
IMDb for metadata and ratings, and AnimeUnity/AnimeWorld to search titles and
resolve episode links. Automatic stream URLs remain local; saved manual URLs and
custom headers sync in the private account snapshot.
Anime Player does not download video files.

### Supabase account and sync

The Supabase client runs in Electron's main process, using the `ws` transport
because the app's Electron/Node 20 runtime does not provide a native WebSocket.
Builds are offline by default. Public client configuration is included only when
SUPABASE_CONFIG_FILE is explicitly provided, with exactly url and publishableKey.
No AppData config or implicit environment keys are read by the build. The app
rejects URLs outside the anime-player project; secret and service_role keys are
forbidden. Do not commit local config or .env files.

The app asks whether to sign in or create an account at startup, and the Account
item remains available in the navigation. Auth sessions are encrypted with
Electron `safeStorage` when the operating system provides secure storage.
The full library snapshot (including user-entered links and headers, progress,
watched state, personal ratings, metadata, and deletion records), watch history,
favorites, and shared app preferences are stored in a private, account-owned
Supabase row. Row Level Security restricts that row to its owner. The data is
retried when Supabase is reachable and also remains available offline. Separate
accounts on one device use separate local library files. The mpv executable path
and first-run setup state remain device-specific.

Anime and episodes may also be shared catalog rows. The app matches them by
AniList external ID, season, and episode number for optional catalog-based
progress and favorites. Episode URLs are no longer published to a shared table.
The private snapshot sync does not
depend on catalog rows, so the full library and watch history still sync when
the shared catalog has no matching entries. Social profile queries expose only
selected profile fields; they do not grant access to private library snapshots.
The Social section supports profile nicknames and image URLs, searching by
nickname or exact email, and friend requests. Email addresses are matched in a
restricted database function and are never returned in search results. Manual
URLs (including links without a pattern) retain their saved IDs and headers in
the private snapshot. Automatic provider stream URLs are omitted; identity and
custom header descriptors allow rediscovery. The existing database sanitizer
strips the legacy TV `sources` field while preserving the new `manualSources`
and identity descriptors. No database migration is required by this client change.

Playback events use Realtime Broadcast and Presence; video files are never sent to
Supabase and playback events are not written to PostgreSQL.

## Tests and validation

```powershell
npm test
node test\mpv-manager.js
node --check main.js
node --check preload.js
node --check renderer\app.js
node --check renderer\i18n.js
git diff --check
```

`npm run dist` builds both the portable executable and the NSIS installer.

## Credits

Anime4K shaders are from [bloc97/Anime4K](https://github.com/bloc97/Anime4K)
and remain under their MIT license in `shaders\LICENSE-Anime4K.txt`.
Metadata and ratings are obtained from [AniList](https://anilist.co/),
[Kitsu](https://kitsu.io/), and [IMDb](https://www.imdb.com/).
Episode discovery adapts the search and episode-link workflow documented by
[MainKronos/AnimeWorld-API](https://github.com/MainKronos/AnimeWorld-API), an
unofficial MIT-licensed Python library. Anime Player uses a native JavaScript
client; it does not bundle the Python package. AnimeUnity discovery is an
independent JavaScript implementation informed by the public workflow in
[Lysagxra/AnimeUnityDownloader](https://github.com/Lysagxra/AnimeUnityDownloader)
(GPL-3.0); no Python or GPL source code is copied or bundled.

This is a vibe-coding project developed collaboratively with multiple AIs.
