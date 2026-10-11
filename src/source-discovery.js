'use strict';

const { matchOptions } = require('./source-match');
const { isValidSource } = require('./patterns');
const { providerTitles, redact } = require('./source-state');
const Model = require('./franchise-model');
const {partSources} = require('./content-parts');

async function discoverSeriesSources(series, titles = [series.title], { store, animeUnity, animeWorld }) {
  const outcomes = {};
  const linkedNumbers = new Set(); const foundNumbers = new Set();
  titles = providerTitles(series, titles).map(title => String(title).trim()).filter(Boolean);
  const single=Model.singleWork(series);
  const matching={...matchOptions(series),...(single ? {episodeCount:undefined,contentMode:'parts'} : {})};
  for (const [name, client, options] of [
    ['animeunity', animeUnity, { titles, ...matching }],
    ['animeworld', animeWorld, { titles, ...matching }],
  ]) {
    try {
      const found = await client.findSources(options);
      if (!store.getSeries(series.id)) return {cancelled:true};
      const rejectedSources = (Array.isArray(found) ? found : []).flatMap(source => {
        const reasons = [];
        if (!Number.isSafeInteger(source?.number) || source.number < 0) reasons.push('invalid_episode_number');
        else if (!single && series.episodeCount && source.number > series.episodeCount) reasons.push('episode_out_of_range');
        if (typeof source?.url !== 'string' || !/^https?:\/\//i.test(source.url) || !isValidSource(source.url)) reasons.push('invalid_url');
        if (source?.resolutionState === 'found') reasons.push('media_unresolved');
        return reasons.length ? [{ number: source?.number, reasons }] : [];
      });
      let sources = (Array.isArray(found) ? found : []).filter((source) => Number.isSafeInteger(source?.number) && source.number >= 0
        && (single || !series.episodeCount || source.number <= series.episodeCount) && typeof source.url === 'string'
        && /^https?:\/\//i.test(source.url) && isValidSource(source.url) && source.resolutionState !== 'found')
        .map((source) => ({ ...source, provider: name, ...(name === 'animeworld' ? { referer: 'https://www.animeworld.ac/' } : {}) }));
      if (single) sources=partSources(sources);
      const identity=source=>single?source.contentPartKey:source.number;
      const before = new Map((single ? store.getSeries(series.id).mediaParts || [] : store.getSeries(series.id).episodes).map((episode) => [single?episode.key:episode.number, new Set(episode.sources.map((source) => source.url))]));
      const linkedEpisodes = new Set(sources.filter((source) => !before.get(identity(source))?.has(source.url)).map(identity));
      // Keep manual URLs/custom headers. Stable IDs coalesce automatic token rotations;
      // unchanged automatic URLs may gain classification from this discovery.
      if (sources.length) single ? store.addContentSources(series.id,sources) : store.addSources(series.id, sources);
      sources.forEach((source) => foundNumbers.add(identity(source)));
      linkedEpisodes.forEach((number) => linkedNumbers.add(number));
      outcomes[name] = { ...client.lastDiscovery, rejectedSources, episodesAdded: linkedEpisodes.size, linksFound: (Array.isArray(found) ? found : []).length,
        linksResolved: sources.filter(source=>source.resolutionState === 'resolved').length,
        status: sources.length ? 'found' : rejectedSources.some(item => item.reasons.includes('media_unresolved')) ? 'media_unresolved' : client.lastDiscovery?.status || 'title_not_found',
        playbackVerified:false, unavailable: client.lastDiscovery?.status === 'provider_error' };
    } catch (err) {
      console.warn(`${name} source discovery failed:`, redact(err.message));
      outcomes[name] = { episodesAdded: 0, linksFound:0, status:'provider_error', error:redact(err.message), unavailable: true };
    }
  }
  const result = {
    contentKind:single?'parts':'episodes',
    episodesAdded: linkedNumbers.size,
    episodesFound: foundNumbers.size,
    unavailable: Object.values(outcomes).every((result) => result.unavailable),
    providers: outcomes,
  };
  if (store.getSeries(series.id)) store.updateSeries(series.id,{sourceDiscovery:{...result,checkedAt:Date.now()}});
  return result;
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
        if (!series || job.cancelled) return { cancelled: true, episodesAdded: 0, episodesFound: 0 };
        let aliases = [...new Set([series.title, series.altTitle, ...(series.titleAliases || []), ...titles].filter(Boolean))];
        if (series.anilistId && !series.titleAliases?.length) {
          try {
            const media = await metadata.getAnime(series.anilistId);
            if (!store.getSeries(id) || job.cancelled) return { cancelled: true };
            if (media.altTitle) store.updateSeries(id, { altTitle: media.altTitle });
            if (media.titleAliases?.length) store.updateSeries(id, {titleAliases:media.titleAliases});
            aliases.push(media.title, media.altTitle, ...(media.titleAliases || []));
          } catch (error) { console.warn('Titolo alternativo AniList non disponibile:', error.message); }
        }
        series = store.getSeries(id);
        if (!series || job.cancelled) return { cancelled: true };
        try { const result=await discover(series, [...new Set(aliases.filter(Boolean))]);return job.cancelled?{cancelled:true}:result; }
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
  return { enqueue, cancel:ids=>{for(const id of ids){const job=pending.get(id);if(job){job.cancelled=true;job.notify=false;}}},
    waitForIdle: () => Promise.all([...pending.values()].map((job) => job.promise)) };
}

module.exports = { discoverSeriesSources, createSourceDiscoveryQueue };
