# Source engine and playback recovery

The production entry point uses `src/source-engine.js`, adapted from the standalone algorithms in the Downloads workspace. Old provider parsers remain for legacy fixtures but are no longer the production discovery or renewal path. The copied code was authored independently; upstream repositories served as primary research references, not copied implementation.

Discovery visits AnimeUnity then AnimeWorld, rejects incomplete searches, retains separate dubbed editions, and requires an exact known title/alias with consistent catalog IDs or independent format/year/count evidence. Decimal, range and opaque episode labels remain diagnostic results because the current library cannot represent them as integer keys. They are never rounded or expanded. One-shot units still pass through the existing media-part model; no membership or category rewrite is performed.

A provider's OVA/MOVIE presentation category can differ for a theatrical OVA. The adapter reconciles only that category when MAL ID, exact full title, year and independently reported single-unit count all match and there is no other conflict. This permits AnimeWorld's Movie entry for Memory Snow to support the canonical OVA without changing the library format. A shared AniList ID, similar name or equal file count alone is insufficient.

Automatic sources retain stable provider work and episode IDs and distinct HLS/file IDs. Signed URLs are device-local. A playback proxy validates every upstream request and redirect, uses the correct cookie jar and Referer, rewrites HLS segment/key/map URLs, and is closed with its own player session. The selected HLS variant is the highest compatible declared resolution. This is not a subjective quality comparison or proof that a declared resolution is native.

After 20 seconds without observed media-time movement, a loaded remote source is stopped. A bounded seek grace lasts 40 seconds; user pause and zero speed suppress the watchdog. IPC responsiveness alone does not count as playback progress. Network errors and premature EOF use the same recovery path. EOF within 1% or three seconds of the end is accepted, so a tiny missing tail cannot be ruled out.

Recovery first renews an automatic source once when playback was established, then tries the remaining sources attached to the same UUID. Each source is attempted at most once plus its single renewal. The newest observed time is carried explicitly, even for an already-watched item. Stop, delete, account change or a new Play invalidates pending work and aborts proxy requests. Known audio language is preserved; a different language uses the existing explicit fallback dialog.

A replacement must report a duration within the larger of three seconds or 1% of the prior duration, and must start within three seconds of the requested time. Incompatible sources are rejected without resetting the saved checkpoint or marking the item watched. Similar duration alone does not prove identical edits, advertisements or synchronized subtitles; frame-exact alignment across unrelated encodes remains unverified.

The two Re:Zero films have separate provider entries: Memory Snow (2018, MAL 36286) and The Frozen Bond/Hyouketsu no Kizuna (2019, MAL 38414). AniList 100049 can represent an aggregate; the resolver does not equate either individual film to that two-unit aggregate solely by the shared AniList ID. Existing aggregate records may therefore require explicit component selection instead of guessed automatic reassignment.

Previously attached automatic sources inside that specific aggregate can still renew their named film by the original public work URL and episode ID, after validating the individual film's title/year/count/catalog evidence. This compatibility path does not create a component, infer its ordering, change its existing UUID/number, or attach an unselected film to the aggregate.

No download UI, StreamingCommunity production adapter, full-film endurance certification, installer execution or remote publication is part of this change.
