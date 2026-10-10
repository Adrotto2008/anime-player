'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { Store } = require('../src/store');
const { createSeriesAdder } = require('../src/series-addition');
const { discoverSeriesSources, createSourceDiscoveryQueue } = require('../src/source-discovery');

async function main() {
  const file = path.join(os.tmpdir(), `anime-player-source-regression-${process.pid}.json`);
  const store = new Store(file);
  const scheduled = []; const calls = []; const notifications = [];
  const media = { anilistId: 151807, title: 'Solo Leveling', altTitle: 'Ore dake Level Up na Ken',
    episodeCount: 2, format: 'TV', year: 2024, related: [] };
  let unityMode = 'empty'; let aliasFails = false; let worldFails = false;
  const metadata = {
    getAnimeBatch: async () => [{ ...media }],
    getAnime: async () => { if (aliasFails) throw new Error('AniList offline'); return { ...media }; },
    fetchEpisodes: async () => { throw new Error('Kitsu offline (simulato)'); },
    fetchImdbData: async () => null,
  };
  const animeUnity = { findSources: async (options) => {
    calls.push({ provider: 'animeunity', options });
    if (unityMode === 'error') throw new Error('AnimeUnity offline (simulato)');
    if (unityMode === 'invalid') return [{ number: 1, url: 'not-a-link' }];
    return [];
  } };
  const animeWorld = { findSources: async (options) => {
    calls.push({ provider: 'animeworld', options });
    if (worldFails) throw new Error('AnimeWorld offline (simulato)');
    return [{ number: 1, url: 'https://video.test/ep1.mp4' }, { number: 2, url: 'https://video.test/ep2.mp4' },
      { number: 99, url: 'https://video.test/wrong-season.mp4' }];
  } };
  const queue = createSourceDiscoveryQueue({ store, metadata, schedule: (job) => scheduled.push(job),
    discover: (series, titles) => discoverSeriesSources(series, titles, { store, animeUnity, animeWorld }),
    onComplete: (id, result) => notifications.push({ id, result }),
  });
  const create = createSeriesAdder({ store, metadata, sourceQueue: queue });
  const flush = async () => { while (scheduled.length) scheduled.shift()(); await queue.waitForIdle(); };

  try {
    const added = await create({ anilistId: media.anilistId });
    assert.strictEqual(added.sourceDiscoveryPending, true);
    assert.strictEqual(scheduled.length, 1, 'adding a series automatically schedules discovery');
    assert.strictEqual(calls.length, 0, 'addition returns while the background job is pending');
    const series = store.getSeries(added.id);
    assert.strictEqual(series.altTitle, media.altTitle, 'the original AniList title must be saved');
    assert.strictEqual(series.episodes.length, 2, 'metadata failure does not prevent saving the episodes');
    await flush();
    assert.deepStrictEqual(calls.map((item) => item.provider), ['animeunity', 'animeworld']);
    assert.ok(calls[1].options.titles.includes(media.altTitle));
    assert.strictEqual(series.episodes.every((episode) => episode.sources.length === 1), true);
    assert.strictEqual(notifications[0].result.episodesFound, 2);
    assert.strictEqual(series.episodes.some((episode) => episode.number === 99), false);

    const episode = series.episodes[0]; const originalId = episode.id;
    store.addSources(series.id, [{ number: 1, url: 'https://manual.test/saved.mp4' }]);
    store.setProgress(series.id, episode.id, { pos: 77, duration: 120, watched: false });
    store.updateSeries(series.id, { preset: 'aa-hq', personalRating: 9 });
    episode.sources[0].referer = 'https://user.test/custom-referer/';
    episode.sources[0].userAgent = 'User custom agent';
    const savedSource = JSON.stringify(episode.sources[0]);
    calls.length = 0; unityMode = 'error';
    const retry = queue.enqueue(series.id, [], { notify: false });
    await flush(); const retryResult = await retry;
    assert.deepStrictEqual(calls.map((item) => item.provider), ['animeunity', 'animeworld'], 'AnimeUnity errors cannot interrupt AnimeWorld');
    assert.strictEqual(retryResult.episodesFound, 2);
    assert.strictEqual(retryResult.episodesAdded, 0, 'existing URLs are not duplicated');
    assert.strictEqual(JSON.stringify(episode.sources[0]), savedSource, 'retry cannot overwrite saved headers');
    assert.strictEqual(episode.id, originalId);
    assert.strictEqual(episode.progress.pos, 77);
    assert.strictEqual(series.preset, 'aa-hq'); assert.strictEqual(series.personalRating, 9);
    assert.ok(episode.sources.some((source) => source.url === 'https://manual.test/saved.mp4'));

    // The old franchise branch skipped this record solely because episodeCount was complete.
    series.episodes[1].sources = []; calls.length = 0; unityMode = 'invalid';
    const readded = await create({ anilistId: media.anilistId });
    assert.strictEqual(readded.id, series.id); assert.strictEqual(store.data.series.length, 1);
    assert.strictEqual(readded.sourceDiscoveryPending, true);
    await flush();
    assert.deepStrictEqual(calls.map((item) => item.provider), ['animeunity', 'animeworld']);
    assert.strictEqual(series.episodes[1].sources.length, 1);

    // Retry records created by old app versions that discarded altTitle.
    delete series.altTitle; calls.length = 0;
    const legacyRetry = queue.enqueue(series.id, [series.title], { notify: false });
    await flush(); await legacyRetry;
    assert.strictEqual(series.altTitle, media.altTitle);
    assert.ok(calls[1].options.titles.includes(media.altTitle));
    delete series.altTitle; aliasFails = true; calls.length = 0;
    const offlineAliasRetry = queue.enqueue(series.id, [series.title], { notify: false });
    await flush(); await offlineAliasRetry;
    assert.strictEqual(calls[1].provider, 'animeworld', 'AniList alias recovery failure must not block providers');

    // Execute the real renderer's retry button even with links already present.
    const renderer = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
    const viewCode = renderer.slice(renderer.indexOf('function seriesView(s) {'), renderer.indexOf('function getRatingTier(score) {'));
    const uiCalls = []; let notified;
    const context = { state: { player: {} }, h: (tag, props, ...children) => ({ tag, props, children: children.flat(Infinity) }),
      t: (key) => key, icon: () => null, defaultPreset: () => 'aa-hq', resumeTarget: () => null,
      episodeTotal: (s) => s.episodes.length, effectivePersonalRating: () => null, statusLabel: () => '',
      bg: () => ({}), field: () => null, presetLabel: () => '', castRelatedSection: () => null, episodeRow: () => null,
      formatDuration: () => '', render: () => {}, go: () => {}, play: () => {}, mutate: () => {}, openAddLinks: () => {},
      addMovieLinkDialog: () => {}, notifySourceDiscovery: (result) => { notified = result; },
      call: async (channel, id) => { uiCalls.push([channel, id]); const result = queue.enqueue(id, [], { notify: false }); await flush(); return { lib: store.snapshot(), sourceDiscovery: await result }; },
    };
    vm.createContext(context); vm.runInContext(viewCode, context);
    const page = context.seriesView(series);
    const buttons = [];
    const walk = (node) => { if (!node || typeof node !== 'object') return; if (node.tag === 'button') buttons.push(node); (node.children || []).forEach(walk); };
    walk(page);
    const button = buttons.find((node) => node.children.includes('discoverLinks'));
    assert.ok(button, 'manual retry remains available when all episode links are already saved');
    await button.props.onclick({ currentTarget: {} });
    assert.deepStrictEqual(uiCalls, [['series:discoverSources', series.id]]);
    assert.strictEqual(notified.episodesFound, 2);

    // Coalescing prevents addition and a simultaneous manual retry running twice.
    calls.length = 0;
    const one = queue.enqueue(series.id); const two = queue.enqueue(series.id, [], { notify: false });
    assert.strictEqual(one, two); await flush();
    assert.strictEqual(calls.length, 2);
    // Even when both providers fail, the series and its saved user data survive.
    unityMode = 'error'; worldFails = true; calls.length = 0;
    const beforeFailure = JSON.stringify(series.episodes);
    const failed = queue.enqueue(series.id); await flush();
    assert.strictEqual((await failed).unavailable, true);
    assert.deepStrictEqual(calls.map((item) => item.provider), ['animeunity', 'animeworld']);
    assert.strictEqual(JSON.stringify(series.episodes), beforeFailure);
    const manual = await create({ title: 'New manual title' });
    assert.strictEqual(manual.sourceDiscoveryPending, true);
    assert.ok(store.getSeries(manual.id), 'provider failure cannot prevent addition');
    await flush(); assert.ok(store.getSeries(manual.id));
    assert.strictEqual(notifications.at(-1).result.unavailable, true);
    console.log('  ok source regression (simulated): automatic background addition, complete reused records, AU empty/error/invalid → AW, aliases, actual retry button, stable links/IDs/progress');
  } finally { clearTimeout(store._timer); try { fs.unlinkSync(file); } catch {} }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
