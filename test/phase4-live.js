'use strict';
// Explicit opt-in public-provider probe. Never loads CloudService, app/userData or credentials.
const fs=require('fs'),path=require('path'),assert=require('assert');
const out=path.resolve(process.argv[2]||'../../outputs/phase4-live.json');
const dir=path.resolve('../../work/phase4-live-profile-'+Date.now());fs.mkdirSync(dir,{recursive:true});
const nativeFetch=global.fetch,deadline=AbortSignal.timeout(90000);let requests=0;
global.fetch=(url,options={})=>{requests++;return nativeFetch(url,{...options,signal:AbortSignal.any([deadline,AbortSignal.timeout(10000),...(options.signal?[options.signal]:[])])});};
const {Store}=require('../src/store'),metadata=require('../src/metadata');
const {createSeriesAdder}=require('../src/series-addition');
const {createSourceDiscoveryQueue,discoverSeriesSources}=require('../src/source-discovery');
const {createAdditionOperationService}=require('../src/addition-operations');
const {createWorkQueue}=require('../src/work-queue');
const {AnimeUnityClient}=require('../src/animeunity'),{AnimeWorldClient}=require('../src/animeworld');
const {createRatingsService}=require('../src/ratings-service');
(async()=>{
 console.log('Public-provider probe started; no account or cloud');
 const report={startedAt:new Date().toISOString(),scope:'public providers; disposable blank library; no cloud',events:[]};let store,ops;
 try{
  store=new Store(path.join(dir,'library.json'));
  const unity=new AnimeUnityClient({timeoutMs:8000}),world=new AnimeWorldClient({timeoutMs:8000});
  const queue=createSourceDiscoveryQueue({store,metadata,discover:(series,titles,options)=>discoverSeriesSources(series,titles,{store,animeUnity:unity,animeWorld:world,...options})});
  const ratings=createRatingsService({store});
  const add=createSeriesAdder({store,metadata,sourceQueue:queue,loadRatings:(id,options)=>ratings.load(id,options),workQueue:createWorkQueue({concurrency:2})});
  ops=createAdditionOperationService({store,addSeries:add,notify:event=>report.events.push({type:event.type,phase:event.task.phase,status:event.task.status,stages:event.task.stages,summary:event.task.summary})});
  console.log('Public AniList request');
  const title=await metadata.getAnime(21519,{priority:'interactive'});
  assert.ok(title.descriptionOriginal);report.work={anilistId:title.anilistId,title:title.title,format:title.format,originalCharacters:title.descriptionOriginal.length};
  const started=ops.start({anilistId:21519,title:title.title,onlySelected:true});
  console.log('Addition operation started');
  const core=await started.core;console.log('Core content saved');assert.ok(core.id);report.savedBeforeCompletion=ops.list()[0].status==='running';
  const finished=await ops.wait(started.taskId);report.result={status:finished.status,summary:finished.summary,stages:finished.stages};
  store.save(true);const reopened=new Store(store.file);clearTimeout(reopened._timer);
  const record=reopened.getSeries(core.id);assert.ok(record);assert.equal(record.descriptionOriginal,title.descriptionOriginal);
  report.persistence={pass:true,idStable:record.id===core.id,units:record.mediaParts?.length||record.episodes.length};
  // No stream URL, header or cookie is copied into evidence.
  report.sources={units:record.mediaParts?.length||0,count:(record.mediaParts||record.episodes).reduce((n,u)=>n+u.sources.length,0)};
  report.ok=true;
 }catch(error){report.ok=false;report.error={name:error.name,status:error.status||null,message:require('../src/source-state').redact(error.message)};process.exitCode=1;}
 finally{ops?.dispose();if(store){clearTimeout(store._timer);store.save(true);}report.requests=requests;report.finishedAt=new Date().toISOString();fs.writeFileSync(out,JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,work:report.work,result:report.result?.status,persistence:report.persistence,sources:report.sources,requests,error:report.error}));}
})().catch(error=>{console.error(error.name);process.exitCode=1;});
