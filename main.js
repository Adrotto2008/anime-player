const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { Store, validateLibraryData } = require('./src/store');
const { PlayerManager } = require('./src/player');
const A4K = require('./src/anime4k');
const meta = require('./src/metadata');
const { expandPattern, expandList, parseM3U, isValidSource, detectEpisodeNumber } = require('./src/patterns');

if (!app.requestSingleInstanceLock()) { app.quit(); }

let win; let store; let player;

const shaderDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'shaders') : path.join(__dirname, 'shaders'));
const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };

function detectMpv() {
  const env = process.env;
  const candidates = [
    store.data.settings.mpvPath,
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'mpv.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'mpv', 'mpv.exe'),
    env.USERPROFILE && path.join(env.USERPROFILE, 'scoop', 'apps', 'mpv', 'current', 'mpv.exe'),
    'C:\\Program Files\\mpv\\mpv.exe', 'C:\\Program Files (x86)\\mpv\\mpv.exe', 'C:\\ProgramData\\chocolatey\\bin\\mpv.exe',
    '/usr/bin/mpv', '/usr/local/bin/mpv', '/opt/homebrew/bin/mpv',
  ].filter(Boolean);
  const hit = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where' : 'which', ['mpv'], (err, out) => resolve(err ? null : out.split(/\r?\n/)[0].trim() || null));
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 760, minWidth: 720, minHeight: 480, backgroundColor: '#17141f', title: 'Anime Player',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  Menu.setApplicationMenu(null);
  // Diagnosi: errori della pagina e del preload nel terminale; F12 o Ctrl+Maiusc+I aprono la console
  win.webContents.on('preload-error', (_e, file, err) => console.error('[preload-error]', file, err && err.message));
  win.webContents.on('console-message', (e, level, message, line, source) => {
    const msg = message !== undefined ? message : e.message;
    if ((level !== undefined ? level : e.level) >= 2 || e.level === 'error' || e.level === 'warning') console.error('[pagina]', msg, '—', (source || e.sourceId || '') + ':' + (line || e.lineNumber || ''));
  });
  win.webContents.on('before-input-event', (ev, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) { win.webContents.toggleDevTools(); ev.preventDefault(); }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

function register() {
  const lib = () => store.snapshot();
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => fn(...a));

  h('lib:get', () => lib());
  h('app:version', () => app.getVersion());
  h('library:export', async () => {
    const r = await dialog.showSaveDialog(win, {
      title: 'Esporta libreria',
      defaultPath: 'anime-player-library.json',
      filters: [{ name: 'Libreria Anime Player', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    try {
      fs.writeFileSync(r.filePath, JSON.stringify(lib(), null, 2), 'utf8');
      return { canceled: false, filePath: r.filePath };
    } catch (e) {
      throw new Error(`Esportazione fallita: ${e.message}`);
    }
  });
  h('library:import', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Importa libreria',
      properties: ['openFile'],
      filters: [{ name: 'Libreria Anime Player', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    try {
      const imported = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
      const checked = validateLibraryData(imported);
      await player.stop();
      const importedLib = store.importData(checked);
      return { canceled: false, filePath: r.filePaths[0], lib: importedLib };
    } catch (e) {
      throw new Error(`Importazione fallita: ${e.message}`);
    }
  });
  h('presets:list', () => A4K.listPresets());
  h('player:state', () => player.state());
  h('settings:set', (patch) => {
    const next = { ...store.data.settings, ...(patch || {}) };
    if (!A4K.PRESETS[next.defaultPreset]) throw new Error('Preset Anime4K non valido.');
    if (!['default', 'compact'].includes(next.theme)) throw new Error('Tema non valido.');
    if (!['en', 'it'].includes(next.language)) throw new Error('Lingua non valida.');
    let mpvIsFile = false;
    try { mpvIsFile = Boolean(next.mpvPath && fs.statSync(next.mpvPath).isFile()); } catch { /* percorso non valido */ }
    if (patch && patch.onboardingComplete === true && !mpvIsFile) {
      throw new Error('Scegli un file mpv.exe valido.');
    }
    store.setSettings(patch || {});
    return lib();
  });
  h('mpv:detect', async () => { const p = await detectMpv(); if (p) store.setSettings({ mpvPath: p }); return { path: p, lib: lib() }; });
  h('mpv:browse', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Scegli mpv.exe', properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: 'mpv', extensions: ['exe'] }] : [] });
    if (r.canceled || !r.filePaths[0]) return lib();
    store.setSettings({ mpvPath: r.filePaths[0] });
    return lib();
  });

  h('series:search', (text) => meta.searchAnime(text));

  h('series:create', async ({ anilistId, title }) => {
    if (!anilistId) {
      const s = store.addSeries({ title: String(title || '').trim() || 'Senza titolo' });
      try {
        const imdb = await meta.fetchImdbData({ title: s.title });
        if (imdb) {
          const patch = { imdbId: imdb.imdbId, imdbChart: imdb };
          if (imdb.overallRating != null) { patch.score = imdb.overallRating; patch.scoreSource = 'IMDb'; }
          store.refreshSeriesMetadata(s.id, patch);
        }
      } catch { /* ignora errori imdb */ }
      return { id: s.id, lib: lib() };
    }
    const m = await meta.getAnime(anilistId, { language: store.data.settings.language });
    const { streamingEpisodes, altTitle, status, ...fields } = m;
    const s = store.addSeries(fields);
    const { kitsuId, episodes } = await meta.fetchEpisodes({ anilistId, title: m.altTitle || m.title, streamingEpisodes, episodeCount: m.episodeCount });
    store.updateSeries(s.id, { kitsuId });
    if (m.episodeCount && m.episodeCount <= 300) {
      const seriesObj = store.getSeries(s.id);
      for (let n = 1; n <= m.episodeCount; n++) store.ensureEpisode(seriesObj, n);
    }
    store.mergeEpisodeMeta(s.id, episodes);
    try {
      const imdb = await meta.fetchImdbData({ title: s.title || m.title, altTitle: m.altTitle });
      if (imdb) {
        const patch = { imdbId: imdb.imdbId, imdbChart: imdb };
        if (imdb.overallRating != null) { patch.score = imdb.overallRating; patch.scoreSource = 'IMDb'; }
        store.refreshSeriesMetadata(s.id, patch);
      }
    } catch { /* ignora errori imdb */ }
    return { id: s.id, lib: lib() };
  });

  h('series:update', (id, patch) => { store.updateSeries(id, patch); return lib(); });
  h('series:delete', async (id) => { if (player.cur && player.cur.series && player.cur.series.id === id) await player.stop(); store.deleteSeries(id); return lib(); });

  const syncSeriesRatings = async (id) => {
    const s = store.getSeries(id);
    if (!s) return lib();
    let fields = {};
    let kitsuEpisodes = [];
    let kitsuId = s.kitsuId;
    if (s.anilistId) {
      try {
        const m = await meta.getAnime(s.anilistId, { language: store.data.settings.language });
        const { streamingEpisodes, altTitle, status, ...f } = m;
        fields = f;
        const { kitsuId: kid, episodes } = await meta.fetchEpisodes({
          anilistId: s.anilistId, kitsuId: s.kitsuId, title: m.altTitle || m.title, streamingEpisodes, episodeCount: m.episodeCount,
        });
        kitsuId = kid;
        kitsuEpisodes = episodes;
      } catch (err) {
        console.warn('AniList/Kitsu error:', err.message);
      }
    }
    fields.kitsuId = kitsuId;

    try {
      const searchTitle = (fields.title || s.title);
      const searchAlt = (fields.altTitle || s.altTitle);
      const imdb = await meta.fetchImdbData({ imdbId: s.imdbId, title: searchTitle, altTitle: searchAlt });
      if (imdb) {
        fields.imdbId = imdb.imdbId;
        fields.imdbChart = imdb;
        if (imdb.overallRating != null) {
          fields.score = imdb.overallRating;
          fields.scoreSource = 'IMDb';
        }
      }
    } catch (err) {
      console.warn('IMDb error:', err.message);
    }

    store.refreshSeriesMetadata(id, fields, kitsuEpisodes);
    return lib();
  };

  h('series:refresh', (id) => syncSeriesRatings(id));
  h('series:ratings', (id) => syncSeriesRatings(id));

  const checkItems = (items) => {
    const bad = items.find((i) => !isValidSource(i.url));
    if (bad) throw new Error(`Link non valido: ${bad.url}`);
    if (!items.length) throw new Error('Nessun link da aggiungere.');
    return items;
  };
  h('patterns:detect', (url, hint) => detectEpisodeNumber(url, hint));
  h('episodes:addPattern', (sid, { pattern, from, to }) => { store.addSources(sid, checkItems(expandPattern(pattern.trim(), from, to))); return lib(); });
  h('episodes:addList', (sid, { text, start }) => { store.addSources(sid, checkItems(expandList(text, start))); return lib(); });
  h('episodes:addM3U', async (sid, { start }) => {
    const r = await dialog.showOpenDialog(win, { title: 'Scegli una playlist', properties: ['openFile'], filters: [{ name: 'Playlist', extensions: ['m3u', 'm3u8'] }] });
    if (r.canceled || !r.filePaths[0]) return lib();
    store.addSources(sid, checkItems(parseM3U(fs.readFileSync(r.filePaths[0], 'utf8'), start)));
    return lib();
  });
  h('episodes:setSources', (sid, eid, urls) => { const items = urls.filter(Boolean).map((url) => ({ url })); items.forEach((i) => { if (!isValidSource(i.url)) throw new Error(`Link non valido: ${i.url}`); }); store.setSources(sid, eid, items.map((i) => i.url)); return lib(); });
  h('episodes:delete', (sid, eid) => { store.deleteEpisode(sid, eid); return lib(); });
  h('episodes:mark', (sid, eid, watched) => { store.markWatched(sid, eid, watched); return lib(); });

  h('player:play', (sid, eid) => player.play(sid, eid).then(() => lib()));
  h('player:playUrl', (url, preset) => {
    if (!isValidSource(String(url).trim())) throw new Error('Link non valido.');
    return player.playUrl(String(url).trim(), preset);
  });
  h('player:stop', () => player.stop());
  h('player:preset', (id) => player.setPreset(id));
  h('player:seekRelative', (seconds) => player.seekRelative(seconds));
  h('player:seekAbsolute', (seconds) => player.seekAbsolute(seconds));
  h('player:skipIntro', () => player.skipIntro());
  h('player:skipEnding', () => player.skipEnding());
  h('stats:get', () => store.statistics());
}

app.whenReady().then(async () => {
  store = new Store(path.join(app.getPath('userData'), 'library.json'));
  player = new PlayerManager({ store, paths: { shaderDir: shaderDir(), userData: app.getPath('userData') }, notify: send });
  register();
  if (!store.data.settings.mpvPath || !fs.existsSync(store.data.settings.mpvPath)) {
    const p = await detectMpv();
    if (p) store.setSettings({ mpvPath: p });
  }
  createWindow();
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('before-quit', () => { store && store.save(true); if (player) player.stop(); });
app.on('window-all-closed', () => app.quit());
