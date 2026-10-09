const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store, validateLibraryData } = require('./src/store');
const { PlayerManager } = require('./src/player');
const { CloudService } = require('./src/cloud');
const A4K = require('./src/anime4k');
const meta = require('./src/metadata');
const { expandPattern, expandList, parseM3U, isValidSource, detectEpisodeNumber } = require('./src/patterns');
const { AnimeWorldClient } = require('./src/animeworld');
const { createMpvManager } = require('./src/mpv-manager');

if (!app.requestSingleInstanceLock()) { app.quit(); }

let win; let store; let player; let cloud; let roomSubscription;
const animeWorld = new AnimeWorldClient();
let mpvManager;

const shaderDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'shaders') : path.join(__dirname, 'shaders'));
const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };

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
  h('auth:state', () => cloud.getSession());
  h('auth:signUp', (email, password) => cloud.signUp(email, password));
  h('auth:signIn', (email, password) => cloud.signIn(email, password));
  h('auth:signOut', () => cloud.signOut());
  h('profile:get', (userId) => cloud.getProfile(userId));
  h('profile:mine', () => cloud.getMyProfile());
  h('profile:update', (patch) => cloud.updateProfile(patch));
  h('favorites:list', () => cloud.listFavorites());
  h('favorites:set', (seriesId, favorite) => cloud.setFavorite(seriesId, favorite));
  h('friends:search', (query) => cloud.searchUsers(query));
  h('friends:requests', () => cloud.listFriendRequests());
  h('friends:request', (receiverId) => cloud.sendFriendRequest(receiverId));
  h('friends:respond', (requestId, status) => cloud.respondFriendRequest(requestId, status));
  h('friends:list', () => cloud.listFriends());
  h('friends:remove', (friendId) => cloud.removeFriend(friendId));
  h('watchRooms:create', (params) => cloud.createWatchRoom(params));
  h('watchRooms:join', (roomId) => cloud.joinWatchRoom(roomId));
  h('watchRooms:subscribe', (roomId) => {
    if (roomSubscription) roomSubscription.unsubscribe();
    roomSubscription = cloud.subscribeWatchRoom(roomId, {
      onPlayback: (payload) => send('watchRoom:playback', payload),
      onPresence: (payload) => send('watchRoom:presence', payload),
    });
    return true;
  });
  h('watchRooms:broadcast', (type, details) => {
    if (!roomSubscription) throw new Error('Non sei collegato a una watch room.');
    return roomSubscription.sendPlayback(type, details);
  });
  h('watchRooms:unsubscribe', async () => {
    if (roomSubscription) await roomSubscription.unsubscribe();
    roomSubscription = null;
    return true;
  });
  h('sync:run', () => cloud.sync());
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
  h('settings:set', async (patch) => {
    const next = { ...store.data.settings, ...(patch || {}) };
    if (!A4K.PRESETS[next.defaultPreset]) throw new Error('Preset Anime4K non valido.');
    if (!['default', 'compact'].includes(next.theme)) throw new Error('Tema non valido.');
    if (!['en', 'it'].includes(next.language)) throw new Error('Lingua non valida.');
    if (patch && Object.hasOwn(patch, 'mpvPath') && next.mpvPath) {
      const result = await mpvManager.validate(next.mpvPath);
      if (!result.ok) throw new Error(result.error || 'Il file selezionato non è un eseguibile mpv compatibile.');
    }
    store.setSettings(patch || {});
    return lib();
  });
  h('mpv:detect', async () => {
    const result = await mpvManager.find(store.data.settings.mpvPath);
    if (result.ok && result.path !== store.data.settings.mpvPath) store.setSettings({ mpvPath: result.path });
    return { ...result, lib: lib() };
  });
  h('mpv:openGuide', async () => { await shell.openExternal(mpvManager.installGuide); return true; });
  h('mpv:install', async () => {
    const result = await mpvManager.install();
    if (result.ok) store.setSettings({ mpvPath: result.path });
    return { ...result, lib: lib() };
  });
  h('mpv:browse', async () => {
    const executableName = process.platform === 'win32' ? 'mpv.exe' : 'mpv';
    const r = await dialog.showOpenDialog(win, { title: `Scegli ${executableName}`, properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: 'mpv', extensions: ['exe'] }] : [] });
    if (r.canceled || !r.filePaths[0]) return lib();
    const result = await mpvManager.validate(r.filePaths[0]);
    if (!result.ok) throw new Error(result.error || 'Il file selezionato non è un eseguibile mpv compatibile.');
    store.setSettings({ mpvPath: r.filePaths[0] });
    return lib();
  });

  h('series:search', (text) => meta.searchAnime(text));

  const discoverSeriesSources = async (series, titles = [series.title]) => {
    try {
      const sources = (await animeWorld.findSources({ titles, year: series.year, episodeCount: series.episodeCount }))
        .map((source) => ({ ...source, provider: 'animeworld' }));
      if (!sources.length) return { episodesAdded: 0, unavailable: false };
      const existing = new Map(store.getSeries(series.id).episodes.map((episode) => [episode.number, new Set(episode.sources.map((source) => source.url))]));
      const linkedEpisodes = new Set(sources.filter((source) => !existing.get(source.number)?.has(source.url)).map((source) => source.number));
      const added = store.addSources(series.id, sources);
      if (added) store.updateSeries(series.id, { referer: 'https://www.animeworld.ac/' });
      return { episodesAdded: linkedEpisodes.size, unavailable: false };
    } catch (err) {
      console.warn('AnimeWorld source discovery failed:', err.message);
      return { episodesAdded: 0, unavailable: true };
    }
  };

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
      const sourceDiscovery = await discoverSeriesSources(s, [s.title]);
      return { id: s.id, lib: lib(), sourceDiscovery };
    }
    const m = await meta.getAnime(anilistId, { language: store.data.settings.language });
    const { streamingEpisodes, altTitle, ...fields } = m;
    const s = store.addSeries(fields);
    const { kitsuId, episodes } = await meta.fetchEpisodes({ anilistId, title: m.altTitle || m.title, streamingEpisodes, episodeCount: m.episodeCount });
    store.updateSeries(s.id, { kitsuId });
    if (m.episodeCount && m.episodeCount <= 300) {
      const seriesObj = store.getSeries(s.id);
      for (let n = 1; n <= m.episodeCount; n++) store.ensureEpisode(seriesObj, n);
    }
    store.mergeEpisodeMeta(s.id, episodes);
    const sourceDiscovery = await discoverSeriesSources(s, [m.title, m.altTitle]);
    try {
      const imdb = await meta.fetchImdbData({ title: s.title || m.title, altTitle: m.altTitle });
      if (imdb) {
        const patch = { imdbId: imdb.imdbId, imdbChart: imdb };
        if (imdb.overallRating != null) { patch.score = imdb.overallRating; patch.scoreSource = 'IMDb'; }
        store.refreshSeriesMetadata(s.id, patch);
      }
    } catch { /* ignora errori imdb */ }
    return { id: s.id, lib: lib(), sourceDiscovery };
  });

  h('series:discoverSources', async (id) => {
    const series = store.getSeries(id);
    if (!series) throw new Error('Serie non trovata.');
    const sourceDiscovery = await discoverSeriesSources(series, [series.title, series.altTitle]);
    return { lib: lib(), sourceDiscovery };
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
        const { streamingEpisodes, altTitle, ...f } = m;
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
  h('episodes:rate', (sid, eid, rating) => { store.rateEpisode(sid, eid, rating); return lib(); });
  h('episodes:skipTimes', async (sid, eid) => {
    const s = store.getSeries(sid); const ep = store.getEpisode(sid, eid);
    if (!s || !ep) throw new Error('Episodio non trovato');
    if (!s.malId || !s.anilistId) return { skipTimes: ep.skipTimes || [], lib: lib() };
    try {
      const skipTimes = await meta.fetchAniSkipTimes(s.malId, ep.number, ep.duration);
      store.mergeEpisodeMeta(sid, [{ number: ep.number, skipTimes }]);
    } catch (err) {
      console.warn('AniSkip error:', err.message);
    }
    return { skipTimes: store.getEpisode(sid, eid).skipTimes || [], lib: lib() };
  });

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

  const ensureMpv = async () => {
    const current = store.data.settings.mpvPath;
    if (current) {
      const result = await mpvManager.validate(current);
      if (result.ok) return result.path;
    }
    const result = await mpvManager.find(current);
    if (result.ok) { store.setSettings({ mpvPath: result.path }); return result.path; }
    throw new Error(`MPV_NOT_CONFIGURED: ${result.error || 'mpv non trovato.'}`);
  };
  h('player:play', async (sid, eid) => {
    const s = store.getSeries(sid); const ep = store.getEpisode(sid, eid);
    if (!s || !ep) throw new Error('Episodio non trovato');
    await ensureMpv();
    if (s && ep && s.malId && (!Array.isArray(ep.skipTimes) || !ep.skipTimes.length)) {
      try { store.mergeEpisodeMeta(sid, [{ number: ep.number, skipTimes: await meta.fetchAniSkipTimes(s.malId, ep.number, ep.duration) }]); } catch (err) { console.warn('AniSkip error:', err.message); }
    }
    return player.play(sid, eid).then(() => lib());
  });
  h('player:playUrl', async (url, preset) => {
    if (!isValidSource(String(url).trim())) throw new Error('Link non valido.');
    await ensureMpv();
    return player.playUrl(String(url).trim(), preset);
  });
  h('player:stop', () => player.stop());
  h('player:preset', (id) => player.setPreset(id));
  h('player:seekRelative', (seconds) => player.seekRelative(seconds));
  h('player:seekAbsolute', (seconds) => player.seekAbsolute(seconds));
  h('player:skipIntro', () => player.skipCurrentSegment('intro'));
  h('player:skipEnding', () => player.skipCurrentSegment('ending'));
  h('player:skipSegment', (end) => player.skipSegment(end));
  h('stats:get', () => store.statistics());
}

async function refreshAiringStatuses() {
  for (const series of [...store.data.series]) {
    if (!series.anilistId) continue;
    try {
      const m = await meta.getAnime(series.anilistId, { language: store.data.settings.language });
      store.updateSeries(series.id, {
        status: m.status,
        nextAiringAt: m.nextAiringAt,
        nextEpisode: m.nextEpisode,
        malId: m.malId,
        description: m.description || series.description,
      });
    } catch (err) {
      console.warn('Aggiornamento stato anime fallito:', series.title, err.message);
    }
  }
  send('lib:changed', store.snapshot());
}

app.whenReady().then(async () => {
  const userDataPath = app.getPath('userData');
  store = new Store(path.join(userDataPath, 'library.json'));
  mpvManager = createMpvManager({ userDataPath });
  player = new PlayerManager({ store, paths: { shaderDir: shaderDir(), userData: userDataPath }, notify: send });
  cloud = new CloudService({ store, userDataPath, safeStorage: require('electron').safeStorage, notify: send, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
  player.onWatchSession = (session) => cloud.recordWatchSession(session);
  register();
  const detected = await mpvManager.find(store.data.settings.mpvPath);
  if (detected.ok && detected.path !== store.data.settings.mpvPath) store.setSettings({ mpvPath: detected.path });
  createWindow();
  cloud.start().catch((err) => console.warn('Avvio Supabase fallito:', err.message));
  setTimeout(() => refreshAiringStatuses().catch((err) => console.warn('Aggiornamento programmazione fallito:', err.message)), 1200);
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('before-quit', () => { if (cloud) cloud.stop(); store && store.save(true); if (player) player.stop(); });
app.on('window-all-closed', () => app.quit());
