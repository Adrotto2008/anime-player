'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveFranchise, applyFranchiseMetadata, planFranchiseAddition } = require('../src/franchise');
const Ratings=require('../src/episode-ratings');
const { validateLibraryData, Store } = require('../src/store');
const { mergeLibrarySnapshots, compressLibraryForCloud, expandLibraryFromCloud } = require('../src/cloud');
const { discoverSeriesSources } = require('../src/source-discovery');

const media = (anilistId, title, format = 'TV', related = []) => ({
  anilistId, title, altTitle: title, type: 'ANIME', format, year: 2020, related,
  cover: `https://img.test/${anilistId}.jpg`, episodes: [],
});
const link = (id, title, format, relation) => ({ id, title, type: 'ANIME', format, relation });
const graph = new Map([
  ['1', media(1, 'Saga', 'TV', [link(2, 'Saga Season 2', 'TV', 'SEQUEL')])],
  ['2', media(2, 'Saga Season 2', 'TV', [link(1, 'Saga', 'TV', 'PREQUEL'), link(3, 'Saga Season 3', 'TV', 'SEQUEL'), link(4, 'Saga Movie', 'MOVIE', 'SIDE_STORY'), link(5, 'Bad spin-off', 'TV', 'SPIN_OFF'), link(6, 'Recap', 'TV', 'SUMMARY'), link(7, 'Alternate', 'TV', 'ALTERNATIVE'), link(8, 'Same universe', 'TV', 'PARENT')])],
  ['3', media(3, 'Saga Season 3', 'TV', [link(2, 'Saga Season 2', 'TV', 'PREQUEL')])],
  ['4', media(4, 'Saga Movie', 'MOVIE')],
  ['5', media(5, 'Bad spin-off')], ['6', media(6, 'Recap')], ['7', media(7, 'Alternate')], ['8', media(8, 'Same universe')],
]);
const fetchByIds = async (ids) => ids.map((id) => graph.get(String(id))).filter(Boolean);

(async () => {
  const fromOne = await resolveFranchise(1, fetchByIds);
  const fromTwo = await resolveFranchise(2, fetchByIds);
  const fromThree = await resolveFranchise(3, fetchByIds);
  for (const resolved of [fromOne, fromTwo, fromThree]) {
    assert.deepStrictEqual(resolved.items.map((item) => item.anilistId), [1, 2, 3]);
    assert.deepStrictEqual(resolved.movies.map((item) => item.anilistId), [4]);
    assert.strictEqual(resolved.ambiguous, false);
    assert.ok(resolved.requests <= 24);
  }
  const selected = applyFranchiseMetadata([...fromTwo.items, ...fromTwo.movies], {
    franchiseId: 1, franchiseTitle: 'Saga', items: fromTwo.items,
  });
  assert.deepStrictEqual(selected.slice(0, 3).map((item) => item.franchiseOrder), [1, 2, 3]);
  assert.deepStrictEqual(selected.slice(0, 3).map((item) => item.franchiseSeasonNumber), [null, 2, 3]);
  assert.strictEqual(selected[3].franchiseType, 'movie');
  assert.strictEqual(selected[3].franchiseSeasonNumber, undefined, 'movies must not receive episode-season numbers');
  assert.strictEqual(selected.some((item) => [5, 6, 7, 8].includes(item.anilistId)), false, 'spin-offs, recaps, alternatives and same-universe links are excluded');
  const alreadySaved = { id: 'keep-id', anilistId: 2, title: 'Saved season', episodes: [{ id: 'keep-episode', sources: [{ url: 'https://manual.test/keep' }], progress: { pos: 10 } }] };
  const repeatedPlan = planFranchiseAddition([selected[1], selected[1], selected[2]], [alreadySaved]);
  assert.strictEqual(repeatedPlan.length, 2, 'a repeated franchise result is planned only once per AniList ID');
  assert.strictEqual(repeatedPlan[0].existing, alreadySaved, 'an existing AniList record is reused without replacing user state');

  const branched = new Map(graph);
  branched.set('2', media(2, 'Saga Season 2', 'TV', [link(1, 'Saga', 'TV', 'PREQUEL'), link(3, 'Saga Season 3', 'TV', 'SEQUEL'), link(9, 'Saga extra season', 'TV', 'SEQUEL')]));
  branched.set('9', media(9, 'Saga extra season'));
  const safeFallback = await resolveFranchise(2, async (ids) => ids.map((id) => branched.get(String(id))).filter(Boolean));
  assert.strictEqual(safeFallback.ambiguous, true);
  assert.deepStrictEqual(safeFallback.items.map((item) => item.anilistId), [2]);
  assert.strictEqual(safeFallback.movies.length, 0);

  const chart={imdbId:'tt123',title:'Saga',seasons:[{season:2,episodes:Array.from({length:5},(_,i)=>({id:`tt10${i}`,number:i+1,rating:8}))}]};
  const chartTarget = Ratings.target([
    { id: 'season-1', title:'Saga',episodeCount:5, episodes: [{ id: 'ep-1', number: 1 }] },
    { id: 'season-2', title:'Saga Season 2',episodeCount:5, episodes: [{ id: 'ep-5', number: 5 }] },
    { id: 'movie', title:'Saga Season 2',format: 'MOVIE',episodeCount:5, episodes: [{ id: 'wrong', number: 5 }] },
  ], chart,2,5);
  assert.strictEqual(chartTarget.series.id, 'season-2');
  assert.strictEqual(chartTarget.episode.id, 'ep-5');
  assert.strictEqual(Ratings.target([{ id: 'one', franchiseId: 'f', title: 'Untitled sequel', episodes: [{ id: 'ep', number: 1 }] }], chart,1,1), null, 'unknown franchise order cannot make an incorrect IMDb click target');

  const base = {
    id: 'season-2', title: 'Saga Season 2', anilistId: 2, franchiseId: '1', franchiseTitle: 'Saga', franchiseOrder: 2,
    franchiseType: 'season', franchiseSeasonNumber: 2, preset: 'aa-hq', referer: 'https://manual.test/', addedAt: 1, updatedAt: 2,
    episodes: [{ id: 'episode-id', number: 1, title: '', thumb: null, duration: 0, personalRating: 8, skipTimes: [], updatedAt: 12,
      sources: [{ url: 'https://manual.test/ep1.mp4', label: 'manual.test' }], progress: { pos: 42, duration: 120, watched: false, updatedAt: 12 } }],
  };
  const validated = validateLibraryData({ series: [base] }).series[0];
  assert.strictEqual(validated.id, base.id);
  assert.strictEqual(validated.episodes[0].id, 'episode-id');
  assert.strictEqual(validated.episodes[0].sources[0].url, base.episodes[0].sources[0].url);
  assert.strictEqual(validated.episodes[0].progress.pos, 42);
  assert.strictEqual(validated.franchiseSeasonNumber, 2);
  const compressed = compressLibraryForCloud({ series: [{ ...base, movieSources: [{ url: 'https://film.test/watch', label: 'film.test' }] }] });
  const expanded = expandLibraryFromCloud(compressed).series[0];
  assert.strictEqual(expanded.franchiseId, '1');
  assert.strictEqual(expanded.franchiseOrder, 2);
  assert.strictEqual(expanded.movieSources[0].url, 'https://film.test/watch');
  const merged = mergeLibrarySnapshots({ series: [{ ...base, movieSources: [{ url: 'https://film.test/local' }] }] }, { series: [{ ...base, updatedAt: 3, franchiseSeasonNumber: null, movieSources: [{ url: 'https://film.test/remote' }] }] }).series[0];
  assert.strictEqual(merged.franchiseId, '1');
  assert.strictEqual(merged.episodes[0].progress.pos, 42);
  assert.deepStrictEqual(merged.movieSources.map((source) => source.url).sort(), ['https://film.test/local', 'https://film.test/remote']);

  const tempFile = path.join(os.tmpdir(), `anime-player-franchise-${process.pid}.json`);
  const store = new Store(tempFile);
  const existing = store.addSeries({ title: base.title, anilistId: 2 });
  store.addSources(existing.id, [{ number: 1, url: 'https://manual.test/ep1.mp4' }]);
  const episodeId = existing.episodes[0].id;
  store.setProgress(existing.id, episodeId, { pos: 42, duration: 120, watched: false });
  const sourceId = existing.episodes[0].sources[0].url;
  store.updateSeries(existing.id, { franchiseId: '1', franchiseTitle: 'Saga', franchiseOrder: 2, franchiseType: 'season', franchiseSeasonNumber: 2 });
  assert.strictEqual(existing.episodes[0].id, episodeId);
  assert.strictEqual(existing.episodes[0].sources[0].url, sourceId);
  assert.strictEqual(existing.episodes[0].progress.pos, 42);
  assert.deepStrictEqual(existing.episodes[0].sources.map((source) => source.provider || 'manual'), ['manual']);
  const newlyAdded = [store.addSeries({ title: 'Saga', episodeCount: 1 }), store.addSeries({ title: 'Saga Season 2', episodeCount: 1 })];
  const providerCalls = [];
  const clients = Object.fromEntries(['animeunity', 'animeworld'].map((name) => [name === 'animeunity' ? 'animeUnity' : 'animeWorld', { findSources: async () => {
    providerCalls.push(`${name}:${providerCalls.filter((call) => call.endsWith(newlyAdded[0].id) || call.endsWith(newlyAdded[1].id)).length}`);
    return [{ number: 1, url: `https://${name}.test/${providerCalls.length}.mp4` }];
  } }]));
  for (const record of newlyAdded) await discoverSeriesSources(record, [record.title], { store, ...clients });
  assert.strictEqual(newlyAdded.every((record) => record.episodes[0].sources.length === 2), true, 'each newly created season receives both providers');
  assert.strictEqual(newlyAdded.every((record) => record.episodes[0].sources[0].provider === 'animeunity' && record.episodes[0].sources[1].provider === 'animeworld'), true, 'franchise discovery keeps provider priority');
  assert.strictEqual(providerCalls.length, 4);
  clearTimeout(store._timer); try { fs.unlinkSync(tempFile); } catch { /* no file has been flushed */ }
  console.log('  ok franchise AniList: chain in both directions, movie, ambiguous fallback and excluded relations');
  console.log('  ok franchise store/cloud: IDs, links, progress, metadata and provider/manual source data persist');
  console.log('  ok franchise providers: each new season receives AnimeUnity before AnimeWorld');
  console.log('  ok IMDb franchise chart: season/episode mapping and movie exclusion');
})().catch((error) => { console.error(error); process.exitCode = 1; });
