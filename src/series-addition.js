'use strict';

const { resolveFranchise, applyFranchiseMetadata, planFranchiseAddition } = require('./franchise');
const {discoverRelatedWorks} = require('./franchise-discovery');
const Model = require('./franchise-model');

function createSeriesAdder({ store, metadata, sourceQueue }) {
  const addRatings = async (series, media) => {
    try {
      const imdb = await metadata.fetchImdbData({ title: series.title, altTitle: media?.altTitle });
      if (!imdb || !store.getSeries(series.id)) return;
      store.refreshSeriesMetadata(series.id, { imdbId: imdb.imdbId, imdbChart: imdb,
        ...(imdb.overallRating != null ? { score: imdb.overallRating, scoreSource: 'IMDb' } : {}) });
    } catch { /* Ratings never block addition or provider discovery. */ }
  };

  const inFlight=new Map();
  const add = async ({ anilistId, title, franchiseId, category, onlySelected=false, automatic=false }) => {
    const target=franchiseId ? store.getFranchise(franchiseId) : null;
    if (franchiseId && (!target || store._deletingFranchises?.has(franchiseId))) throw new Error('Franchise non disponibile.');
    const initial=store.data.series.find(s=>String(s.anilistId)===String(anilistId));
    if(!target && initial?.franchiseMembership?.manual && initial.franchiseId === null)onlySelected=true;
    if (!anilistId) {
      const series = store.addSeries({ title: String(title || '').trim() || 'Senza titolo' });
      if (target) store.setMembership(series.id,{franchiseId,category:category || 'other'});
      sourceQueue.enqueue(series.id, [series.title]);
      await addRatings(series);
      return { id: series.id, lib: store.snapshot(), sourceDiscoveryPending: true };
    }
    const language = store.data.settings.language;
    let graph;
    try {
      if (target || onlySelected) {
        const seed=(await metadata.getAnimeBatch([anilistId],{language})).find(m=>String(m.anilistId)===String(anilistId));
        if(!seed)throw new Error('Opera AniList non trovata.');
        graph={seed,items:[seed],movies:[],ambiguous:false};
      } else graph = await resolveFranchise(anilistId, (ids) => metadata.getAnimeBatch(ids, { language }));
    }
    catch (error) {
      console.warn('AniList franchise lookup failed; adding the selected title only:', error.message);
      // A search result already contains the selected record. A throttled
      // franchise traversal must not issue another request into the same limit.
      const seed = error.status === 429 && metadata.getCachedAnime
        ? await metadata.getCachedAnime(anilistId, { language })
        : await metadata.getAnime(anilistId, { language });
      if (!seed) throw error;
      graph = { seed, items: [seed], movies: [], ambiguous: true, deferred: error.status === 429 };
    }
    if ((initial && !store.getSeries(initial.id)) || target && !store.getFranchise(target.id)) return {cancelled:true,lib:store.snapshot()};
    let related={automatic:[],suggestions:[]};
    if (!target && !onlySelected && !graph.ambiguous) {
      try {related=await discoverRelatedWorks([...graph.items,...graph.movies],ids=>metadata.getAnimeBatch(ids,{language}));}
      catch(error){graph.relatedDeferred=true;console.warn('Related AniList content deferred:',error.message);}
    }
    if ((initial && !store.getSeries(initial.id)) || target && !store.getFranchise(target.id)) return {cancelled:true,lib:store.snapshot()};
    const allTitles = [...graph.items, ...graph.movies,...related.automatic];
    const grouped = Boolean(target) || !graph.ambiguous && (allTitles.length > 1 || related.suggestions.length > 0);
    let group=target;
    if(grouped && !group && initial?.franchiseMembership?.manual && initial.franchiseId === null) group=null;
    else if(grouped && !group) {
      let key=initial?.franchiseId || String(graph.items[0].anilistId);
      if((store.data.deletedFranchises||[]).some(g=>g.id===key))key=undefined;
      group=store.ensureFranchise({id:key,title:graph.items[0].title,cover:graph.items[0].cover,banner:graph.items[0].banner,rootAniListId:graph.items[0].anilistId});
    }
    const records = grouped ? applyFranchiseMetadata(allTitles, {
      franchiseId: group?.id || graph.items[0].anilistId, franchiseTitle: group?.title || graph.items[0].title, items: graph.items,
    }) : allTitles;
    const sourceIds = []; let selectedId;
    const library=target ? [...store.data.series].sort((a,b)=>Number(a.franchiseId===target.id)-Number(b.franchiseId===target.id)) : store.data.series;
    for (const { media, existing:planned } of planFranchiseAddition(records, library)) {
      if(group && (!store.getFranchise(group.id) || store._deletingFranchises?.has(group.id))) return {cancelled:true,lib:store.snapshot()};
      if(!target && group?.excludedAniListIds?.includes(String(media.anilistId)) && String(media.anilistId)!==String(anilistId))continue;
      // Other additions can finish while episode/rating metadata is awaited.
      // Recheck identity before creating each work from the earlier graph plan.
      const existing=planned && store.getSeries(planned.id) || planFranchiseAddition([media],store.data.series)[0]?.existing;
      const single = Model.singleWork(media);
      const incomplete = existing && media.episodeCount && existing.episodes.length < media.episodeCount;
      let series = existing;
      if (existing) {
        const patch = {};
        if (group && !series.franchiseMembership?.manual) for (const key of ['franchiseSeasonNumber']) {
          if (media[key] !== undefined) patch[key] = media[key];
        }
        // Restore aliases dropped by older versions without replacing user titles.
        if (!series.altTitle && media.altTitle) patch.altTitle = media.altTitle;
        if (media.titleAliases?.length) patch.titleAliases = [...new Set([...(series.titleAliases || []), ...media.titleAliases])];
        if (!series.cover && media.cover) patch.cover = media.cover;
        if (!series.banner && media.banner) patch.banner = media.banner;
        if (Object.keys(patch).length) store.updateSeries(series.id, patch);
      } else {
        const { streamingEpisodes, ...fields } = media;
        const safeFields={...fields};for(const key of ['franchiseId','franchiseTitle','franchiseOrder','franchiseType'])delete safeFields[key];
        series = store.addSeries({ ...safeFields, episodes: [], ...(single ? {mediaParts:[],...(media.format==='MOVIE'?{movieSources:[]}: {})} : {}) });
      }
      if(group)store.setMembership(series.id,{franchiseId:group.id,category:target ? category || Model.category(media) : media.category || media.franchiseType,
        order:media.franchiseOrder || undefined},{manual:Boolean(target) && !automatic});
      if (String(media.anilistId) === String(anilistId)) selectedId = series.id;

      if (!single && media.episodeCount > 0 && media.episodeCount <= 300) {
        for (let number = 1; number <= media.episodeCount; number++) store.ensureEpisode(series, number);
        store.save();
      }
      // Schedule independently of episode-count completion and of Kitsu/IMDb.
      // Re-adding a record with empty links must also retry automatically.
      const units=Model.units(series);
      if (!existing || !units.length || units.some((episode) => !episode.sources.length)) {
        sourceQueue.enqueue(series.id, [media.title, media.altTitle, ...(media.titleAliases || [])].filter(Boolean));
        sourceIds.push(series.id);
      }
      if (!single && (!existing || incomplete)) {
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
    if(group && store.getFranchise(group.id) && !target) {
      const memberIds=new Set(store.franchiseMembers(group.id).map(s=>String(s.anilistId)));
      group.suggestions=related.suggestions.filter(s=>!memberIds.has(String(s.anilistId)) && !(group.excludedAniListIds||[]).includes(String(s.anilistId)));
      group.discoveryTruncated=Boolean(related.truncated);group.relatedDeferred=Boolean(graph.relatedDeferred);store.save();
    }
    if(target)target.suggestions=(target.suggestions || []).filter(s=>String(s.anilistId)!==String(anilistId));
    if(selectedId && !store.getSeries(selectedId) || group && !store.getFranchise(group.id))return{cancelled:true,lib:store.snapshot()};
    if (!selectedId) throw new Error('Il risultato AniList selezionato non è stato salvato.');
    return { id: selectedId, franchiseId: group?.id || null,
      franchiseCount: grouped ? records.length : 1, ambiguous: Boolean(graph.ambiguous),
      franchiseDeferred: Boolean(graph.deferred),
      sourceDiscoveryPending: sourceIds.length > 0, lib: store.snapshot() };
  };
  return options=>{
    const key=options.anilistId ? `${options.anilistId}:${options.franchiseId || ''}` : null;
    if(key && inFlight.has(key))return inFlight.get(key);
    const promise=add(options).finally(()=>{if(key)inFlight.delete(key)});
    if(key)inFlight.set(key,promise);return promise;
  };
}

module.exports = { createSeriesAdder };
