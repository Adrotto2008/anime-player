'use strict';

const { resolveFranchise, applyFranchiseMetadata, planFranchiseAddition } = require('./franchise');
const {discoverRelatedWorks} = require('./franchise-discovery');
const Model = require('./franchise-model');

function createSeriesAdder({ store, metadata, sourceQueue, loadRatings,workQueue }) {
  const addRatings = async (series, media,context={}) => {
    try {
      const current=store.getSeries(series.id),scope=store.scope;if(!current)return{cancelled:true};
      const valid=()=>store.scope===scope&&store.getSeries(series.id)&&(!context.isCurrent||context.isCurrent());
      if(loadRatings){const result=await loadRatings(series.id,{signal:context.signal,priority:context.priority});return valid()?result:{cancelled:true};}
      const imdbId=current.imdbId;
      const imdb = await metadata.fetchImdbData({ imdbId,imdbSelection:current.imdbSelection,title:current.title,altTitle:media?.altTitle || current.altTitle,year:current.year,format:current.format,signal:context.signal });
      if(!valid() || store.getSeries(series.id)?.imdbId!==imdbId)return{cancelled:true};
      if (!imdb) return{status:'empty'};
      store.refreshSeriesMetadata(series.id, { imdbId: imdb.imdbId, imdbChart: imdb,
        ...(imdb.overallRating != null ? { score: imdb.overallRating, scoreSource: 'IMDb' } : {}) });
      return{status:'completed'};
    } catch { return{status:'error',unavailable:true}; }
  };

  const inFlight=new Map();
  const add = async ({ anilistId, title, franchiseId, category, onlySelected=false, automatic=false, relationEvidence, relationOrder, relationRole,retry=false },{operation}={}) => {
    const scope=store.scope;
    const isCurrent=()=>store.scope===scope&&(!operation||operation.isCurrent());
    const report=(value)=>operation?.report(value);
    report({phase:'identification',status:'running'});
    const target=franchiseId ? store.getFranchise(franchiseId) : null;
    if (franchiseId && (!target || store._deletingFranchises?.has(franchiseId))) throw new Error('Franchise non disponibile.');
    const initial=store.data.series.find(s=>String(s.anilistId)===String(anilistId));
    const initialMembership=JSON.stringify(initial?.franchiseMembership || null);let membershipCommitted=false;
    const valid=()=>store.scope===scope && (!operation||operation.isCurrent()) && (!initial || store.getSeries(initial.id)) && (!target || store.getFranchise(target.id) && !store._deletingFranchises?.has(target.id))
      && (!target || automatic || !initial || membershipCommitted || JSON.stringify(store.getSeries(initial.id)?.franchiseMembership || null)===initialMembership);
    const cancelled=()=>({cancelled:true,lib:store.snapshot()});
    const background=[],workKeys=[],savedIds=[];let additionalJobs=0,sourceJobs=0;
    operation?.onCancel(()=>{workQueue?.cancel(workKeys);sourceQueue.cancel?.(savedIds);});
    const work=(key,run)=>{const id=`${scope}:${key}`;workKeys.push(id);return workQueue?workQueue.enqueue(id,run,{priority:'background',isCurrent:valid}):Promise.resolve().then(()=>valid()?run({signal:operation?.signal,isCurrent:valid}):{cancelled:true});};
    const track=(phase,key,promise)=>{if(operation)operation.track(phase,key,promise);else background.push(Promise.resolve(promise));return promise;};
    if(!target && initial?.franchiseMembership?.manual && initial.franchiseId === null)onlySelected=true;
    if (!anilistId) {
      const series = store.addSeries({ title: String(title || '').trim() || 'Senza titolo' });
      savedIds.push(series.id);
      if (target) store.setMembership(series.id,{franchiseId,category:category || 'other'});
      operation?.setSeries(series.id);report({phase:'identification',status:'completed',done:1,total:1});
      report({phase:'library',status:'completed',done:1,total:1});
      const source=sourceQueue.enqueue(series.id,[series.title],{priority:'background',isCurrent:valid});sourceJobs++;
      track('sources',series.id,source);
      const rating=work(`imdb:${series.id}`,context=>addRatings(series,null,context));additionalJobs++;
      track('additionalMetadata',series.id,rating);
      if(!operation)await Promise.all(background);
      return { id: series.id, lib: store.snapshot(), sourceDiscoveryPending: true };
    }
    const language = store.data.settings.language;
    let metadataDone=0;const fetchMetadata=async ids=>{
      report({phase:'metadata',status:'running',done:metadataDone,total:null});
      const records=await metadata.getAnimeBatch(ids,{language,priority:'interactive'});metadataDone+=records.length;
      report({phase:'metadata',status:'running',done:metadataDone,total:null});return records;
    };
    let graph;
    try {
      if (target || onlySelected) {
        const seed=(await fetchMetadata([anilistId])).find(m=>String(m.anilistId)===String(anilistId));
        if(!seed)throw new Error('Opera AniList non trovata.');
        graph={seed,items:[seed],movies:[],ambiguous:false};
      } else graph = await resolveFranchise(anilistId, fetchMetadata);
    }
    catch (error) {
      if(!valid())return cancelled();
      console.warn('AniList franchise lookup failed; adding the selected title only:', error.message);
      // A search result already contains the selected record. A throttled
      // franchise traversal must not issue another request into the same limit.
      const seed = error.status === 429 && metadata.getCachedAnime
        ? await metadata.getCachedAnime(anilistId, { language })
        : await metadata.getAnime(anilistId, { language,priority:'interactive' });
      if (!seed) throw error;
      graph = { seed, items: [seed], movies: [], ambiguous: true, deferred: error.status === 429 };
    }
    if (!valid()) return cancelled();
    report({phase:'identification',status:'completed',done:1,total:1});
    const knownWorks=graph.items.length+graph.movies.length;
    report({phase:'metadata',status:'completed',done:knownWorks,total:knownWorks});
    report({phase:'franchise',status:'running',done:0,total:null});
    let related={automatic:[],suggestions:[]};
    if (!target && !onlySelected && !graph.ambiguous) {
      try {related=await discoverRelatedWorks([...graph.items,...graph.movies],fetchMetadata);}
      catch(error){graph.relatedDeferred=true;console.warn('Related AniList content deferred:',error.message);}
    }
    if (!valid()) return cancelled();
    report({phase:'franchise',status:'completed',done:related.requests||0,total:related.requests||0});
    // A selected short work's PARENT edge establishes a side story, not a
    // spin-off. Only the parent's explicit reverse edge can prove SPIN_OFF.
    const parents=Model.animeRelations(graph.seed).filter(r=>r.relation==='PARENT').map(r=>String(r.id));
    const parentRecords=[...related.automatic,...related.suggestions].filter(m=>parents.includes(String(m.anilistId)) && Array.isArray(m.related));
    const selectedEvidence=parentRecords.length ? Model.evaluateRelated(graph.seed,parentRecords) : null;
    const allTitles = [...graph.items.map(m=>selectedEvidence && String(m.anilistId)===String(anilistId) ? selectedEvidence : m), ...graph.movies,...related.automatic];
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
    const sourceIds = []; let selectedId,libraryDone=0;
    const library=target ? [...store.data.series].sort((a,b)=>Number(a.franchiseId===target.id)-Number(b.franchiseId===target.id)) : store.data.series;
    const plan=planFranchiseAddition(records,library);
    report({phase:'library',status:'running',done:0,total:plan.length});
    for (const { media, existing:planned } of plan) {
      if(!valid())return cancelled();
      if(group && (!store.getFranchise(group.id) || store._deletingFranchises?.has(group.id))) return {cancelled:true,lib:store.snapshot()};
      if(!target && group?.excludedAniListIds?.includes(String(media.anilistId)) && String(media.anilistId)!==String(anilistId)){libraryDone++;report({phase:'library',status:'running',done:libraryDone,total:plan.length});continue;}
      // Other additions can finish while episode/rating metadata is awaited.
      // Recheck identity before creating each work from the earlier graph plan.
      const existing=planned && store.getSeries(planned.id) || planFranchiseAddition([media],store.data.series)[0]?.existing;
      if(target && !automatic && !initial && existing?.franchiseMembership?.manual)return cancelled();
      const single = Model.singleWork(media);
      const incomplete = existing && media.episodeCount && existing.episodes.length < media.episodeCount;
      let series = existing;
      if (existing) {
        const patch = {};
        for(const key of ['franchiseEvidence','franchiseRelations','related']) {
          const value=key==='franchiseEvidence' ? relationEvidence || media[key] : media[key];
          if(value!==undefined && JSON.stringify(value)!==JSON.stringify(series[key]))patch[key]=value;
        }
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
      if(relationEvidence && !existing)store.updateSeries(series.id,{franchiseEvidence:relationEvidence});
      membershipCommitted=true;
      if(group && (target && !automatic || !series.franchiseId || series.franchiseId===group.id))store.setMembership(series.id,{franchiseId:group.id,category:target ? category || Model.category(media) : media.category || media.franchiseType,
        order:relationOrder ?? media.franchiseOrder ?? undefined,...(target && !automatic && relationRole?{role:relationRole}: {})},{manual:Boolean(target) && !automatic});
      if (String(media.anilistId) === String(anilistId)) selectedId = series.id;
      if(!savedIds.includes(series.id))savedIds.push(series.id);

      if (!single && media.episodeCount > 0 && media.episodeCount <= 300) {
        for (let number = 1; number <= media.episodeCount; number++) store.ensureEpisode(series, number);
        store.save();
      }
      // Schedule independently of episode-count completion and of Kitsu/IMDb.
      // Re-adding a record with empty links must also retry automatically.
      const units=Model.units(series);
      if (!existing || !units.length || units.some((episode) => !episode.sources.length)) {
        const sourcePromise=sourceQueue.enqueue(series.id,[media.title,media.altTitle,...(media.titleAliases||[])].filter(Boolean),{
          priority:'background',isCurrent:valid});
        sourceJobs++;
        track('sources',series.id,sourcePromise);
        sourceIds.push(series.id);
      }
      if(!existing||retry){
        const needEpisodes=!single&&(!existing||incomplete||retry),needRatings=!existing||retry;
        const jobs=[];
        if(needEpisodes)jobs.push(work(`kitsu:${series.id}`,async task=>{
          let result;try{result=await metadata.fetchEpisodes({anilistId:media.anilistId,title:media.altTitle||media.title,streamingEpisodes:media.streamingEpisodes,episodeCount:media.episodeCount,signal:task.signal});}
          catch(error){if(!task.isCurrent()||!valid())return{cancelled:true};console.warn(`Episode metadata failed for ${media.title}:`,error.message);return{status:'error',unavailable:true};}
          if(!task.isCurrent()||!valid())return{cancelled:true};
          if(result.kitsuId)store.updateSeries(series.id,{kitsuId:result.kitsuId});
          if(result.episodes?.length)store.mergeEpisodeMeta(series.id,result.episodes);
          return result;
        }));
        if(needRatings)jobs.push(work(`imdb:${series.id}`,task=>addRatings(store.getSeries(series.id),media,{...task,priority:'background'})));
        // Queue each provider independently; wrapping this Promise.all in a
        // queue slot would deadlock when every worker waits for nested jobs.
        const extra=Promise.all(jobs).then(results=>({unavailable:results.some(result=>result?.unavailable||result?.status==='error'),status:results.some(result=>result?.status==='partial')?'partial':'completed'}));
        additionalJobs++;track('additionalMetadata',series.id,extra);
      }
      libraryDone++;report({phase:'library',status:'running',done:libraryDone,total:plan.length});
      operation?.setSeriesIds(savedIds);
    }
    operation?.setSeriesIds(savedIds);
    report({phase:'library',status:'completed',done:libraryDone,total:plan.length});
    if(group && store.getFranchise(group.id) && !target) {
      const anchors=[...graph.items,...graph.movies,...related.automatic];
      const finishDiscovery=async({isCurrent=valid}={})=>{
        if(!isCurrent()||!valid())return{cancelled:true};
        await require('./franchise-link-service').createFranchiseLinkService({store,metadata,sourceQueue}).discover(group.id,related.suggestions,anchors);
        if(!isCurrent()||!valid())return{cancelled:true};
        const currentGroup=store.getFranchise(group.id);if(!currentGroup)return{cancelled:true};
        const memberIds=new Set(store.franchiseMembers(group.id).map(s=>String(s.anilistId)));
        currentGroup.suggestions=related.suggestions.filter(s=>!Model.evaluateFranchiseRelation(s,anchors)&&!memberIds.has(String(s.anilistId))&&!(currentGroup.excludedAniListIds||[]).includes(String(s.anilistId)));
        currentGroup.discoveryTruncated=Boolean(related.truncated);currentGroup.relatedDeferred=Boolean(graph.relatedDeferred);store.save();return{status:'completed'};
      };
      const discovery=work(`related-links:${group.id}`,finishDiscovery);
      track('franchise',`suggestions:${group.id}`,discovery);
    }
    if(target)target.suggestions=(target.suggestions || []).filter(s=>String(s.anilistId)!==String(anilistId));
    if(selectedId && !store.getSeries(selectedId) || group && !store.getFranchise(group.id))return{cancelled:true,lib:store.snapshot()};
    if (!selectedId) throw new Error('Il risultato AniList selezionato non è stato salvato.');
    if(operation){if(!additionalJobs)report({phase:'additionalMetadata',status:'completed',done:0,total:0});if(!sourceJobs)report({phase:'sources',status:'completed',done:0,total:0});}
    if(!operation)await Promise.all(background);
    return { id: selectedId, franchiseId: group?.id || null,
      ids:savedIds,
      franchiseCount: grouped ? records.length : 1, ambiguous: Boolean(graph.ambiguous),
      franchiseDeferred: Boolean(graph.deferred),
      sourceDiscoveryPending: sourceIds.length > 0, lib: store.snapshot() };
  };
  return (options,context)=>{
    const key=options.anilistId ? `${store.scope}:${options.anilistId}:${options.franchiseId || ''}` : null;
    if(key && inFlight.has(key))return inFlight.get(key);
    const promise=add(options,context).finally(()=>{if(key)inFlight.delete(key)});
    if(key)inFlight.set(key,promise);return promise;
  };
}

module.exports = { createSeriesAdder };
