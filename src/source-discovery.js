'use strict';

const { matchOptions } = require('./source-match');
const { isValidSource } = require('./patterns');
const { providerTitles, redact } = require('./source-state');
const Model = require('./franchise-model');
const {partSources} = require('./content-parts');

async function discoverSeriesSources(series,titles=[series.title],{store,animeUnity,animeWorld,isCurrent=()=>true,onProgress=()=>{}}){
  const outcomes={},linkedNumbers=new Set(),foundNumbers=new Set();
  titles=providerTitles(series,titles).map(title=>String(title).trim()).filter(Boolean);
  const single=Model.singleWork(series),matching={...matchOptions(series),...(single?{episodeCount:undefined,contentMode:'parts'}:{})};
  for(const[name,client,options]of[
    ['animeunity',animeUnity,{titles,...matching}],['animeworld',animeWorld,{titles,...matching}],
  ]){
    if(!isCurrent()||!store.getSeries(series.id))return{cancelled:true,episodesAdded:linkedNumbers.size,episodesFound:foundNumbers.size};
    try{
      const found=await client.findSources(options);
      if(!store.getSeries(series.id)||!isCurrent())return{cancelled:true,episodesAdded:linkedNumbers.size,episodesFound:foundNumbers.size};
      const rejectedSources=(Array.isArray(found)?found:[]).flatMap(source=>{
        const reasons=[];
        if(!Number.isSafeInteger(source?.number)||source.number<0)reasons.push('invalid_episode_number');
        else if(!single&&series.episodeCount&&source.number>series.episodeCount)reasons.push('episode_out_of_range');
        if(typeof source?.url!=='string'||!/^https?:\/\//i.test(source.url)||!isValidSource(source.url))reasons.push('invalid_url');
        if(source?.resolutionState==='found')reasons.push('media_unresolved');
        return reasons.length?[{number:source?.number,reasons}]:[];
      });
      let sources=(Array.isArray(found)?found:[]).filter(source=>Number.isSafeInteger(source?.number)&&source.number>=0
        &&(single||!series.episodeCount||source.number<=series.episodeCount)&&typeof source.url==='string'
        &&/^https?:\/\//i.test(source.url)&&isValidSource(source.url)&&source.resolutionState!=='found')
        .map(source=>({...source,provider:name,...(name==='animeworld'?{referer:'https://www.animeworld.ac/'}:{})}));
      if(single)sources=partSources(sources);
      const identity=source=>single?source.contentPartKey:source.number,current=store.getSeries(series.id);
      const before=new Map((single?current.mediaParts||[]:current.episodes).map(unit=>[single?unit.key:unit.number,new Set(unit.sources.map(source=>source.url))]));
      const linkedEpisodes=new Set(sources.filter(source=>!before.get(identity(source))?.has(source.url)).map(identity));
      if(sources.length)single?store.addContentSources(series.id,sources):store.addSources(series.id,sources);
      sources.forEach(source=>foundNumbers.add(identity(source)));linkedEpisodes.forEach(number=>linkedNumbers.add(number));
      outcomes[name]={...client.lastDiscovery,rejectedSources,episodesAdded:linkedEpisodes.size,linksFound:(Array.isArray(found)?found:[]).length,
        linksResolved:sources.filter(source=>source.resolutionState==='resolved').length,
        status:sources.length?'found':rejectedSources.some(item=>item.reasons.includes('media_unresolved'))?'media_unresolved':client.lastDiscovery?.status||'title_not_found',
        playbackVerified:false,unavailable:client.lastDiscovery?.status==='provider_error'};
      onProgress({provider:name,status:outcomes[name].unavailable?'partial':'completed',episodesFound:foundNumbers.size,episodesAdded:linkedNumbers.size});
    }catch(error){
      if(!isCurrent())return{cancelled:true,episodesAdded:linkedNumbers.size,episodesFound:foundNumbers.size};
      console.warn(`${name} source discovery failed:`,redact(error.message));
      outcomes[name]={episodesAdded:0,episodesFound:0,status:'provider_error',error:redact(error.message),unavailable:true};
      onProgress({provider:name,status:'partial',episodesFound:foundNumbers.size,episodesAdded:linkedNumbers.size});
    }
  }
  const result={contentKind:single?'parts':'episodes',episodesAdded:linkedNumbers.size,episodesFound:foundNumbers.size,
    unavailable:Object.values(outcomes).every(value=>value.unavailable),providers:outcomes};
  if(store.getSeries(series.id)&&isCurrent())store.updateSeries(series.id,{sourceDiscovery:{...result,checkedAt:Date.now()}});
  return result;
}

// Provider clients share sessions/cookies: keep one active request, while
// allowing manual requests to pass queued automatic work. Per-series jobs coalesce.
function createSourceDiscoveryQueue({store,metadata,discover,onComplete=()=>{},schedule=setImmediate}){
  const pending=new Map(),waiting=[];let active=false,sequence=0;
  const rank=priority=>priority==='interactive'?2:priority==='normal'?1:0;
  const valid=job=>!job.cancelled&&Boolean(store.getSeries(job.id))&&[...job.guards].some(check=>{try{return check();}catch{return false;}});
  function drain(){
    if(active||!waiting.length)return;
    waiting.sort((a,b)=>b.priority-a.priority||a.sequence-b.sequence);const job=waiting.shift();
    if(!valid(job)){pending.delete(job.id);job.resolve({cancelled:true,episodesAdded:0,episodesFound:0});drain();return;}
    active=true;job.state='running';
    const run=(async()=>{
      let series=store.getSeries(job.id);
      if(!series||!valid(job))return{cancelled:true,episodesAdded:0,episodesFound:0};
      let aliases=[...new Set([series.title,series.altTitle,...(series.titleAliases||[]),...job.titles].filter(Boolean))];
      if(series.anilistId&&!series.titleAliases?.length){
        try{
          const media=await metadata.getAnime(series.anilistId,{priority:job.priority?'interactive':'background'});
          if(!store.getSeries(job.id)||!valid(job))return{cancelled:true};
          if(media.altTitle)store.updateSeries(job.id,{altTitle:media.altTitle});
          if(media.titleAliases?.length)store.updateSeries(job.id,{titleAliases:media.titleAliases});
          aliases.push(media.title,media.altTitle,...(media.titleAliases||[]));
        }catch(error){if(!valid(job))return{cancelled:true};console.warn('Titolo alternativo AniList non disponibile:',error.message);}
      }
      series=store.getSeries(job.id);if(!series||!valid(job))return{cancelled:true};
      try{return await discover(series,[...new Set(aliases.filter(Boolean))],{isCurrent:()=>valid(job),onProgress:progress=>{if(valid(job))job.onProgress?.(progress);}});}
      catch(error){if(!valid(job))return{cancelled:true};console.warn('Source discovery failed:',redact(error.message));return{episodesAdded:0,episodesFound:0,unavailable:true};}
    })();
    Promise.resolve(run).then(result=>{
      if(job.notify&&!result?.cancelled&&store.getSeries(job.id)&&valid(job))try{onComplete(job.id,result);}catch(error){console.warn('Discovery notification failed:',error.message);}
      job.resolve(result);
    },error=>{console.warn('Background discovery failed:',redact(error.message));job.resolve({episodesAdded:0,episodesFound:0,unavailable:true});})
      .finally(()=>{pending.delete(job.id);active=false;drain();});
  }
  function enqueue(id,titles=[],{notify=true,priority='background',isCurrent=()=>true,onProgress}={}){
    id=String(id);
    if(pending.has(id)){
      const job=pending.get(id);if(!notify)job.notify=false;job.priority=Math.max(job.priority,rank(priority));job.guards.add(isCurrent);
      job.titles=[...new Set([...job.titles,...titles])];if(onProgress)job.onProgress=onProgress;
      if(job.state==='pending'&&waiting.includes(job))drain();return job.promise;
    }
    let resolve;const promise=new Promise(r=>resolve=r);
    const job={id,titles:[...titles],notify,priority:rank(priority),sequence:sequence++,guards:new Set([isCurrent]),onProgress,state:'pending',resolve,promise,cancelled:false};
    pending.set(id,job);schedule(()=>{if(job.cancelled)return;waiting.push(job);drain();});return promise;
  }
  function cancel(ids){for(const rawId of ids||[]){const id=String(rawId),job=pending.get(id);if(!job||[...job.guards].some(check=>{try{return check();}catch{return false;}}))continue;job.cancelled=true;job.notify=false;
    if(job.state==='pending'){const index=waiting.indexOf(job);if(index>=0)waiting.splice(index,1);pending.delete(id);job.resolve({cancelled:true,episodesAdded:0,episodesFound:0});}}}
  return{enqueue,cancel,waitForIdle:()=>Promise.all([...pending.values()].map(job=>job.promise))};
}
module.exports={discoverSeriesSources,createSourceDiscoveryQueue};
