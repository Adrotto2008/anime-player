'use strict';
const assert = require('assert'); const fs = require('fs'); const path = require('path'); const os = require('os');
const { createAniListClient } = require('../src/anilist-client');
const { createSeriesAdder } = require('../src/series-addition'); const { Store } = require('../src/store');
const response = (status, data = { data: { Media: { id: 1, title: { english: 'Demo' } } } }, headers = {}) => ({
  ok: status === 200, status, headers: { get: key => headers[key] ?? null }, json: async () => data,
  body: { cancel: async () => {} },
});
function clockClient(fetcher, extra = {}) {
  let time = 1700000000000; const waits = []; const calls = [];
  const client = createAniListClient({ now: () => time, sleep: async ms => { waits.push(ms); time += ms; },
    fetchImpl: async (...args) => { calls.push(time); return fetcher(...args); }, ...extra });
  return { client, waits, calls, advance: ms => { time += ms; } };
}
(async () => {
  let count = 0;
  const retry = clockClient(async () => ++count === 1 ? response(429, null, { 'retry-after': '10', 'x-ratelimit-reset': '1700000012' }) : response(200));
  const [one, two] = await Promise.all([retry.client.request('same', { id: 1 }), retry.client.request('same', { id: 1 })]);
  assert.strictEqual(count, 2, 'duplicate consumers share one request and one retry');
  assert.strictEqual(retry.calls[1] - retry.calls[0], 12000, 'respect the later Retry-After/reset deadline');
  one.Media.title.english = 'Changed'; assert.strictEqual(two.Media.title.english, 'Demo');
  assert.strictEqual(retry.client.getMedia(1).title.english, 'Demo');
  retry.advance(300001); assert.strictEqual(retry.client.getMedia(1), null, 'record cache expires');

  let inFlight = 0; let maxConcurrent = 0;
  const queue = clockClient(async () => { inFlight++; maxConcurrent = Math.max(inFlight, maxConcurrent); await Promise.resolve(); inFlight--; return response(200); });
  await Promise.all([1, 2, 3].map(id => queue.client.request('different', { id })));
  assert.strictEqual(maxConcurrent, 1); assert.deepStrictEqual(queue.calls.map(t => t - queue.calls[0]), [0, 2200, 4400]);
  const exhausted = clockClient(async () => response(200, undefined, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000008' }));
  await exhausted.client.request('one', {}); await exhausted.client.request('two', {});
  assert.strictEqual(exhausted.calls[1] - exhausted.calls[0], 8000, 'successful response with remaining=0 pauses other work');
  const lowerLimit = clockClient(async () => response(200, undefined, { 'x-ratelimit-limit': '10' }));
  await lowerLimit.client.request('one', {}); await lowerLimit.client.request('two', {}); await lowerLimit.client.request('three', {});
  assert.strictEqual(lowerLimit.calls[1] - lowerLimit.calls[0], 6100);
  assert.strictEqual(lowerLimit.calls[2] - lowerLimit.calls[1], 6100);

  const missingHeader = clockClient(async () => response(429));
  await assert.rejects(missingHeader.client.request('limit', {}), error => error.status === 429 && error.retryAfter === 60);
  assert.strictEqual(missingHeader.calls.length, 2); assert.deepStrictEqual(missingHeader.waits, [60000], 'bounded retries with default cooldown');
  const longWait = clockClient(async () => response(429, null, { 'retry-after': '120' }));
  await assert.rejects(longWait.client.request('limit', {}), error => error.status === 429 && error.retryAfter === 120);
  assert.strictEqual(longWait.calls.length, 1); assert.strictEqual(longWait.waits.length, 0, 'long cooldown returns a useful error without an unbounded wait');
  let failures = 0;
  const recovered = clockClient(async () => ++failures === 1 ? response(500) : response(200));
  await assert.rejects(recovered.client.request('same', { s: 'Demo' }), /500/);
  await recovered.client.request('same', { s: 'Demo' });
  await recovered.client.request('same', { s: 'Demo' }); assert.strictEqual(failures, 2, 'errors are not cached; successful searches are');
  let graphql = 0;
  const graphError = clockClient(async () => ++graphql === 1 ? response(200, { errors: [{ status: 429 }] }, { 'retry-after': '3' }) : response(200));
  await graphError.client.request('graphql', {}); assert.strictEqual(graphError.calls[1] - graphError.calls[0], 3000);

  const originalFetch = global.fetch; const apiCalls = [];
  const media = id => ({ id, title: { english: 'Demo '+id, romaji: 'Original '+id }, format: 'TV', episodes: 1, coverImage: { large: 'https://cover.test/'+id } });
  try {
    global.fetch = async (_url, options) => {
      const { variables } = JSON.parse(options.body); apiCalls.push(variables);
      return response(200, { data: { Page: { media: (variables.ids || [910001]).map(media) } } });
    };
    const metadata = require('../src/metadata');
    await metadata.searchAnime('Demo cache test');
    const selected = await metadata.getAnime(910001);
    assert.strictEqual(selected.title, 'Demo 910001'); assert.strictEqual(apiCalls.length, 1);
    const batch = await metadata.getAnimeBatch([910001, 910002]);
    assert.deepStrictEqual(apiCalls[1].ids, [910002]); assert.deepStrictEqual(batch.map(x => x.anilistId), [910001, 910002]);
    assert.strictEqual((await metadata.getCachedAnime(910001)).cover, selected.cover);
    assert.strictEqual(await metadata.getCachedAnime(999999), null);
  } finally { global.fetch = originalFetch; }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-anilist-limit-'));
  const store = new Store(path.join(dir, 'library.json')); let directCalls = 0; let queued = 0;
  try {
    const selected = { anilistId: 910001, title: 'Selected', format: 'TV', episodeCount: 1, cover: 'https://cover.test/selected', titleAliases: ['Original'] };
    const metadata = { getAnimeBatch: async () => { throw Object.assign(new Error('Limited'), { status: 429 }); },
      getAnime: async () => { directCalls++; throw new Error('Must not request a throttled API'); },
      getCachedAnime: async () => structuredClone(selected), fetchEpisodes: async () => ({ episodes: [] }), fetchImdbData: async () => null };
    const add = createSeriesAdder({ store, metadata, sourceQueue: { enqueue: () => { queued++; } } });
    const first = await add({ anilistId: selected.anilistId }); assert.strictEqual(first.ambiguous, true); assert.strictEqual(first.franchiseDeferred, true); assert.strictEqual(directCalls, 0);
    const series = store.getSeries(first.id); const episode = series.episodes[0];
    store.addSources(series.id, [{ number: 1, url: 'https://manual.test/1.mp4' }]);
    store.setProgress(series.id, episode.id, { pos: 42, duration: 100, watched: false }); store.updateSeries(series.id, { personalRating: 8, preset: 'aa-hq' });
    const stableSnapshot = () => {
      const snapshot = store.snapshot(); snapshot.updatedAt = 0;
      for (const item of snapshot.series) item.updatedAt = 0;
      return JSON.stringify(snapshot);
    };
    const saved = stableSnapshot();
    const repeated = await add({ anilistId: selected.anilistId }); assert.strictEqual(repeated.id, first.id);
    assert.strictEqual(stableSnapshot(), saved, 'retry preserves sources, progress, ratings, covers and preferences');
    metadata.getCachedAnime = async () => null;
    await assert.rejects(add({ anilistId: 910003 }), error => error.status === 429);
    assert.strictEqual(store.data.series.length, 1); assert.strictEqual(directCalls, 0); assert.strictEqual(queued, 1);
  } finally { clearTimeout(store._timer); fs.rmSync(dir, { recursive: true, force: true }); }
  console.log('AniList: shared pacing, 429 cooldown/retries, deduplication, cache expiry/immutability, search-to-add reuse and protected addition fallback passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
