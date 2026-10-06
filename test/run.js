// Test senza interfaccia: pattern, preset Anime4K, libreria e — se mpv è installato — riproduzione reale via IPC.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const P = require('../src/patterns');
const A = require('../src/anime4k');
const { Store, DEFAULT_SETTINGS } = require('../src/store');
const { PlayerManager } = require('../src/player');
const { MpvSession, pipePath } = require('../src/mpv');

const shaderDir = path.join(__dirname, '..', 'shaders');
let n = 0; const ok = (name) => console.log('  ok', ++n, name);

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
ok('preset Anime4K, catene, input.conf');

// --- libreria
const tmp = path.join(__dirname, '.test-data');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
process.on('exit', cleanup);
const store = new Store(path.join(tmp, 'library.json'));
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
assert.throws(() => importedStore.importData({ series: [{ id: 'bad', title: 'Rotta', episodes: [{ id: 'ep', number: 1, sources: [{ url: 'non-un-link' }], progress: { watched: false, pos: 0, duration: 0 } }] }] }), /Link non valido/);
assert.strictEqual(importedStore.data.series.length, 1, 'un import non valido non deve sostituire la libreria');
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

// --- IMDb: normalizzazione titolo, riconoscimento stagione e rating chart
const { cleanTitleForImdb, detectSeasonFromTitle, applyImdbRatingsToEpisodes } = require('../src/metadata');

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
    { season: 1, episodes: [{ number: 1, rating: 9.2 }, { number: 2, rating: 8.5 }] },
    { season: 2, episodes: [{ number: 1, rating: 9.2 }, { number: 2, rating: 8.5 }] },
  ],
  maxEpisodes: 2,
};

const epsToMap = [{ number: 1, title: 'Ep 1', rating: null }, { number: 2, title: 'Ep 2', rating: null }];
applyImdbRatingsToEpisodes(epsToMap, mockChart, 'Attack on Titan Season 2');
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
let mpvPath = null; try { mpvPath = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['mpv']).toString().split(/\r?\n/)[0].trim(); } catch {}
if (!mpvPath) { console.log('  (mpv non installato: salto i test di riproduzione)'); console.log(`\n${n} test passati`); cleanup(); process.exit(0); }

const HEADLESS = '--vo=null --ao=null --no-config --msg-level=all=no';
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
  await new Promise((r) => setTimeout(r, 4000));
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
