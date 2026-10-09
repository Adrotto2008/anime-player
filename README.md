# Anime Player

Anime Player **v0.5.23** is a cross-platform Electron library for anime links. It stores the
links you add or discover through AnimeUnity and AnimeWorld, displays metadata from AniList and Kitsu, and opens videos
with the external **mpv** player and **Anime4K** shaders. It does not download
episodes. Automatic episode-link discovery tries AnimeUnity first, then AnimeWorld.

## Features

- AniList search and series metadata: poster, banner, description, genres,
  year, format, episode count, and AniList score when available.
- IMDb overall anime score and episode-by-episode ratings across all seasons.
- Visual IMDb episode rating chart/heatmap in the series view (styled after
  Series Graph tier charts: Awesome, Great, Good, Regular, Bad, Garbage),
  recognizing the overall anime franchise across seasons.
- Kitsu episode titles and thumbnails. Missing ratings fallback gracefully; no
  values are invented.
- AniList cast and related-series metadata in a compact series panel.
- AniSkip opening/ending availability is shown per episode after its skip data
  has been checked.
- Automatic episode-link discovery through AnimeUnity followed by AnimeWorld, with exact-title/year/episode-count matching and a manual fallback.
- HTTP availability checks beside each episode link; redirects and inconclusive responses are labeled separately.
- Direct video links, HLS playlists, local files, and yt-dlp-supported pages.
- Multiple fallback links per episode.
- Signed-in users privately sync their complete library, one representative
  episode-link pattern per series when available, metadata, playback progress,
  deletion records, watch history, and shared app preferences
  across devices. Each account has a separate local library and cloud snapshot.
  Individual episode URLs stay on the device.
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

Each build removes older `AnimePlayer-Setup-*.exe` installers first, so `dist`
contains only the installer for the current version. Run `npm run check` for
tests, syntax checks, and whitespace validation without building. Run
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
resolve episode links. Resolved episode URLs remain local and are not sent to Supabase.
Anime Player does not download video files.

### Supabase account and sync

The Supabase client runs in Electron's main process, using the `ws` transport
because the app's Electron/Node 20 runtime does not provide a native WebSocket.
Release builds include the project's public client configuration automatically,
so users do not need to create configuration files. The build reads it from the
developer's local app-data config or `SUPABASE_URL` and
`SUPABASE_PUBLISHABLE_KEY` environment variables. The app rejects any URL other
than the `anime-player` project. Never use a secret or `service_role` key. Do
not commit local config or `.env` files.

The app asks whether to sign in or create an account at startup, and the Account
item remains available in the navigation. Auth sessions are encrypted with
Electron `safeStorage` when the operating system provides secure storage.
The full library snapshot (including user-entered episode-link patterns, progress,
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
restricted database function and are never returned in search results. Where a
series' episode URLs do not share a reconstructible pattern, those URLs remain
on that device and are omitted from the cloud snapshot. The database enforces
this rule when any app version syncs, retaining a saved representative pattern
while stripping per-episode URL fields.

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
