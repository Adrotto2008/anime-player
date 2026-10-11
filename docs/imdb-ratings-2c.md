# IMDb ratings — Phase 2C

Base: Phase 2B commit `65625780b0703de55cbf406b1bab8b639976e0d7`, v0.5.36. This change targets AP-01, AP-02 and AP-03. Playback and cloud transport/CAS/rebase code remain unchanged.

## Requests and selection

`src/imdb-client.js` returns `ready`, `empty`, `ambiguous` or `error`, plus chart completeness and an issue code. `src/ratings-service.js` owns the `idle/loading` lifecycle, in-flight deduplication, a five-minute result cache and work/account guards. The renderer releases the pending promise in `finally`, ignores results from a previous account/deleted record and updates the status bar during pagination without rebuilding the matrix. HTTP and JSON parsing have a 12-second request deadline and a 120-second overall budget. The renderer has a final 135-second IPC guard. No automatic retry loop is introduced.

Saved IDs bypass title search. Multiple exact-title candidates require an exact release-year match for a base work; the year of a later season/cour is not used as the original series year. Type distinguishes series from films. Ambiguous candidates expose IMDb ID, title, year, type and cast. Manual selection is restricted to the advertised candidates for the current work/account signature and is stored as additive `imdbSelection` metadata. A newer explicit remote confirmation can replace an older one; automatic metadata cannot. These rules do not claim that title/year alone identify every anime worldwide.

The service remembers confirmed metadata by work/unit UUID within the current account scope. When an old cloud snapshot omits the new field or a confirmed mapping, the metadata policy restores those fields to existing units and marks them as local pending edits through the existing Store revision mechanism. It never resurrects a deleted work/unit or modifies progress, sources, manual headers or personal votes. Cloud transport, snapshot merging, optimistic revision checks and rebase functions are unchanged. Concurrent use of older binaries is already unsupported by Phase 2A; two-device live synchronization is not verified here.

## Pagination and completeness

Each page follows `hasNextPage/endCursor`, with at most 80 pages (250 records per request), and an overall time budget. Duplicate cursor, empty/stalled page, missing page info, GraphQL/HTTP failure, changing totals or final total mismatch produce an explicit incomplete result. IMDb episode IDs deduplicate overlapping pages. Cursors are temporary and are never persisted.

`retrievalComplete` describes the page chain. `complete` also requires usable numbering. `totalEpisodes`, `fetchedEpisodes`, `mappedEpisodes`, `ratedEpisodes`, `pages`, `issue` and `unplacedEpisodes` make partial results explicit. Unnumbered records retain their IMDb ID/title/rating outside the matrix. Season 0 is included; null ratings remain null. The displayed mean uses only rated plotted episodes, while the title's overall IMDb score remains separate. Legacy saved charts without completeness metadata are labelled unverified and remain readable.

## Mapping and performance

`EpisodeRatings.index` indexes coordinates, normalized titles and IMDb episode IDs in one pass. `apply` shares that index across local episodes; `prepare` builds unique targets once. Ambiguous coordinates, IMDb IDs and multiple local targets are not clickable. A confirmed reference uses persistent work/unit/IMDb IDs, survives an incomplete refresh and never transfers to another local unit. New title matches require complete retrieval, including unplaced titles when checking uniqueness; positional ranges require a complete chart. The existing cour restriction and verified Black Clover ranges remain.

The renderer prepares derived ratings at snapshot arrival and caches indexes/mappings for that snapshot. Ordinary renders do not remap the library. New snapshots rebind current JavaScript objects while preserving UUID-based references. Matrix rows use actual numbers present in the data, so a sparse/high episode number does not create thousands of fictitious rows.

Reproduce comparable timings with `node test/ratings-benchmark.js --source=<checkout> --output=<json>`. The harness uses temporary copies, synthetic fixtures, Electron 33 and the same viewport/CSS; production code has no test hooks. It separately measures applying ratings, detached chart construction, DOM insertion plus forced layout and home navigation. `test/ratings-renderer.js` adds a generous one-second construction/layout regression budget at 150/400/1200. The delivery report includes raw before/after data. Timing is diagnostic, not a guarantee for every machine or arbitrary season-by-episode grid.

## Data and rollback

No new dependency, schema migration or cleanup is required. New metadata is additive to the existing JSON schema; work/unit/source IDs and personal data are unchanged. Tests use temporary libraries and no live cloud account. The live IMDb probe only reads public title/episode information.

Before installing the new binary, close Electron/mpv and keep a byte copy of the relevant library/account JSON files and backups, following `docs/data-integrity-2a.md`. For code rollback, return to the Phase 2B commit. Existing backups are not overwritten or removed. A binary rollback keeps unknown additive fields but does not enforce the new selection/completeness rules; restoring a pre-test JSON backup is the reversible data rollback. Never remove duplicates automatically or run old/new binaries concurrently against one account.
