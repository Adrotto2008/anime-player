'use strict';

const { resolveFranchise, applyFranchiseMetadata, planFranchiseAddition } = require('./franchise');

function createSeriesAdder({ store, metadata, sourceQueue }) {
  const addRatings = async (series, media) => {
    try {
      const imdb = await metadata.fetchImdbData({ title: series.title, altTitle: media?.altTitle });
      if (!imdb || !store.getSeries(series.id)) return;
      store.refreshSeriesMetadata(series.id, { imdbId: imdb.imdbId, imdbChart: imdb,
        ...(imdb.overallRating != null ? { score: imdb.overallRating, scoreSource: 'IMDb' } : {}) });
    } catch { /* Ratings never block addition or provider discovery. */ }
  };

  return async ({ anilistId, title }) => {
    if (!anilistId) {
      const series = store.addSeries({ title: String(title || '').trim() || 'Senza titolo' });
      sourceQueue.enqueue(series.id, [series.title]);
      await addRatings(series);
      return { id: series.id, lib: store.snapshot(), sourceDiscoveryPending: true };
    }
    const language = store.data.settings.language;
    let graph;
    try { graph = await resolveFranchise(anilistId, (ids) => metadata.getAnimeBatch(ids, { language })); }
    catch (error) {
      console.warn('AniList franchise lookup failed; adding the selected title only:', error.message);
      const seed = await metadata.getAnime(anilistId, { language });
      graph = { seed, items: [seed], movies: [], ambiguous: true };
    }
    const allTitles = [...graph.items, ...graph.movies];
    const grouped = !graph.ambiguous && allTitles.length > 1;
    const records = grouped ? applyFranchiseMetadata(allTitles, {
      franchiseId: graph.items[0].anilistId, franchiseTitle: graph.items[0].title, items: graph.items,
    }) : allTitles;
    const sourceIds = []; let selectedId;
    for (const { media, existing } of planFranchiseAddition(records, store.data.series)) {
      const isMovie = media.format === 'MOVIE';
      const incomplete = existing && media.episodeCount && existing.episodes.length < media.episodeCount;
      let series = existing;
      if (existing) {
        const patch = {};
        if (grouped) for (const key of ['franchiseId', 'franchiseTitle', 'franchiseOrder', 'franchiseType', 'franchiseSeasonNumber']) {
          if (media[key] !== undefined) patch[key] = media[key];
        }
        // Restore aliases dropped by older versions without replacing user titles.
        if (!series.altTitle && media.altTitle) patch.altTitle = media.altTitle;
        if (Object.keys(patch).length) store.updateSeries(series.id, patch);
      } else {
        const { streamingEpisodes, ...fields } = media;
        series = store.addSeries({ ...fields, episodes: [], ...(isMovie ? { movieSources: [] } : {}) });
      }
      if (String(media.anilistId) === String(anilistId)) selectedId = series.id;
      if (isMovie) continue;

      if (media.episodeCount > 0 && media.episodeCount <= 300) {
        for (let number = 1; number <= media.episodeCount; number++) store.ensureEpisode(series, number);
        store.save();
      }
      // Schedule independently of episode-count completion and of Kitsu/IMDb.
      // Re-adding a record with empty links must also retry automatically.
      if (!existing || !series.episodes.length || series.episodes.some((episode) => !episode.sources.length)) {
        sourceQueue.enqueue(series.id, [media.title, media.altTitle].filter(Boolean));
        sourceIds.push(series.id);
      }
      if (!existing || incomplete) {
        try {
          const { kitsuId, episodes } = await metadata.fetchEpisodes({ anilistId: media.anilistId, title: media.altTitle || media.title,
            streamingEpisodes: media.streamingEpisodes, episodeCount: media.episodeCount });
          if (store.getSeries(series.id)) {
            store.updateSeries(series.id, { kitsuId }); store.mergeEpisodeMeta(series.id, episodes);
          }
        } catch (error) { console.warn(`Episode metadata failed for ${media.title}:`, error.message); }
      }
      if (!existing) await addRatings(series, media);
    }
    return { id: selectedId, franchiseId: grouped ? String(graph.items[0].anilistId) : null,
      franchiseCount: grouped ? records.length : 1, ambiguous: Boolean(graph.ambiguous),
      sourceDiscoveryPending: sourceIds.length > 0, lib: store.snapshot() };
  };
}

module.exports = { createSeriesAdder };
