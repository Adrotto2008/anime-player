// Test senza interfaccia: pattern, preset Anime4K, libreria e — se mpv è installato — riproduzione reale via IPC.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const P = require('../src/patterns');
const A = require('../src/anime4k');
const { Store, DEFAULT_SETTINGS, validateLibraryData } = require('../src/store');
const { PlayerManager } = require('../src/player');
const { MpvSession, pipePath } = require('../src/mpv');
const { aniSkipUrl } = require('../src/metadata');
const { CloudService, readConfig, PROJECT_REF, mergeLibrarySnapshots, compressLibraryForCloud, expandLibraryFromCloud } = require('../src/cloud');

const shaderDir = path.join(__dirname, '..', 'shaders');
let n = 0; const ok = (name) => console.log('  ok', ++n, name);
execFileSync(process.execPath, ['test/franchise.js'], { stdio: 'inherit' });
execFileSync(process.execPath, ['test/source-discovery.js'], { stdio: 'inherit' });
execFileSync(process.execPath, ['test/audit-regressions.js'], { stdio: 'inherit' });

// --- pattern
assert.deepStrictEqual(P.expandPattern('http://x/ep{ep}.mp4', 1, 3).map((e) => e.url), ['http://x/ep1.mp4', 'http://x/ep2.mp4', 'http://x/ep3.mp4']);
assert.strictEqual(P.expandPattern('http://x/{ep:03}.mp4', 7, 7)[0].url, 'http://x/007.mp4');
assert.throws(() => P.expandPattern('http://x/fisso.mp4', 1, 3));
assert.throws(() => P.expandPattern('http://x/{ep}', 5, 2));
assert.deepStrictEqual(P.expandList('# nota\nhttp://a\n\nhttp://b', 4), [{ number: 4, url: 'http://a' }, { number: 5, url: 'http://b' }]);
const m3u = P.parseM3U('#EXTM3U\n#EXTINF:1400,Il primo\nhttp://a/1.mp4\n#EXTINF:1400,Il secondo\nhttp://a/2.mp4', 1);
assert.strictEqual(m3u[1].title, 'Il secondo'); assert.ok(P.isValidSource('https://x.y/z.m3u8') && P.isValidSource('C:\\video\\a.mkv') && !P.isValidSource('ciao'));
ok('pattern, elenchi, m3u, validazione');

// --- riconoscimento del numero episodio nel link
const D = P.detectEpisodeNumber;
const u1 = 'https://srv18-tsurukusa.sweetpixel.org/DDL/ANIME/TokyoRevengersSantenSensou-henITA/TokyoRevengersSantenSensou-hen_Ep_01_ITA.mp4';
const d1 = D(u1);
assert.strictEqual(d1.candidates.length, 1, 'il 18 di srv18 va ignorato');
assert.strictEqual(d1.number, 1);
assert.strictEqual(d1.candidates[0].pattern, 'https://srv18-tsurukusa.sweetpixel.org/DDL/ANIME/TokyoRevengersSantenSensou-henITA/TokyoRevengersSantenSensou-hen_Ep_{ep:2}_ITA.mp4');
assert.strictEqual(P.expandPattern(d1.candidates[0].pattern, 1, 12)[11].url, u1.replace('Ep_01', 'Ep_12'));
assert.strictEqual(P.expandPattern(d1.candidates[0].pattern, 1, 12)[0].url, u1, 'ep 1 deve ridare il link originale');
assert.strictEqual(D('https://cdn2.x.org/show/S02/Show.S02E05.1080p.x264.mkv').number, 5);
assert.strictEqual(D('https://cdn2.x.org/show/S02/Show.S02E05.1080p.x264.mkv', 2).number, 2, 'con l\'indicazione dell\'utente vince il suo numero');
assert.strictEqual(D('https://a.b/anime/12/episodio-3.mp4').number, 3);
assert.strictEqual(D('https://a.b/anime/naruto-ep7.mp4?id=99').number, 7);
assert.strictEqual(D('C:\\Anime\\Show - 08 [720p].mkv').number, 8);
assert.strictEqual(D('https://srv5.a.b/solo-titolo.mp4'), null);
ok('riconoscimento automatico del numero episodio (anche il tuo link)');

// --- preset: 12 preset + off, tutti gli shader esistono, catene come da documentazione ufficiale
assert.strictEqual(Object.keys(A.PRESETS).length, 13);
for (const p of Object.values(A.PRESETS)) for (const f of p.chain) assert.ok(fs.existsSync(path.join(shaderDir, f + '.glsl')), 'manca ' + f);
assert.deepStrictEqual(A.PRESETS['a-fast'].chain, ['Anime4K_Clamp_Highlights', 'Anime4K_Restore_CNN_M', 'Anime4K_Upscale_CNN_x2_M', 'Anime4K_AutoDownscalePre_x2', 'Anime4K_AutoDownscalePre_x4', 'Anime4K_Upscale_CNN_x2_S']);
assert.deepStrictEqual(A.PRESETS['ca-hq'].chain, ['Anime4K_Clamp_Highlights', 'Anime4K_Upscale_Denoise_CNN_x2_VL', 'Anime4K_AutoDownscalePre_x2', 'Anime4K_AutoDownscalePre_x4', 'Anime4K_Restore_CNN_M', 'Anime4K_Upscale_CNN_x2_M']);
assert.deepStrictEqual(A.PRESETS['bb-fast'].chain.slice(-3), ['Anime4K_AutoDownscalePre_x4', 'Anime4K_Restore_CNN_Soft_S', 'Anime4K_Upscale_CNN_x2_S']);
assert.deepStrictEqual(A.splitArgs('--volume=70 "--title=a b"'), ['--volume=70', '--title=a b']);
const conf = A.buildInputConf(shaderDir);
assert.ok(conf.includes('CTRL+1 ') && conf.includes('ALT+6 ') && conf.includes('CTRL+0') && conf.includes('ap-next'));
const customConf = A.buildInputConf(shaderDir, { next: 'CTRL+N', previous: 'CTRL+P', skipIntro: 'CTRL+I', skipEnding: 'CTRL+E' });
assert.ok(customConf.includes('CTRL+N script-message ap-next') && customConf.includes('CTRL+I script-message ap-skip-intro'));
ok('preset Anime4K, catene, input.conf');

const skipUrl = new URL(aniSkipUrl(31240, 1, 1515));
assert.strictEqual(skipUrl.pathname, '/v2/skip-times/31240/1');
assert.deepStrictEqual(skipUrl.searchParams.getAll('types[]'), ['op', 'ed', 'mixed-op', 'mixed-ed', 'recap']);
assert.strictEqual(skipUrl.searchParams.get('episodeLength'), '1515');
ok('AniSkip: URL con tipi e durata episodio');

assert.strictEqual(readConfig({ SUPABASE_URL: `https://${PROJECT_REF}.supabase.co`, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' }).configured, true);
assert.strictEqual(readConfig({ SUPABASE_URL: 'https://sjodxonntzqiserdpdfv.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' }).configured, false, 'il progetto haxball2 deve essere rifiutato');
assert.strictEqual(readConfig({ SUPABASE_URL: `https://${PROJECT_REF}.supabase.co`, SUPABASE_PUBLISHABLE_KEY: 'sb_secret_test' }).configured, false, 'le secret key non devono essere accettate nel client');
const fakeAnonKey = `header.${Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url')}.signature`;
const fakeServiceRoleKey = `header.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.signature`;
assert.strictEqual(readConfig({ SUPABASE_URL: `https://${PROJECT_REF}.supabase.co`, SUPABASE_ANON_KEY: fakeAnonKey }).configured, true);
assert.strictEqual(readConfig({ SUPABASE_URL: `https://${PROJECT_REF}.supabase.co`, SUPABASE_ANON_KEY: fakeServiceRoleKey }).configured, false, 'anche i JWT service_role devono essere rifiutati');
const localConfigFile = path.join(__dirname, '.supabase-config-test.json');
fs.writeFileSync(localConfigFile, JSON.stringify({ url: `https://${PROJECT_REF}.supabase.co`, publishableKey: 'sb_publishable_local_test' }));
assert.strictEqual(readConfig({}, localConfigFile).configured, true, 'la configurazione locale per-dispositivo deve essere letta');
fs.unlinkSync(localConfigFile);
ok('configurazione Supabase vincolata al progetto anime-player e alle chiavi client');

const cloudMerge = mergeLibrarySnapshots(
  { settings: { language: 'it' }, series: [{ id: 's1', title: 'Serie locale', addedAt: 10, episodes: [{ id: 'e1', number: 1, updatedAt: 20, sources: [], progress: { watched: false, pos: 0, duration: 0, updatedAt: 20 } }, { id: 'e3-old', number: 3, updatedAt: 20, sources: [{ url: 'https://local.example/3.mp4' }], progress: { watched: false, pos: 0, duration: 0, updatedAt: 0 } }, { id: 'e4', number: 4, sources: [], progress: { watched: false, pos: 0, duration: 0, updatedAt: 0 } }] }], deletedSeries: [], deletedEpisodes: [] },
  { settings: { language: 'en' }, series: [{ id: 's1', title: 'Serie remota', addedAt: 10, updatedAt: 30, episodes: [{ id: 'e2', number: 2, updatedAt: 25, sources: [], progress: { watched: false, pos: 0, duration: 0, updatedAt: 25 } }, { id: 'e3-new', number: 3, updatedAt: 30, sources: [{ url: 'https://remote.example/3.mp4' }], progress: { watched: false, pos: 0, duration: 0, updatedAt: 0 } }] }, { id: 's2', title: 'Da rimuovere', addedAt: 5, episodes: [] }], deletedSeries: [{ id: 's2', deletedAt: 40 }], deletedEpisodes: [{ seriesId: 's1', id: 'e4', deletedAt: 40 }] },
);
assert.strictEqual(cloudMerge.series.length, 1, 'le serie eliminate non ricompaiono nel merge');
assert.strictEqual(cloudMerge.series[0].title, 'Serie remota', 'vince la versione più recente dei metadati');
assert.deepStrictEqual(cloudMerge.series[0].episodes.map((episode) => episode.id).sort(), ['e1', 'e2', 'e3-new'], 'gli episodi indipendenti vengono uniti mantenendo un solo elemento per numero');
assert.strictEqual(cloudMerge.series[0].episodes.find((episode) => episode.number === 3).sources.length, 2, 'le sorgenti di entrambi i dispositivi vengono conservate');
ok('merge libreria cloud: metadati recenti, episodi uniti, eliminazioni rispettate');

const sourceLibrary = { settings: {}, series: [{ id: 'pattern-series', title: 'Pattern', episodes: [1, 2, 3].map((number) => ({ id: `ep-${number}`, number, sources: [{ url: `https://video.example/show/ep${String(number).padStart(2, '0')}.m3u8` }], progress: { watched: false, pos: 0, duration: 0, updatedAt: 0 } })) }, { id: 'single-series', title: 'Singolo', episodes: [{ id: 'ep-1', number: 1, sources: [{ url: 'https://video.example/opaque' }] }] }] };
const compressedLibrary = compressLibraryForCloud(sourceLibrary);
assert.deepStrictEqual(compressedLibrary.series[0].sourcePattern, { pattern: 'https://video.example/show/ep{ep:2}.m3u8', from: 1, to: 3 });
assert.ok(compressedLibrary.series.every((series) => series.episodes.every((episode) => !Object.hasOwn(episode, 'sources'))), 'il cloud non deve contenere link episodio per episodio');
const restoredLibrary = expandLibraryFromCloud(compressedLibrary);
assert.strictEqual(restoredLibrary.series[0].episodes[2].sources[0].url, sourceLibrary.series[0].episodes[2].sources[0].url, 'il dispositivo ricostruisce gli URL dal pattern cloud');
assert.deepStrictEqual(restoredLibrary.series[1].episodes[0].sources, [], 'i link senza pattern restano solo locali');
const animeWorldOnly = compressLibraryForCloud({ series: [{ id: 'animeworld', title: 'AnimeWorld', episodes: [1, 2].map((number) => ({
  id: `aw-${number}`, number, sources: [{ url: `https://video.example/stream/episode${number}.m3u8`, provider: 'animeworld' }],
})) }] });
assert.ok(!animeWorldOnly.series[0].sourcePattern, 'AnimeWorld URLs should not be inferred into a cloud pattern');
assert.ok(animeWorldOnly.series[0].episodes.every((episode) => !Object.hasOwn(episode, 'sources')), 'AnimeWorld URLs stay local');
const animeUnityOnly = compressLibraryForCloud({ series: [{ id: 'animeunity', title: 'AnimeUnity', episodes: [1, 2].map((number) => ({
  id: `au-${number}`, number, sources: [{ url: `https://vixcloud.example/embed/${number}?signature=${number}`, provider: 'animeunity' }],
})) }] });
assert.ok(!animeUnityOnly.series[0].sourcePattern, 'gli URL AnimeUnity dinamici non vengono inferiti in pattern cloud');
assert.ok(animeUnityOnly.series[0].episodes.every((episode) => !Object.hasOwn(episode, 'sources')), 'gli URL AnimeUnity restano locali');
const lossyPattern = compressLibraryForCloud({ series: [{ id: 'lossy', title: 'Parziale', episodes: [
  { id: '1', number: 1, sources: [{ url: 'https://v.example/ep1.mp4' }] },
  { id: '2', number: 2, sources: [{ url: 'https://v.example/ep2.mp4' }] },
  { id: '3', number: 3, sources: [] },
] }] });
assert.deepStrictEqual(lossyPattern.series[0].sourcePattern, { pattern: 'https://v.example/ep{ep}.mp4', from: 1, to: 3 }, 'il pattern rappresentativo genera la stagione intera anche se mancava il link locale di alcuni episodi');
assert.strictEqual(expandLibraryFromCloud(lossyPattern).series[0].episodes[2].sources[0].url, 'https://v.example/ep3.mp4');
ok('snapshot cloud compatto: pattern manuali ricostruiti, link AnimeWorld solo locali');

// --- libreria
const tmp = path.join(__dirname, '.test-data');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
process.on('exit', cleanup);
const store = new Store(path.join(tmp, 'library.json'));
const resourcesPath = path.join(tmp, 'resources');
fs.mkdirSync(resourcesPath, { recursive: true });
fs.writeFileSync(path.join(resourcesPath, 'supabase-config.json'), JSON.stringify({ url: `https://${PROJECT_REF}.supabase.co`, publishableKey: 'sb_publishable_local_test' }));
const configuredCloud = new CloudService({ store, userDataPath: path.join(tmp, 'fresh-user'), resourcesPath, isPackaged: true, safeStorage: { isEncryptionAvailable: () => false }, env: {} });
assert.strictEqual(configuredCloud.status().configured, true, 'il client deve caricare la configurazione inclusa nel pacchetto');
assert.ok(configuredCloud.client, 'il client Supabase deve inizializzarsi nel runtime Node 20 di Electron');
configuredCloud.stop();
ok('client Supabase inizializzato da configurazione locale con trasporto WebSocket compatibile');
const cloudEvents = [];
const offlineCloud = new CloudService({ store, userDataPath: tmp, env: {}, notify: (channel, payload) => cloudEvents.push({ channel, payload }) });
offlineCloud.recordWatchSession({ seriesId: 'local-series', episodeId: 'local-episode', startedAt: 1000, finishedAt: 2000, watchedSeconds: 1 });
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'supabase-sync.json'), 'utf8')).history.length, 1, 'la cronologia in coda resta locale offline');
offlineCloud.start().then(() => offlineCloud.stop());
ok('cronologia Supabase accodata localmente senza configurazione/rete');
assert.strictEqual(store.needsOnboarding(), true);
assert.strictEqual(store.data.settings.language, 'en', 'new libraries default to English');
const s = store.addSeries({ title: 'Prova' });
assert.strictEqual(store.addSources(s.id, P.expandPattern('http://x/{ep}.mp4', 1, 3)), 3);
assert.strictEqual(store.addSources(s.id, P.expandPattern('http://x/{ep}.mp4', 1, 3)), 0, 'nessun duplicato');
store.mergeEpisodeMeta(s.id, [{ number: 2, title: 'Due', thumb: 'http://t/2.jpg', rating: 8.4, ratingSource: 'Kitsu' }]);
assert.strictEqual(store.getSeries(s.id).episodes[1].title, 'Due');
assert.strictEqual(store.getSeries(s.id).episodes[1].rating, 8.4);
store.setSources(s.id, store.getSeries(s.id).episodes[1].id, ['https://keep.example/episode-2.mp4']);
store.setProgress(s.id, store.getSeries(s.id).episodes[1].id, { pos: 42, duration: 120, watched: false });
store.refreshSeriesMetadata(s.id, {
  title: 'Titolo aggiornato', cover: 'https://img.example/new.jpg', episodeCount: 4,
}, [{ number: 2, title: 'Due aggiornato', thumb: 'https://img.example/2-new.jpg', rating: 9.1, ratingSource: 'Kitsu' }, { number: 4, title: 'Quattro', thumb: 'https://img.example/4.jpg' }]);
const refreshed = store.getSeries(s.id);
assert.strictEqual(refreshed.title, 'Titolo aggiornato');
assert.strictEqual(refreshed.episodes.length, 4);
assert.deepStrictEqual(refreshed.episodes[1].sources.map((x) => x.url), ['https://keep.example/episode-2.mp4']);
assert.strictEqual(refreshed.episodes[1].progress.pos, 42);
assert.strictEqual(refreshed.episodes[1].progress.duration, 120);
assert.strictEqual(refreshed.episodes[1].title, 'Due aggiornato');
assert.strictEqual(refreshed.episodes[1].thumb, 'https://img.example/2-new.jpg');
assert.strictEqual(refreshed.episodes[1].rating, 9.1, 'online episode rating is merged');
assert.strictEqual(refreshed.episodes[3].title, 'Quattro');
store.updateSeries(s.id, { introDuration: -4, outroDuration: 86 });
assert.strictEqual(store.getSeries(s.id).introDuration, 0, 'opening duration is clamped to zero');
assert.strictEqual(store.getSeries(s.id).outroDuration, 86);
store.rateEpisode(s.id, store.getSeries(s.id).episodes[0].id, 8.5);
assert.strictEqual(store.getSeries(s.id).episodes[0].personalRating, 8.5);
store.updateSeries(s.id, { personalRating: null, status: 'RELEASING', nextAiringAt: 1780000000000, nextEpisode: 5 });
assert.strictEqual(store.getSeries(s.id).status, 'RELEASING');
assert.strictEqual(store.getSeries(s.id).nextEpisode, 5);
ok('refresh metadati: link e progressi preservati, episodi aggiunti');
const seasonLimited = new Store(path.join(tmp, 'season-limited.json'));
const limited = seasonLimited.addSeries({ title: 'Re:Zero', episodeCount: 25 });
seasonLimited.mergeEpisodeMeta(limited.id, [{ number: 41, title: 'Stagione sbagliata', thumb: 'https://img.example/41.jpg' }]);
seasonLimited.refreshSeriesMetadata(limited.id, { episodeCount: 25 });
assert.strictEqual(seasonLimited.getSeries(limited.id).episodes.some((e) => e.number === 41), false, 'orphan metadata episodes beyond the season count are removed');
seasonLimited.addSources(limited.id, [{ number: 41, url: 'https://keep.example/season-3-episode-1.mp4' }]);
seasonLimited.refreshSeriesMetadata(limited.id, { episodeCount: 25 });
assert.ok(seasonLimited.getSeries(limited.id).episodes.some((e) => e.number === 41), 'user-linked episodes beyond the count are preserved');
ok('episodi extra di stagioni sbagliate filtrati senza perdere link utente');

const ordered = store.addSeries({ title: 'Priorità sorgenti' });
store.addSources(ordered.id, [{ number: 1, url: 'https://manual.example/ep1.mp4' }]);
const orderedEpisodeId = store.getSeries(ordered.id).episodes[0].id;
store.setProgress(ordered.id, orderedEpisodeId, { pos: 37, duration: 120, watched: false });
store.addSources(ordered.id, [{ number: 1, url: 'https://aw.example/ep1.m3u8', provider: 'animeworld', referer: 'https://www.animeworld.ac/' }]);
store.addSources(ordered.id, [{ number: 1, url: 'https://au.example/embed/ep1?token=x', provider: 'animeunity', referer: 'https://www.animeunity.so/embed/ep1' }]);
store.addSources(ordered.id, [{ number: 1, url: 'https://aw.example/ep1.m3u8', provider: 'animeworld' }]);
const orderedSources = store.getSeries(ordered.id).episodes[0].sources;
assert.deepStrictEqual(orderedSources.map((source) => source.provider || 'manual'), ['animeunity', 'animeworld', 'manual']);
assert.strictEqual(orderedSources[1].referer, 'https://www.animeworld.ac/');
assert.strictEqual(store.getEpisode(ordered.id, orderedEpisodeId).progress.pos, 37, 'l’aggiunta di sorgenti non azzera il progresso');
store.setProgress(ordered.id, orderedEpisodeId, { pos: 0, duration: 0, watched: false });
assert.strictEqual(store.addSources(ordered.id, [{ number: 1, url: 'https://au.example/embed/ep1?token=x', provider: 'animeunity' }]), 0);
assert.deepStrictEqual(store.getSeries(ordered.id).episodes[0].sources.map((source) => source.url), orderedSources.map((source) => source.url), 'scansioni ripetute non duplicano né riordinano in modo instabile');
const sourceSnapshot = validateLibraryData(store.snapshot());
assert.deepStrictEqual(sourceSnapshot.series.find((series) => series.id === ordered.id).episodes[0].sources.map((source) => source.provider || 'manual'), ['animeunity', 'animeworld', 'manual'], 'import/export mantiene provider e priorità');
ok('priorità sorgenti: AnimeUnity → AnimeWorld → manuali, con duplicati evitati');
store.setSettings({ onboardingComplete: true, theme: 'compact' });
store.save(true);
const reloaded = new Store(path.join(tmp, 'library.json'));
assert.strictEqual(reloaded.data.series[0].episodes.length, 4);
assert.strictEqual(reloaded.data.settings.theme, 'compact');
assert.strictEqual(reloaded.data.settings.language, 'en');
assert.strictEqual(reloaded.needsOnboarding(), false);
const legacyPath = path.join(tmp, 'legacy.json');
fs.writeFileSync(legacyPath, JSON.stringify({ settings: { theme: 'default', mpvPath: '' }, series: [] }));
assert.strictEqual(new Store(legacyPath).data.settings.language, 'it', 'legacy libraries keep the existing Italian UI');
const exported = store.snapshot();
const importedStore = new Store(path.join(tmp, 'imported.json'));
importedStore.importData(exported);
assert.strictEqual(importedStore.getSeries(s.id).episodes.length, 4);
assert.deepStrictEqual(importedStore.getSeries(ordered.id).episodes[0].sources.map((source) => source.provider || 'manual'), ['animeunity', 'animeworld', 'manual'], 'importa/esporta mantiene provider e ordine sorgenti');
const seriesBeforeInvalidImport = importedStore.data.series.length;
assert.throws(() => importedStore.importData({ series: [{ id: 'bad', title: 'Rotta', episodes: [{ id: 'ep', number: 1, sources: [{ url: 'non-un-link' }], progress: { watched: false, pos: 0, duration: 0 } }] }] }), /Link non valido/);
assert.strictEqual(importedStore.data.series.length, seriesBeforeInvalidImport, 'un import non valido non deve sostituire la libreria');
ok('libreria: salvataggio, duplicati, metadati');
ok('libreria: export/import e validazione');

const stats = store.statistics();
assert.strictEqual(stats.watchedEpisodes, 0);
store.markWatched(s.id, store.getSeries(s.id).episodes[0].id, true);
store.setProgress(s.id, store.getSeries(s.id).episodes[0].id, { duration: 90 });
const statsAfter = store.statistics();
assert.strictEqual(statsAfter.watchedEpisodes, 1);
assert.strictEqual(statsAfter.watchTime, 132);
assert.strictEqual(statsAfter.completedSeries, 0);
assert.ok(statsAfter.latestActivity.some((x) => x.seriesId === s.id));
assert.ok(statsAfter.perSeries.some((x) => x.seriesId === s.id && x.totalEpisodes === 4 && x.watchedEpisodes === 1 && x.completion === 25));
ok('statistiche: episodi, durata, completamento e attività recente');
assert.strictEqual(DEFAULT_SETTINGS.theme, 'default');

const resumePm = new PlayerManager({ store, paths: { shaderDir, userData: tmp }, notify: () => {} });
const resumeEp = store.getSeries(s.id).episodes[1];
resumeEp.progress = { ...resumeEp.progress, watched: false, pos: 0, duration: 120 };
const resumeCur = {
  series: store.getSeries(s.id), ep: resumeEp, pos: 4, dur: 120, sourceIndex: 0,
  session: { }, stopping: true, nav: null,
};
resumePm.cur = resumeCur;
resumePm._onExit(resumeCur, { eof: false, error: null });
assert.strictEqual(store.getEpisode(s.id, resumeEp.id).progress.pos, 4, 'short stopped sessions retain exact resume position');
ok('resume: posizione breve salvata all’uscita senza arrotondamento a zero');

// --- IMDb: normalizzazione titolo, riconoscimento stagione e rating chart
const { cleanTitleForImdb, detectSeasonFromTitle, applyImdbRatingsToEpisodes } = require('../src/metadata');
const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
assert.ok(rendererSource.includes('window.EpisodeRatings.target(siblings,chart,sn.season,ep.number)'));
assert.ok(rendererSource.includes('go({ name: \'series\', id: mapped.id, episodeId: libraryEpisode.id })'));
assert.ok(rendererSource.includes("'data-episode-id': e.id"));
const originalRenderer = execFileSync('git', ['show', 'HEAD:renderer/app.js'], { encoding: 'utf8' });
const episodeVisuals = (source) => { const normalized = source.replace(/\r\n/g, '\n'); return normalized.slice(normalized.indexOf('function episodeRow(s, e) {'), normalized.indexOf('  const skipChip', normalized.indexOf('function episodeRow(s, e) {'))); };
const allowRepeatedThumbs = source => source.replace(/  const priorThumbs = [^\n]+\n  const distinctThumb = e\.thumb && !priorThumbs\.has\(e\.thumb\);/, '  const distinctThumb = Boolean(e.thumb);');
assert.strictEqual(episodeVisuals(rendererSource), allowRepeatedThumbs(episodeVisuals(originalRenderer)), 'thumbnail design must remain unchanged apart from allowing repeated images');
const cssSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'style.css'), 'utf8');
const originalCss = execFileSync('git', ['show', 'HEAD:renderer/style.css'], { encoding: 'utf8' });
for (const selector of ['.eps', '.ep .th', '.ep .cover', '.th']) {
  const rule = (source) => source.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*\\}`, 'g')) || [];
  assert.deepStrictEqual(rule(cssSource), rule(originalCss), `${selector} episode thumbnail rules must remain unchanged`);
}

assert.strictEqual(cleanTitleForImdb('Attack on Titan Season 2'), 'Attack on Titan');
assert.strictEqual(cleanTitleForImdb('Attack on Titan: The Final Season Part 2'), 'Attack on Titan');
assert.strictEqual(cleanTitleForImdb('Demon Slayer: Kimetsu no Yaiba Entertainment District Arc'), 'Demon Slayer: Kimetsu no Yaiba');
assert.strictEqual(cleanTitleForImdb('Jujutsu Kaisen 2nd Season'), 'Jujutsu Kaisen');
assert.strictEqual(cleanTitleForImdb('Mob Psycho 100 III'), 'Mob Psycho 100');

assert.strictEqual(detectSeasonFromTitle('Attack on Titan Season 2'), 2);
assert.strictEqual(detectSeasonFromTitle('Attack on Titan 3rd Season'), 3);
assert.strictEqual(detectSeasonFromTitle('Attack on Titan S04'), 4);
assert.strictEqual(detectSeasonFromTitle('Attack on Titan'), 1);

const mockChart = {
  imdbId: 'tt2560140',
  title: 'Attack on Titan',
  overallRating: 9.1,
  seasons: [
    { season: 1, episodes: [{ id:'tt111',number: 1, rating: 9.2 }, { id:'tt112',number: 2, rating: 8.5 }] },
    { season: 2, episodes: [{ id:'tt121',number: 1, rating: 9.2 }, { id:'tt122',number: 2, rating: 8.5 }] },
  ],
  maxEpisodes: 2,
};

const epsToMap = [{ number: 1, title: 'Ep 1', rating: null }, { number: 2, title: 'Ep 2', rating: null }];
applyImdbRatingsToEpisodes(epsToMap, mockChart, {title:'Attack on Titan Season 2',episodeCount:2});
assert.strictEqual(epsToMap[0].rating, 9.2);
assert.strictEqual(epsToMap[0].ratingSource, 'IMDb');
assert.strictEqual(epsToMap[1].rating, 8.5);

store.refreshSeriesMetadata(s.id, {
  imdbId: 'tt2560140',
  imdbChart: mockChart,
  score: 9.1,
  scoreSource: 'IMDb',
});
const sWithImdb = store.getSeries(s.id);
assert.strictEqual(sWithImdb.imdbId, 'tt2560140');
assert.strictEqual(sWithImdb.score, 9.1);
assert.strictEqual(sWithImdb.scoreSource, 'IMDb');
assert.ok(sWithImdb.imdbChart && sWithImdb.imdbChart.seasons.length === 2);
ok('IMDb: normalizzazione titoli, riconoscimento stagione, rating e chart');

// --- mpv reale
let mpvPath = null;
try { mpvPath = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['mpv']).toString().split(/\r?\n/)[0].trim(); } catch {}
if (!mpvPath) {
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.APPDATA || '', 'Anime Player', 'mpv', `win32-${process.arch}`, 'mpv.exe'), 'C:\\Program Files\\mvp\\mpv.exe', 'C:\\Program Files\\mpv\\mpv.exe']
    : ['/usr/bin/mpv', '/usr/local/bin/mpv'];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) { mpvPath = candidate; break; }
  }
}
if (!mpvPath) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, process.platform === 'win32' ? 'mpv.exe' : 'mpv');
    if (fs.existsSync(candidate)) { mpvPath = candidate; break; }
  }
}
if (!mpvPath) { console.log('  (mpv non installato: salto i test di riproduzione)'); console.log(`\n${n} test passati`); cleanup(); process.exit(0); }

const HEADLESS = '--vo=null --ao=null --no-config --msg-level=all=no --network-timeout=3';
const lavfi = (d) => `av://lavfi:testsrc=duration=${d}:size=160x120:rate=25`;

(async () => {
  // 1) eventi e navigazione IPC
  const pipe = pipePath();
  const args = A.buildArgs({ settings: { extraArgs: HEADLESS }, presetId: 'off', startPos: 0, title: 't', url: lavfi(5), inputConf: path.join(tmp, 'x.conf'), pipe, shaderDir });
  const sess = new MpvSession({ mpvPath, args, pipe });
  const seen = { time: 0, dur: 0, nav: null };
  sess.on('time', () => seen.time++); sess.on('duration', (d) => { seen.dur = d; }); sess.on('nav', (d) => { seen.nav = d; });
  const exit = new Promise((r) => sess.on('exit', r));
  sess.start();
  await new Promise((r) => sess.once('connected', r));
  await new Promise((r) => setTimeout(r, 800));
  sess.send(['script-message', 'ap-next']);
  await new Promise((r) => setTimeout(r, 400));
  assert.strictEqual(seen.nav, 'next'); assert.ok(seen.time > 0, 'nessun time-pos ricevuto'); // la sorgente lavfi non dichiara una durata, quindi non la verifichiamo qui
  sess.quit(); await exit;
  ok('mpv IPC: time-pos e script-message (episodio successivo)');

  // 2) riproduzione completa con autoplay: ep1 -> ep2 -> fine
  const s2 = store.addSeries({ title: 'Auto' });
  store.addSources(s2.id, [{ number: 1, url: lavfi(2) }, { number: 2, url: lavfi(2) }]);
  store.setSettings({ mpvPath, defaultPreset: 'off', autoplayNext: true, extraArgs: HEADLESS });
  const events = [];
  const pm = new PlayerManager({ store, paths: { shaderDir, userData: tmp }, notify: (ch, p) => { if (ch === 'player:state') events.push(p.playing ? p.title : 'fermo'); if (ch === 'player:error') events.push('ERR ' + p); } });
  await pm.play(s2.id, store.getSeries(s2.id).episodes[0].id);
  await new Promise((r) => { const t = setInterval(() => { if (!pm.cur && events.filter((e) => e === 'fermo').length >= 2) { clearInterval(t); r(); } }, 200); setTimeout(() => { clearInterval(t); r(); }, 15000); });
  const eps = store.getSeries(s2.id).episodes;
  assert.ok(eps[0].progress.watched && eps[1].progress.watched, 'entrambi gli episodi dovrebbero risultare visti: ' + JSON.stringify(events));
  assert.ok(events.some((e) => /Ep\. 2/.test(String(e))), 'il secondo episodio non è partito da solo');
  ok('PlayerManager: riproduzione, fine file, autoplay del successivo, episodi segnati come visti');

  // 3) link rotto: errore segnalato, nessun crash
  const s3 = store.addSeries({ title: 'Rotto' });
  store.addSources(s3.id, [{ number: 1, url: 'http://127.0.0.1:9/non-esiste.mp4' }]);
  const errs = []; pm.notify = (ch, p) => { if (ch === 'player:error') errs.push(p); };
  await pm.play(s3.id, store.getSeries(s3.id).episodes[0].id);
  await new Promise((resolve,reject)=>{
    const started=Date.now();const poll=setInterval(()=>{
      if(errs.length){clearInterval(poll);resolve();}
      else if(Date.now()-started>15000){clearInterval(poll);reject(new Error('mpv did not report the broken link within 15 seconds'));}
    },100);
  });
  assert.ok(errs.length >= 1 && !store.getSeries(s3.id).episodes[0].progress.watched, 'errore non segnalato: ' + JSON.stringify(errs));
  ok('link non raggiungibile: errore mostrato, episodio non segnato come visto');

  // 4) mpv inesistente
  store.setSettings({ mpvPath: '/non/esiste/mpv' }); errs.length = 0;
  await pm.play(s2.id, store.getSeries(s2.id).episodes[0].id);
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(errs.some((e) => /mpv non trovato/.test(e)));
  ok('mpv mancante: messaggio chiaro');

  console.log(`\n${n} test passati`);
  cleanup();
  process.exit(0);
})().catch((e) => { cleanup(); console.error('FALLITO:', e); process.exit(1); });
