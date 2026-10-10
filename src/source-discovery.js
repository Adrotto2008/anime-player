'use strict';

const { isValidSource } = require('./patterns');

async function discoverSeriesSources(series, titles = [series.title], { store, animeUnity, animeWorld }) {
  const outcomes = {};
  const linkedNumbers = new Set(); const foundNumbers = new Set();
  titles = [...new Set([series.title, series.altTitle, ...(titles || [])].map((title) => String(title || '').trim()).filter(Boolean))];
  for (const [name, client, options] of [
    ['animeunity', animeUnity, { titles, year: series.year, episodeCount: series.episodeCount }],
    ['animeworld', animeWorld, { titles, year: series.year, episodeCount: series.episodeCount }],
  ]) {
    try {
      const found = await client.findSources(options);
      const sources = (Array.isArray(found) ? found : []).filter((source) => Number.isSafeInteger(source?.number) && source.number >= 0
        && (!series.episodeCount || source.number <= series.episodeCount) && typeof source.url === 'string'
        && /^https?:\/\//i.test(source.url) && isValidSource(source.url))
        .map((source) => ({ ...source, provider: name, ...(name === 'animeworld' ? { referer: 'https://www.animeworld.ac/' } : {}) }));
      const before = new Map(store.getSeries(series.id).episodes.map((episode) => [episode.number, new Set(episode.sources.map((source) => source.url))]));
      const linkedEpisodes = new Set(sources.filter((source) => !before.get(source.number)?.has(source.url)).map((source) => source.number));
      // Keep saved URLs and their custom headers untouched during a retry.
      const missing = sources.filter((source) => !before.get(source.number)?.has(source.url));
      if (missing.length) store.addSources(series.id, missing);
      sources.forEach((source) => foundNumbers.add(source.number));
      linkedEpisodes.forEach((number) => linkedNumbers.add(number));
      outcomes[name] = { episodesAdded: linkedEpisodes.size, linksFound: sources.length, unavailable: false };
    } catch (err) {
      console.warn(`${name} source discovery failed:`, err.message);
      outcomes[name] = { episodesAdded: 0, unavailable: true };
    }
  }
  return {
    episodesAdded: linkedNumbers.size,
    episodesFound: foundNumbers.size,
    unavailable: Object.values(outcomes).every((result) => result.unavailable),
    providers: outcomes,
  };
}

// Both automatic addition and manual retry use this queue. Jobs are coalesced per
// series and serialized because the provider clients share session cookies.
function createSourceDiscoveryQueue({ store, metadata, discover, onComplete = () => {}, schedule = setImmediate }) {
  const pending = new Map(); let tail = Promise.resolve();
  const enqueue = (id, titles = [], { notify = true } = {}) => {
    if (pending.has(id)) {
      const job = pending.get(id); if (!notify) job.notify = false;
      return job.promise;
    }
    const job = { notify };
    job.promise = new Promise((resolve) => schedule(() => {
      const run = tail.then(async () => {
        let series = store.getSeries(id);
        if (!series || series.format === 'MOVIE') return { cancelled: true, episodesAdded: 0, episodesFound: 0 };
        let aliases = [...new Set([series.title, series.altTitle, ...titles].filter(Boolean))];
        if (series.anilistId && !series.altTitle && aliases.length < 2) {
          try {
            const media = await metadata.getAnime(series.anilistId);
            if (!store.getSeries(id)) return { cancelled: true };
            if (media.altTitle) store.updateSeries(id, { altTitle: media.altTitle });
            aliases.push(media.title, media.altTitle);
          } catch (error) { console.warn('Titolo alternativo AniList non disponibile:', error.message); }
        }
        series = store.getSeries(id);
        if (!series) return { cancelled: true };
        try { return await discover(series, [...new Set(aliases.filter(Boolean))]); }
        catch (error) { console.warn('Source discovery failed:', error.message); return { episodesAdded: 0, episodesFound: 0, unavailable: true }; }
      });
      tail = run.catch(() => {});
      run.then((result) => {
        pending.delete(id);
        try { if (job.notify && !result.cancelled && store.getSeries(id)) onComplete(id, result); }
        catch (error) { console.warn('Discovery notification failed:', error.message); }
        resolve(result);
      }, (error) => {
        pending.delete(id); console.warn('Background discovery failed:', error.message);
        resolve({ episodesAdded: 0, episodesFound: 0, unavailable: true });
      });
    }));
    pending.set(id, job);
    return job.promise;
  };
  return { enqueue, waitForIdle: () => Promise.all([...pending.values()].map((job) => job.promise)) };
}

module.exports = { discoverSeriesSources, createSourceDiscoveryQueue };
