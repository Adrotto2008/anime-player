// Test senza interfaccia: pattern, preset Anime4K, libreria e — se mpv è installato — riproduzione reale via IPC.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const P = require('../src/patterns');
const A = require('../src/anime4k');
const { Store } = require('../src/store');
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-'));
const store = new Store(path.join(tmp, 'library.json'));
const s = store.addSeries({ title: 'Prova' });
assert.strictEqual(store.addSources(s.id, P.expandPattern('http://x/{ep}.mp4', 1, 3)), 3);
assert.strictEqual(store.addSources(s.id, P.expandPattern('http://x/{ep}.mp4', 1, 3)), 0, 'nessun duplicato');
store.mergeEpisodeMeta(s.id, [{ number: 2, title: 'Due', thumb: 'http://t/2.jpg' }]);
assert.strictEqual(store.getSeries(s.id).episodes[1].title, 'Due');
store.save(true);
assert.strictEqual(new Store(path.join(tmp, 'library.json')).data.series[0].episodes.length, 3);
ok('libreria: salvataggio, duplicati, metadati');

// --- mpv reale
let mpvPath = null; try { mpvPath = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['mpv']).toString().split(/\r?\n/)[0].trim(); } catch {}
if (!mpvPath) { console.log('  (mpv non installato: salto i test di riproduzione)'); console.log(`\n${n} test passati`); process.exit(0); }

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
  process.exit(0);
})().catch((e) => { console.error('FALLITO:', e); process.exit(1); });
