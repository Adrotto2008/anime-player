# Work classification and relationships — Phase 3

Base: Phase 2C, 0.5.37, `89b6c0f9b12d47c3102800731defde6e167af460`. Scope: AP-11. Release: 0.5.38. Work only in the isolated checkout; do not install or sync this build on the personal profile automatically.

## One policy, separate identities

`FranchiseModel.evaluateRelated` evaluates directed AniList edges by provider ID. Both `resolveFranchise` movie imports and `discoverRelatedWorks` call it. The existing season resolver still requires a complete, unbranched PREQUEL/SEQUEL graph; it uses the same model's season formats and weak-relation exclusions. Later franchise scans also call that resolver before discovering extras. No title match establishes a relationship.

AniList describes PARENT as the media a side story is from, SIDE_STORY as a side story of the parent, CHARACTER as sharing at least one character, ALTERNATIVE as an alternative version, and SPIN_OFF as a different primary focus. The live GraphQL enum descriptions and minimized graphs were read on 2026-10-11; the API does not expose a reliable separate remake/reboot enum or a cour identifier. A CHARACTER edge alone is not proof of a crossover. Chronological edges do not by themselves prove a TV season or an IMDb numbering scheme.

An automatic movie/extra association requires either SIDE_STORY/PARENT corroboration on the same pair of IDs or reciprocal PREQUEL/SEQUEL. A parent outside the trusted group, contradictory chronology, weak/mixed relations or missing metadata prevent automatic import. The policy distinguishes edge direction: a parent series is not labelled as the spin-off referring to it. Extras use movie/special display categories without changing format or local unit structure. ONA side stories and short-form parented extras are not main-season anchors. PARENT alone does not prove SPIN_OFF: direct Break Time addition reads the explicit reverse SPIN_OFF edge from the fetched Re:Zero parent, using the same evaluator.

`franchiseEvidence` records provider, directed edges, reason, descriptive kind and any bridge path. It is additive metadata and does not become content identity. Existing categories remain season/movie/special/spinoff/other. A part/cour label requires explicit chronological evidence as well as a Part marker; it is descriptive, not a new identity or invented episode/IMDb season number.

Weak links never become trusted traversal anchors. One alternate one-shot can expose one more PREQUEL/SEQUEL/ALTERNATIVE step as a proposal, within the existing two-level/96-item budget. It cannot import that proposal or traverse character/spin-off relations into other universes. Accumulated evidence is reconsidered before returning results; descendants of revoked automatic anchors cannot retain automatic proof. Missing/truncated graphs stay incomplete. Network failure propagates through the existing error handling; no retry loop is added.

## Reference cases

- Steins;Gate 9253 → ALTERNATIVE 21624 (23β) → SEQUEL 21127 (Steins;Gate 0). Steins;Gate 0 is an explicit alternate-branch proposal, not TV season 2. The user can attach it as Other or retain a separate work. Movie 11577 has a parent relationship to 9253 and stays a movie; OVA 10863 and ONA 20907 remain extras.
- Re:Zero 21355 → Season 2 108632 → Part 2 119661 and the subsequent saved provider chain. Break Time 21780 is SPIN_OFF, including direct addition, never a regular TV season. AniList represents Memory Snow and The Frozen Bond as OVA 100049, count 2. Preserve two existing episode units with separate UUIDs/numbers; do not create two provider works or change format to MOVIE. The fixture uses named episode metadata to verify distinct titles when available. A live Kitsu probe returned mapping 13882 (Memory Snow), only episode 1 with an empty title; full names for both units are therefore not verified or invented. Missing names retain their separate unit numbers.
- Isekai Quartet 104454 and sequel 110178 have their own main group. CHARACTER links to Overlord, Re:Zero, KonoSuba and Youjo Senki remain independent proposals/links. The film 117074 has a reciprocal sequel relation and stays a movie. Quartet 3 follows that film and may require confirmation because the strict TV-only chain does not bridge a film into another TV season.
- One Piece/Monsters regressions remain: a one-shot prequel does not become a season/root. Unknown counts, cycles, branches and inconsistent graphs remain conservative.

These are provider graph facts and application choices, not claims about canon or a universal viewing order. Provider corrections may change later results. Generic ALTERNATIVE cannot reliably distinguish remake from reboot; explicit user labels can.

## Manual precedence and asynchronous safety

Existing membership controls add an optional `role` for main/prequel/sequel/part/side-story/spin-off/crossover/remake/reboot/alternative/independent relationships. The validated role is retained inside the existing independently timestamped manual membership. The existing cloud manual-precedence rule and Phase 2A revision/rebase mechanism preserve it; no cloud transport, schema, auth or RLS change is required. Provider hints can update without overriding that membership.

Automatic re-add/scan preserves an unchanged member's order and does not generate another membership mutation. Works already in another group are not moved automatically. Different saved UUIDs remain separate, including preexisting duplicate provider IDs; no cleanup or merging is performed. Initial lookup and scans capture the Store account/file scope, and in-flight deduplication includes scope. Late results cannot populate another account. Re-check manual choices after asynchronous metadata retrieval.

Existing erroneous automatic memberships are not broadly repaired on load. The new policy governs new additions/discovery; the user can inspect evidence and correct existing placements using Manage content. This avoids an unreviewed migration of personal data.

## Verification and safe rollback

`node --test test/relation-classification.js` exercises actual resolver/discovery/Store/addition/service/cloud functions on temporary synthetic data and the sanitized AniList fixture. It covers conflicting parents, reciprocal and contradictory chronology, OVA/ONA/specials, weak relations, independent movies, same titles/different IDs, real reference graphs, repeat scans, new seasons, manual edits during scan, account switches, reopen/import/cloud and protected UUID/source/header/progress/vote fields. The existing real Electron test checks manual role selection and its visible explanation. `npm run check` includes this suite and all previous Phase 2A/2B/IMDb suites, followed by `npm run dist` as required by the repository.

No destructive migration, dependency or database change is introduced. The Phase 2A pre-integrity backup remains in effect. For rollback, close the isolated app/mpv, preserve its complete test profile and return code to the Phase 2C commit. New role/evidence fields are additive; the old version does not enforce/display them. Restore only the isolated pre-test copy if a data rollback is needed. Do not overwrite personal originals or run old/new binaries concurrently against a cloud account. Live two-device cloud, Linux/macOS and personal ambiguous libraries still require separate authorized verification.
