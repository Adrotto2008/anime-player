# Anime Player

Anime Player **v0.4.1** is a Windows Electron library for anime links. It stores the
links you provide, displays metadata from AniList and Kitsu, and opens videos
with the external **mpv** player and **Anime4K** shaders. It does not download
episodes and it does not scrape streaming sites.

## Features

- AniList search and series metadata: poster, banner, description, genres,
  year, format, episode count, and AniList score when available.
- IMDb overall anime score and episode-by-episode ratings across all seasons.
- Visual IMDb episode rating chart/heatmap in the series view (styled after
  Series Graph tier charts: Awesome, Great, Good, Regular, Bad, Garbage),
  recognizing the overall anime franchise across seasons.
- Kitsu episode titles and thumbnails. Missing ratings fallback gracefully; no
  values are invented.
- Direct video links, HLS playlists, local files, and yt-dlp-supported pages.
- Multiple fallback links per episode.
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
- Live library search with preserved focus/cursor position, progress filters, and a clear-search control.
- English and Italian UI translations, selectable at runtime and persisted in
  the library. New installations default to English. Existing libraries
  created before language support are migrated to Italian rather than having
  their current experience silently changed.

## Requirements

- Windows 10/11.
- mpv installed separately and available as `mpv.exe` (for example:
  `winget install mpv` or `scoop install mpv`). The app does not download or
  bundle an mpv binary: mpv is an external executable with platform-specific
  licensing and updates. First-run setup provides trusted **Detect** and
  **Browse** flows instead.
- Node.js 20+ only when running from source or building installers.

## Development install

```powershell
npm install
npm start
```

The first-run setup explains that Anime4K shaders are included in the app, while
mpv must be installed separately. It asks for the mpv executable and the
default Anime4K preset. Use **Detect** or **Browse** to select mpv; the selected
language can be changed later in **Settings**.

## Installed versus portable builds

Run:

```powershell
npm run dist
```

This keeps both Windows targets:

- `dist\AnimePlayer-portable.exe`: one executable, no installation required.
- `dist\AnimePlayer-Setup-<version>.exe` (currently `AnimePlayer-Setup-0.4.1.exe`): NSIS installer with Desktop and
  Start Menu shortcuts, selectable installation directory, and per-user
  installation by default.

The installed/portable application does not need Node.js, `npm install`, or
`npm start`. The library is stored separately in
`%APPDATA%\Anime Player\library.json`; uninstalling does not delete it.

## Usage

1. Choose **Add series** and search AniList, or add a title manually.
2. Open the series and add episode links using a detected link, a pattern, a
   list, or a playlist.
3. Select **Watch** or **Resume**. Progress is saved from mpv playback,
   including short sessions stopped before ten seconds.
4. Open **Statistics** for totals, recent activity, and per-anime details.
5. Open **Settings** to configure mpv, language, theme, autoplay, audio and
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

The app stores library data locally as JSON. It contacts AniList, Kitsu, and
IMDb only for the metadata and ratings described above. Video links are entered
by the user; the app does not include a downloader or scraper.

## Tests and validation

```powershell
npm test
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

This is a vibe-coding project developed collaboratively with multiple AIs.
