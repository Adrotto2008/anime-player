# Independent franchise links — Phase 3B (0.5.39)

Base: 0.5.38, `7fd2125cfd557e1e964148835cc754533380f9fa`. Branch: `feat/independent-franchise-links-3b`. Work only in the isolated checkout. Do not run old/new builds concurrently on a cloud account, install this build on a personal profile, or repair existing memberships automatically.

## Membership and relationship are different

The existing work UUID and `franchiseMembership` still describe where a work belongs. The additive top-level `franchiseLinks` array describes relationships between two independent franchise identities. A relationship cannot move or delete works. No second persistence layer, database table, dependency or independent classifier is introduced.

`FranchiseModel.evaluateFranchiseRelation` uses the existing `evaluateRelated` directed evidence evaluator. It considers only supported independent work formats; short parented extras, SPIN_OFF/PARENT/SIDE_STORY, contradictory relations and foreign parents do not become external links. Internal classification rules remain in force.

CHARACTER only establishes shared characters. An important crossover proposal additionally requires an AniList **Crossover** tag with rank >=70 and no media-spoiler flag on one of the directly connected works. This is a conservative product threshold on community metadata, not a canon certificate. A lone CHARACTER, weak tag, music/promotional work or incomplete graph stays secondary or outside this section. Generic OTHER does not prove a specific relationship. Explicit ALTERNATIVE, ADAPTATION and SAME_UNIVERSE can supply their respective types where available; the current AniList v2 enum does not supply SAME_UNIVERSE. The manual type selector also supports these types and a generic/manual relationship. No title matching, title blacklist, named-series exception or inferred reciprocal API edge is used.

## Identity, evidence and conflicts

Each link has a deterministic `id` over two sorted endpoint keys. An endpoint uses a canonical AniList franchise-root ID or an explicitly selected local franchise UUID when provider duplicates make automatic association ambiguous. The optional local `franchiseId` is a navigation cache; resolving it never changes the stable key. An absent endpoint remains an external reference, without an empty container.

Link fields include `type`, `origin`, directed `evidence` (original work IDs, edges and tag media IDs), `reason`, `directions`, `available`, `updatedAt` and optional independently timestamped `decision`. Evidence is unioned and retained; automatic metadata updates do not override a manual decision. No manual URL or playback header enters this evidence.

States are suggested, confirmed and excluded. Removal is an excluded manual decision: a logical tombstone, not physical deletion. Scans cannot resurrect it. A vanished automatic proof hides an unconfirmed suggestion while retaining evidence; manual confirmation stays visible. Network failure does not revoke previously known links. Equal timestamp conflicts use a deterministic content tie-break. Clock-based cross-device resolution has the same limits as the existing local membership timestamps.

`Links.mergeLinks` extends the existing private snapshot merge. Compression/expansion already carries additive top-level fields. After an upload, `Links.rebaseDecisions` preserves any later local decision as one atomic object and advances its timestamp above the observed conflicting remote decision. It remains cloudDirty until a subsequent upload confirms it. This prevents a local type edit inheriting a remote exclusion through per-field rebase. The existing Store revision/account/file scope, conditional remote revision updates and library/series/group tombstones remain active; transport, auth, RLS, schema and catalogue logic are unchanged.

## Discovery and canonical roots

Both initial addition and later scans partition independent candidates using the same model and link service. Public metadata tags are retrieved in the existing AniList request. The existing internal resolver/discovery budgets remain (24 chain records, 96 extras, two levels). External canonical resolution additionally has at most 12 uncached candidates per scan, four verified film/chronology bridges per candidate, per-operation caching and bounded existing resolver requests. Missing graphs or network failure retain secondary evidence and allow explicit retry. No retry loop is added.

A target entered through a season or film is normalized only through explicit reciprocal chronology. This identifies the external franchise; it does not widen automatic internal membership. Quartet, Quartet 2, the film and Quartet 3 references converge on the root 104454 in the verified graph. Quartet 1/2 and the film form the initial group; Quartet 3 remains an internal proposal because the normal strict TV chain does not bridge its film. Explicit acceptance can place it inside Quartet. Break Time/RePETIT remain internal spin-off candidates and manual memberships are preserved. Steins;Gate 0's existing alternate-branch membership is not moved.

## Preview and atomic creation

The renderer shows a separate Linked franchises section after internal content, cover/title/type/reason/library status, and specific Create/Open actions. Suggestions can be excluded; Manage link confirms, edits type or removes; manual linking selects an existing container by UUID. To manually link a missing franchise, first create it using normal search or an existing work's management controls. Optional secondary evidence stays collapsed.

Preview fetches metadata and prepares a plan in memory without any Store write, revision increment or queue scheduling. Preview tokens are account/file-scoped, expire after five minutes and have a 32-entry bound. Confirmation rechecks current IDs, existence, tombstones and manual decisions. Concurrent confirmations share a target-specific promise; the synchronous transaction rechecks duplicates against current data. Opening an existing franchise confirms only the link and navigates, without reimport.

New creation reuses ungrouped, unambiguous existing works and preserves their entire saved units. Existing manual detachments, works in another container or duplicate provider works block automatic regrouping with a recoverable error. Use existing Manage content controls to choose/organize the intended UUID explicitly, then open/link that container. Preexisting duplicates are never deleted or merged. A failed transaction restores data/revision; the first additive-format write uses the Phase 2A exclusive backup guard, and backup failure blocks the write. Invalid persisted link identities/structure stop loading without resetting or rewriting the library; invalid imports/cloud data are rejected before application.

Only after a successful atomic file write does source discovery enter the existing queue. Newly created works receive episode metadata in a scoped background task, with visible progress, a 20-second per-work waiting limit, normal IMDb service and no indefinite retries. Late results recheck account/file/group/work IDs and manual membership. Reused works are not re-enriched automatically. Metadata failure leaves a valid playable container and an explicit refresh option; source availability/playback remains governed by previous phases.

## Verification and rollback

`node --test test/franchise-links.js` exercises real Store, addition/discovery/services and private cloud HTTP barriers on temporary synthetic profiles, plus sanitized public graphs. `node test/franchise-links-renderer.js` runs the actual renderer/preload/IPC/service under Electron with isolated userData/sessionData and mock provider metadata, no account or cloud. `npm run check` includes both plus all Phase 2A/2B/2C/3 and legacy suites; `npm run dist` builds Windows portable/NSIS.

For rollback: close the isolated test app/mpv, preserve the full isolated profile and backups, return code to the Phase 3 base, and restore only its pre-test library copy if required. The old version does not manage franchiseLinks; it may discard them during old import/merge. Do not open new data with old binaries or mix versions on a cloud account. No personal library is read, copied, repaired or written automatically. Live two-device cloud, arbitrary provider changes, macOS/Linux builds and personal old misclassifications need separate verification.
