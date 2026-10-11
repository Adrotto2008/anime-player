'use strict';
const Ratings=require('./episode-ratings');
const {createImdbClient,validId}=require('./imdb-client');
const signature=series=>JSON.stringify([series.imdbId,series.imdbSelection,series.title,series.altTitle,series.year,series.format,series.anilistId]);
function createRatingsService({store,client=createImdbClient(),notify=()=>{}}){
  const active=new Map(),states=new Map(),confirmations=new Map(),mappings=new Map();let scope=store.scope,sequence=0;
  const confirmed=value=>value?.confirmed===true && validId(value.id);
  // This is a metadata policy at snapshot arrival. The Phase 2A cloud transport,
  // revision/CAS/rebase logic remains untouched. Restored fields are local edits
  // and use the Store's existing revision and pending-sync mechanism.
  const reconcile=()=>{
    let edited=false;const live=new Set();
    for(const series of store.data.series){
      let seriesEdited=false;
      live.add(series.id);const remembered=confirmations.get(series.id),incoming=series.imdbSelection;
      if(confirmed(incoming) && (!remembered || Number(incoming.updatedAt)>Number(remembered.updatedAt)))confirmations.set(series.id,structuredClone(incoming));
      const choice=confirmations.get(series.id);
      if(choice && (series.imdbId!==choice.id || JSON.stringify(series.imdbSelection)!==JSON.stringify(choice))){series.imdbId=choice.id;series.imdbSelection=structuredClone(choice);seriesEdited=true;}
      const imdbId=choice?.id || series.imdbId || series.imdbChart?.imdbId;
      const saved=mappings.get(series.id) || new Map();mappings.set(series.id,saved);const units=new Set();
      for(const episode of series.episodes || []){
        units.add(episode.id);const ref=episode.ratingIdentity,known=saved.get(episode.id);
        const valid=identity=>identity?.episodeId && identity.imdbId===imdbId && identity.seriesId===series.id && Number(identity.number)===Number(episode.number) && (!identity.unitId || identity.unitId===episode.id) && (identity.anilistId==null || String(identity.anilistId)===String(series.anilistId));
        if(valid(ref) && (!known || known.identity.imdbId!==imdbId || ref.episodeId===known.identity.episodeId))saved.set(episode.id,{identity:structuredClone(ref),rating:episode.rating,ratingSource:episode.ratingSource});
        else if(known && valid(known.identity) && (!valid(ref) || ref.episodeId!==known.identity.episodeId)){
          episode.ratingIdentity=structuredClone(known.identity);
          if(known.ratingSource==='IMDb'){episode.rating=known.rating;episode.ratingSource='IMDb';}episode.updatedAt=Math.max(Date.now(),(episode.updatedAt || 0)+1);seriesEdited=true;
        }
      }
      for(const id of saved.keys())if(!units.has(id))saved.delete(id);
      if(seriesEdited){series.updatedAt=Math.max(Date.now(),(series.updatedAt || 0)+1);edited=true;}
    }
    for(const id of confirmations.keys())if(!live.has(id))confirmations.delete(id);
    for(const id of mappings.keys())if(!live.has(id))mappings.delete(id);
    if(edited)store.save();
    return edited;
  };
  const changed=()=>{
    if(scope!==store.scope){scope=store.scope;for(const entry of active.values())entry.controller.abort();active.clear();states.clear();confirmations.clear();mappings.clear();notify({reset:true});}
    const edited=reconcile();
    for(const [id,entry] of active){const current=store.getSeries(id);if(!current || signature(current)!==entry.signature)entry.controller.abort();}
    return edited;
  };
  store.on('changed',changed);
  reconcile();
  const service={client,load,select,syncScope:changed,dispose(){store.off('changed',changed);for(const entry of active.values())entry.controller.abort();active.clear();states.clear();confirmations.clear();mappings.clear();}};
  function load(id,{refresh=false}={}){
    changed();
    if(active.has(id))return active.get(id).promise;
    const series=store.getSeries(id);if(!series)return Promise.resolve({status:'idle',cancelled:true});
    const cached=states.get(id);
    if(!refresh && cached?.signature===signature(series) && cached.chartKey===JSON.stringify(series.imdbChart) && Date.now()-cached.fetchedAt<300000){const {signature:_signature,fetchedAt:_time,chartKey:_chartKey,...result}=cached;return Promise.resolve(result);}
    const token=store.versionToken(),entry={controller:new AbortController(),signature:signature(series),chartKey:JSON.stringify(series.imdbChart),requestId:++sequence};
    const valid=()=>!entry.controller.signal.aborted && store.scope===token.scope && store.versionToken().file===token.file && store.getSeries(id) && signature(store.getSeries(id))===entry.signature;
    const emit=value=>{if(valid())notify({id,requestId:entry.requestId,...value});};
    // Register before entering asynchronous work, including injected clients.
    active.set(id,entry);
    entry.promise=(async()=>{
      let result;
      emit({status:'loading',phase:'loading',fetched:0,total:null});
      try {
        result=await service.client.load({...series},{signal:entry.controller.signal,onProgress:p=>emit({status:'loading',...p})});
        if(!valid())return {status:'idle',cancelled:true,requestId:entry.requestId};
        if(result.chart && ['ready','empty'].includes(result.status)){
          emit({status:'loading',phase:'statistics',fetched:result.chart.fetchedEpisodes,total:result.chart.totalEpisodes});
          await new Promise(resolve=>setImmediate(resolve));if(!valid())return {status:'idle',cancelled:true,requestId:entry.requestId};
          const current=store.getSeries(id),previous=current.imdbChart;
          // An interrupted refresh keeps the previous chart byte-for-byte. A
          // first partial fetch remains usable and is visibly incomplete.
          if((result.issue && !result.chart.retrievalComplete || result.status==='empty' || JSON.stringify(previous)!==entry.chartKey) && previous?.seasons?.some(s=>s.episodes?.length))result={...result,retained:true};
          else {
            Ratings.apply(current,result.chart);
            store.updateSeries(id,{imdbId:result.chart.imdbId,imdbChart:result.chart,
              ...(result.chart.overallRating!=null ? {score:result.chart.overallRating,scoreSource:'IMDb'} : {})});
            entry.signature=signature(store.getSeries(id));
          }
        }
      } catch {result={status:'error',issue:'request'};}
      if(!valid())return {status:'idle',cancelled:true,requestId:entry.requestId};
      result={...result,requestId:entry.requestId};states.set(id,{...result,signature:entry.signature,chartKey:JSON.stringify(store.getSeries(id).imdbChart),fetchedAt:Date.now()});notify({id,...result});return result;
    })().finally(()=>{if(active.get(id)===entry)active.delete(id);});
    return entry.promise;
  }
  async function select(id,imdbId){
    changed();
    const state=states.get(id),series=store.getSeries(id);
    const candidate=series && state?.signature===signature(series) && state.candidates?.find(c=>c.id===imdbId);
    if(!candidate || !store.getSeries(id))throw new Error('Candidato IMDb non disponibile: aggiorna la ricerca.');
    const pending=active.get(id);if(pending){pending.controller.abort();active.delete(id);}
    store.updateSeries(id,{imdbId,imdbSelection:{...candidate,confirmed:true,source:'user',updatedAt:Math.max(Date.now(),(Number(series.imdbSelection?.updatedAt) || 0)+1)}});
    return load(id,{refresh:true});
  }
  return service;
}
module.exports={createRatingsService};
