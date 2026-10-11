'use strict';

const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { resolveFranchise, legacyFranchiseRepairs } = require('../src/franchise');
const { createSeriesAdder } = require('../src/series-addition');
const Model = require('../src/franchise-model');
const { Store } = require('../src/store');
const { mergeLibrarySnapshots, compressLibraryForCloud, expandLibraryFromCloud } = require('../src/cloud');
const fixture = require('./onepiece-franchise.fixture.json');
const graph = new Map(fixture.records.map(record => [String(record.anilistId), record]));
const rel = (id, format, relation) => ({ id, type: 'ANIME', format, relation });
const media = (id, format, episodeCount, related = []) => ({ anilistId: id, title: `Series ${id}`, format, episodeCount, related });
const fetchGraph = async ids => ids.map(id => graph.get(String(id))).filter(Boolean);
const groupFields = ['franchiseId', 'franchiseTitle', 'franchiseOrder', 'franchiseType', 'franchiseSeasonNumber','franchiseMembership'];
const preserved = records => records.map(record => Object.fromEntries(Object.entries(record)
  .filter(([key]) => ![...groupFields, 'updatedAt'].includes(key))));

(async () => {
  const onePiece = await resolveFranchise(21, fetchGraph);
  assert.deepStrictEqual(onePiece.items.map(m => m.anilistId), [21]);
  assert.strictEqual(onePiece.ambiguous, false);
  assert.ok(onePiece.movies.some(m => m.anilistId === 459));
  assert.ok(!onePiece.movies.some(m => m.anilistId === 2107), 'SUMMARY movie is not imported as a side story');
  const monsters = await resolveFranchise(167404, fetchGraph);
  assert.deepStrictEqual(monsters.items.map(m => m.anilistId), [167404]);
  assert.strictEqual(monsters.movies.length, 0);
  assert.strictEqual(monsters.requests, 1, 'adding a one-shot cannot traverse into its narrative sequel');

  const calls = [];
  const serial = new Map([[1, media(1, 'ONA', 12, [rel(2, 'ONA', 'SEQUEL')])],
    [2, media(2, 'ONA', null, [rel(1, 'ONA', 'PREQUEL'), rel(3, 'ONA', 'SEQUEL')])],
    [3, media(3, 'ONA', 1, [rel(2, 'ONA', 'PREQUEL'), rel(4, 'TV', 'SEQUEL')])],
    [4, media(4, 'TV', 12)]]);
  const fetchSerial = async ids => { calls.push(...ids.map(Number)); return ids.map(id => serial.get(Number(id))).filter(Boolean); };
  assert.deepStrictEqual((await resolveFranchise(2, fetchSerial)).items.map(m => m.anilistId), [1, 2], 'episodic ONA seasons and unknown counts remain supported');
  assert.ok(!calls.includes(4), 'one-shot cannot bridge two different series');
  for (const format of ['TV', 'TV_SHORT', 'ONA', 'OVA', 'SPECIAL', 'MOVIE']) {
    const isolated = await resolveFranchise(9, async ids => ids.map(id => Number(id) === 9
      ? media(9, format, 1, [rel(4, 'TV', 'SEQUEL')]) : serial.get(Number(id))));
    assert.deepStrictEqual(isolated.items.map(m => m.anilistId), [9]);
  }
  const cycle = new Map([[1, media(1, 'TV', 12, [rel(2, 'TV', 'SEQUEL')])],
    [2, media(2, 'TV', 12, [rel(1, 'TV', 'SEQUEL')])]]);
  assert.strictEqual((await resolveFranchise(1, async ids => ids.map(id => cycle.get(Number(id))))).ambiguous, true);
  assert.strictEqual((await resolveFranchise(1, fetchSerial, {maxItems: 1})).ambiguous, true, 'a truncated graph cannot prove its franchise root');
  assert.strictEqual((await resolveFranchise(2, async ids => ids.map(id => Number(id) === 1 ? null : serial.get(Number(id))).filter(Boolean))).ambiguous, true,
    'a missing prequel record cannot turn the sequel into a proven franchise root');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-player-onepiece-franchise-'));
  const stores = [];
  const makeStore = name => { const store = new Store(path.join(dir, name)); stores.push(store); return store; };
  try {
    const original = makeStore('old.json');
    const records = [167404, 21, 459].map((id, index) => original.addSeries({ ...graph.get(String(id)),
      franchiseId: '167404', franchiseTitle: graph.get('167404').title, franchiseOrder: index < 2 ? index + 1 : null,
      franchiseType: index < 2 ? 'season' : 'movie', franchiseSeasonNumber: null,
      cover: `https://img.test/${id}.jpg`, personalRating: 9, preset: 'aa-hq',
      cast: [], movieSources: [], sourcePatternLanguage: null,
      videoPreference: {mode: 'it', updatedAt: 123},
      ...(index === 2 ? {movieSources: [{url: 'https://movie.test/keep.mp4', label: 'saved',temporary:false,expiresAt:null}]} : {}) }));
    for (const record of records.slice(0, 2)) {
      original.addSources(record.id, [{number: 1, url: `https://manual.test/${record.anilistId}.mp4`}]);
      const ep = Model.units(record)[0]; ep.personalRating = 8;
      ep.sources[0].referer = 'https://headers.test/'; ep.sources[0].userAgent = 'Custom';
      original.setProgress(record.id, ep.id, {pos: 77, duration: 120, watched: false});
    }
    original.save(true);
    const bad = original.snapshot();
    const protectedRecords = preserved(bad.series);
    const repaired = makeStore('old.json');
    assert.strictEqual(repaired.getSeries(records[0].id).franchiseId, null);
    assert.strictEqual(repaired.getSeries(records[1].id).franchiseId, '21');
    assert.strictEqual(repaired.getSeries(records[1].id).franchiseTitle, 'ONE PIECE');
    assert.strictEqual(repaired.getSeries(records[1].id).franchiseOrder, 1);
    assert.strictEqual(repaired.getSeries(records[2].id).franchiseType, 'movie');
    assert.deepStrictEqual(preserved(repaired.snapshot().series), protectedRecords, 'repair only changes grouping and its timestamp');
    assert.strictEqual(legacyFranchiseRepairs(repaired.data.series).length, 0, 'repair is idempotent');
    assert.strictEqual(mergeLibrarySnapshots(repaired.snapshot(), bad).series.find(s => s.anilistId === 167404).franchiseId, null,
      'a newer explicit detach must survive merge with the old grouping');
    repaired.save(true);
    assert.deepStrictEqual(makeStore('old.json').snapshot().series, repaired.snapshot().series, 'reopen keeps correction');

    const imported = makeStore('import.json'); imported.importData(bad);
    assert.strictEqual(imported.getSeries(records[1].id).franchiseId, '21');
    assert.deepStrictEqual(preserved(imported.snapshot().series), protectedRecords);
    const remote = JSON.parse(JSON.stringify(bad));
    for (const record of remote.series) record.updatedAt = Date.now() + 1000;
    const cloud = makeStore('cloud.json');
    const merged = mergeLibrarySnapshots(repaired.snapshot(), expandLibraryFromCloud(compressLibraryForCloud(remote)));
    cloud.applyCloudData(merged, new Date().toISOString());
    assert.strictEqual(cloud.getSeries(records[0].id).franchiseId, null, 'older grouping from cloud cannot reattach the one-shot');
    assert.strictEqual(cloud.getSeries(records[1].id).franchiseId, '21');
    const legacyCloud=makeStore('legacy-cloud.json');legacyCloud.applyCloudData(remote,new Date().toISOString());
    assert.strictEqual(legacyCloud.data.cloudDirty, true, 'a legacy correction is scheduled for subsequent normal sync');
    assert.ok(legacyCloud.getSeries(records[1].id).updatedAt > remote.series[1].updatedAt, 'repair timestamps remain newer than imported metadata');
    assert.strictEqual(cloud.getSeries(records[1].id).episodes[0].progress.pos, 77);

    const queued = [];
    const metadata = {getAnimeBatch: fetchGraph, fetchEpisodes: async () => ({episodes: []}), fetchImdbData: async () => null};
    const fresh = makeStore('new.json');
    const add = createSeriesAdder({store: fresh, metadata, sourceQueue: {enqueue: id => queued.push(id)}});
    const added = await add({anilistId: 21});
    assert.strictEqual(fresh.getSeries(added.id).anilistId, 21, 'addition returns exactly the selected anime');
    assert.strictEqual(added.franchiseId, '21');
    assert.ok(fresh.data.series.every(s => s.anilistId !== 167404), 'Monsters is not automatically added to One Piece');
    assert.deepStrictEqual(new Set(queued),new Set(fresh.data.series.map(s=>s.id)), 'films and the selected series receive source discovery');
    const repeated = await createSeriesAdder({store: repaired, metadata, sourceQueue: {enqueue: () => {}}})({anilistId: 21});
    assert.strictEqual(repeated.id, records[1].id, 're-add retains saved series identity');
    assert.strictEqual(repaired.getSeries(records[0].id).franchiseId, null);
    assert.deepStrictEqual(preserved(repaired.snapshot().series.slice(0, 3)), protectedRecords);

    const noEvidence = JSON.parse(JSON.stringify(bad.series)); noEvidence.forEach(s => { s.related = []; });
    assert.strictEqual(legacyFranchiseRepairs(noEvidence).length, 0, 'no speculative repair without relation evidence');
    const ambiguous = JSON.parse(JSON.stringify(bad.series));
    ambiguous.push({id: 'unrelated', ...media(6, 'TV', 12), franchiseId: '167404'});
    assert.strictEqual(legacyFranchiseRepairs(ambiguous).length, 0, 'disconnected saved groups are left for explicit review');
  } finally {
    for (const store of stores) clearTimeout(store._timer);
    // The directory is created above inside os.tmpdir and never uses user data.
    fs.rmSync(dir, {recursive: true, force: true});
  }
  console.log('  ok One Piece franchise: actual AniList graph, exact addition, ONA seasons, one-shot boundaries, cycles and bounded traversal');
  console.log('  ok legacy grouping: startup/reopen/import/cloud repair, saved IDs/links/progress/ratings/covers/preferences preserved, uncertain groups untouched');
})().catch(error => { console.error(error); process.exitCode = 1; });
