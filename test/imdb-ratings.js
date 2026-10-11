'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {createImdbClient}=require('../src/imdb-client');
const {createRatingsService}=require('../src/ratings-service');
const Ratings=require('../src/episode-ratings');const {Store}=require('../src/store');
const reply=(json,status=200)=>({ok:status===200,status,json:async()=>json});
const suggestion=[{id:'tt11737520',l:'One Piece',y:2023,qid:'tvSeries',s:'Iñaki Godoy, Emily Rudd'},{id:'tt0388629',l:'One Piece',y:1999,qid:'tvSeries',s:'Mayumi Tanaka, Akemi Okamura'}];
const nodes=(count,offset=0,season=1)=>Array.from({length:count},(_,i)=>({node:{id:'tt'+(100000+offset+i),titleText:{text:'Title '+(offset+i+1)},series:{episodeNumber:{episodeNumber:offset+i+1,seasonNumber:season}},ratingsSummary:{aggregateRating:7.5}}}));
const page=(edges,total,next=false,cursor=null)=>({data:{title:{id:'tt0388629',titleText:{text:'One Piece'},ratingsSummary:{aggregateRating:9,voteCount:10},episodes:{seasons:[{number:0},{number:1}],episodes:{edges,total,pageInfo:{hasNextPage:next,endCursor:cursor}}}}}});
const clientFor=(answers,options={})=>{let calls=0;return {client:createImdbClient({fetchImpl:async()=>{const answer=answers[calls++];if(answer instanceof Error)throw answer;return answer;},...options}),calls:()=>calls};};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function library(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anime-imdb-'));const store=new Store(path.join(dir,'library.json'));t.after(()=>{clearTimeout(store._timer);fs.rmSync(dir,{recursive:true,force:true});});return store;}
test('IMDb chooses One Piece 1999 by exact year/type, independent of order',async()=>{
  const {client}=clientFor([reply({d:suggestion}),reply(page(nodes(1),1))]);const r=await client.load({title:'One Piece',year:1999,format:'TV'});
  assert.equal(r.status,'ready');assert.equal(r.chart.imdbId,'tt0388629');assert.equal(r.complete,true);
});
test('saved IMDb ID bypasses search and is never replaced',async()=>{
  let request;const client=createImdbClient({fetchImpl:async(url,options)=>{request={url,options};return reply(page(nodes(1),1));}});
  const r=await client.load({imdbId:'tt0388629',title:'Unrelated local title',year:2023});assert.equal(r.chart.imdbId,'tt0388629');assert.match(request.url,/graphql/);
});
test('empty suggestions end in empty, ambiguities include useful manual choices',async()=>{
  assert.equal((await clientFor([reply({d:[]})]).client.load({title:'Unknown'})).status,'empty');
  const r=await clientFor([reply({d:suggestion})]).client.load({title:'One Piece',format:'TV'});assert.equal(r.status,'ambiguous');assert.equal(r.candidates.length,2);assert.equal(r.candidates[0].year,2023);assert.ok(r.candidates[1].cast);
});
test('conflicting year or cour metadata cannot silently select first result',async()=>{
  const r=await clientFor([reply({d:suggestion})]).client.load({title:'One Piece',year:2001,format:'TV'});assert.equal(r.status,'ambiguous');
});
test('HTTP errors, JSON errors, GraphQL errors and bounded timeout end in error',async()=>{
  for(const answer of [reply({},503),new Error('network failed'),reply({errors:[{message:'failure'}]})])assert.equal((await clientFor([answer]).client.load({imdbId:'tt0388629'})).status,'error');
  const client=createImdbClient({fetchImpl:()=>new Promise(()=>{}),timeoutMs:20,overallTimeoutMs:50});const start=Date.now();assert.equal((await client.load({imdbId:'tt0388629'})).status,'error');assert.ok(Date.now()-start<500);
});
test('pagination retrieves 1200 unique episodes, reports progress and completion',async()=>{
  const answers=Array.from({length:5},(_,i)=>reply(page(nodes(i===4?200:250,i*250),1200,i<4,i<4?'cursor'+i:null)));
  const {client,calls}=clientFor(answers);const progress=[];const r=await client.load({imdbId:'tt0388629'},{onProgress:p=>progress.push(p)});
  assert.equal(r.complete,true);assert.equal(r.chart.fetchedEpisodes,1200);assert.equal(calls(),5);assert.equal(r.chart.seasons.find(s=>s.season===1).episodes.length,1200);assert.equal(progress.at(-1).fetched,1200);
});
test('partial page failure preserves fetched episodes and never reports complete',async()=>{
  const r=await clientFor([reply(page(nodes(2),4,true,'next')),reply({},500)]).client.load({imdbId:'tt0388629'});assert.equal(r.status,'ready');assert.equal(r.complete,false);assert.equal(r.chart.fetchedEpisodes,2);assert.equal(r.chart.totalEpisodes,4);assert.ok(r.issue);
});
test('cursor loops, missing cursors/pages, duplicate IDs and total mismatch are bounded/incomplete',async()=>{
  for(const second of [page(nodes(2,2),6,true,'next'),page([],6,true,'other'),page(nodes(2),4,false,null)]){
    const {client,calls}=clientFor([reply(page(nodes(2),6,true,'next')),reply(second)]);const r=await client.load({imdbId:'tt0388629'});assert.equal(r.complete,false);assert.ok(calls()<=2);assert.equal(new Set(r.chart.seasons.flatMap(s=>s.episodes.map(e=>e.id))).size,r.chart.fetchedEpisodes);
  }
  const r=await clientFor([reply(page(nodes(1),2,true,null))]).client.load({imdbId:'tt0388629'});assert.equal(r.complete,false);
});
test('season zero and unrated episodes remain present without invented votes',async()=>{
  const edges=nodes(1,0,0);edges[0].node.ratingsSummary={aggregateRating:null};const r=await clientFor([reply(page(edges,1))]).client.load({imdbId:'tt0388629'});assert.equal(r.chart.seasons[0].season,0);assert.equal(r.chart.seasons[0].episodes[0].rating,null);assert.equal(r.chart.ratedEpisodes,0);
});
test('indexed mapping retains unique-title, ambiguous-title, cour and Black Clover evidence',()=>{
  const chart={imdbId:'tt123',title:'Saga',seasons:[{season:1,episodes:[{number:1,id:'tt1',title:'Same',rating:8},{number:2,id:'tt2',title:'Same',rating:9}]}]};
  const s={id:'s',title:'Saga Part 2',episodeCount:1,episodes:[{id:'e',number:1,title:'Same'}]};assert.equal(Ratings.reference(s,chart,s.episodes[0]),null);
  s.episodes[0].title='Unique';chart.seasons[0].episodes[1].title='Unique';assert.equal(Ratings.reference(s,chart,s.episodes[0]).episodeId,'tt2');
  const bc={id:'b',anilistId:97940,title:'Black Clover',episodes:[{id:'e52',number:52}]};const bchart={imdbId:'tt7441658',seasons:[{season:2,episodes:[{number:1,id:'tt9150376',rating:7.8}]}]};assert.equal(Ratings.reference(bc,bchart,bc.episodes[0]).episodeId,'tt9150376');
  const prepared=Ratings.prepare([bc],bchart);assert.equal(prepared.target(2,1).episode.id,'e52');assert.equal(Ratings.prepare([bc,{...bc,id:'duplicate'}],bchart).target(2,1),null);
});
test('confirmed mapping and rating survive incomplete charts and object replacement',()=>{
  const identity={imdbId:'tt123',episodeId:'tt2',seriesId:'s',number:1,season:1,episodeNumber:2,method:'unique-episode-title'};
  const s={id:'s',title:'Saga Part 2',episodes:[{id:'e',number:1,title:'Retitled',rating:9,ratingSource:'IMDb',ratingIdentity:identity,progress:{pos:32},personalRating:6}]};
  Ratings.apply(s,{imdbId:'tt123',title:'Saga',complete:false,seasons:[]});assert.equal(s.episodes[0].rating,9);assert.deepEqual(s.episodes[0].ratingIdentity,identity);assert.equal(s.episodes[0].progress.pos,32);
  const chart={imdbId:'tt123',title:'Saga',seasons:[{season:1,episodes:[{number:2,id:'tt2',rating:8}]}]};Ratings.apply(s,chart);assert.equal(s.episodes[0].rating,8);assert.equal(Ratings.prepare([structuredClone(s)],structuredClone(chart)).target(1,2).episode.id,'e');
});
test('service deduplicates refresh and persists explicit candidate; errors retain last chart',async t=>{
  const store=library(t);const s=store.addSeries({title:'One Piece'});const gate=deferred();let calls=0;
  const service=createRatingsService({store,client:{load:async()=>{calls++;return gate.promise;}}});t.after(()=>service.dispose());
  const a=service.load(s.id),b=service.load(s.id);gate.resolve({status:'ambiguous',candidates:suggestion.map(x=>({id:x.id,title:x.l,year:x.y,type:x.qid,cast:x.s}))});await Promise.all([a,b]);assert.equal(calls,1);
  service.client.load=async options=>({status:'ready',complete:true,chart:{imdbId:options.imdbId,title:'One Piece',seasons:[{season:1,episodes:[{id:'tt1',number:1,rating:8}]}]}});
  await assert.rejects(()=>service.select(s.id,'tt999'),/candidate|candidato/i);await service.select(s.id,'tt0388629');assert.equal(s.imdbId,'tt0388629');assert.equal(s.imdbSelection.confirmed,true);
  const saved=structuredClone(s.imdbChart);service.client.load=async()=>({status:'error',issue:'http'});assert.equal((await service.load(s.id,{refresh:true})).status,'error');assert.deepEqual(s.imdbChart,saved);
  const {validateLibraryData}=require('../src/store');assert.equal(validateLibraryData(store.snapshot()).series[0].imdbSelection.id,'tt0388629');store.save(true,true,{cloud:true});const reopened=new Store(store.file);t.after(()=>clearTimeout(reopened._timer));assert.equal(reopened.getSeries(s.id).imdbSelection.confirmed,true);
});
test('service cannot write a stale response after deletion, ID edit or account switch',async t=>{
  for(const action of ['delete','id','account']){
    const store=library(t);const s=store.addSeries({title:'One Piece',imdbId:'tt0388629'});const gate=deferred();const service=createRatingsService({store,client:{load:()=>gate.promise}});t.after(()=>service.dispose());const pending=service.load(s.id);
    if(action==='delete')store.deleteSeries(s.id);else if(action==='id')store.updateSeries(s.id,{imdbId:'tt11737520'});else store.switchFile(path.join(path.dirname(store.file),'account.json'));
    gate.resolve({status:'ready',chart:{imdbId:'tt0388629',seasons:[]}});const r=await pending;assert.equal(r.cancelled,true);assert.equal(store.getSeries(s.id)?.imdbChart??null,null);
  }
});
test('service refresh applies only rating fields, preserving concurrent progress/identity',async t=>{
  const store=library(t);const s=store.addSeries({title:'One Piece',format:'TV',episodeCount:1,imdbId:'tt0388629'});const e=store.ensureEpisode(s,1);const gate=deferred();const service=createRatingsService({store,client:{load:()=>gate.promise}});t.after(()=>service.dispose());const p=service.load(s.id);
  store.setProgress(s.id,e.id,{pos:120,duration:1400});const before=store.versionToken();gate.resolve({status:'ready',complete:true,chart:{imdbId:'tt0388629',title:'One Piece',seasons:[{season:1,episodes:[{number:1,id:'tt1',rating:8}]}]}});await p;
  assert.equal(store.getEpisode(s.id,e.id).progress.pos,120);assert.equal(store.getEpisode(s.id,e.id).id,e.id);assert.ok(store.revision>before.revision);assert.equal(store.data.cloudDirty,true);
});
test('partial/empty refresh and concurrent chart replacement keep the last valid chart',async t=>{
  const store=library(t),saved={imdbId:'tt0388629',title:'One Piece',complete:true,seasons:[{season:1,episodes:[{id:'tt1',number:1,rating:8}]}]};
  const s=store.addSeries({title:'One Piece',imdbId:'tt0388629',imdbChart:saved});const gate=deferred();const service=createRatingsService({store,client:{load:()=>gate.promise}});t.after(()=>service.dispose());
  const p=service.load(s.id);s.imdbChart=structuredClone({...saved,overallRating:9});store.save();gate.resolve({status:'ready',chart:{...saved,overallRating:6},complete:true});assert.equal((await p).retained,true);assert.equal(s.imdbChart.overallRating,9);
  for(const result of [{status:'empty',chart:{imdbId:s.imdbId,seasons:[]}},{status:'ready',issue:'http',chart:{...saved,complete:false}}]){
    const before=structuredClone(s.imdbChart);service.client.load=async()=>result;assert.equal((await service.load(s.id,{refresh:true})).retained,true);assert.deepEqual(s.imdbChart,before);
  }
});
test('incomplete charts cannot prove a new unique title or contiguous season range',()=>{
  const s={id:'s',title:'Saga',episodeCount:1,episodes:[{id:'e',number:1,title:'Unique'}]},chart={imdbId:'tt1',title:'Saga',complete:false,seasons:[{season:1,episodes:[{id:'tt2',number:1,title:'Unique',rating:8}]}]};
  assert.equal(Ratings.reference(s,chart,s.episodes[0]),null);
});
test('missing numbers are retained separately; retrieval and plot completeness differ',async()=>{
  const edges=nodes(2);edges[1].node.series.episodeNumber=null;const r=await clientFor([reply(page(edges,2))]).client.load({imdbId:'tt0388629'});
  assert.equal(r.chart.retrievalComplete,true);assert.equal(r.complete,false);assert.equal(r.chart.unplacedEpisodes.length,1);assert.equal(r.chart.fetchedEpisodes,2);assert.equal(r.chart.mappedEpisodes,1);
});
test('page limit, hanging JSON and cancellation terminate without infinite requests',async()=>{
  const {client,calls}=clientFor([reply(page(nodes(1),3,true,'one')),reply(page(nodes(1,1),3,true,'two'))],{maxPages:2});const result=await client.load({imdbId:'tt0388629'});assert.equal(result.issue,'page-limit');assert.equal(calls(),2);
  const stalled=createImdbClient({fetchImpl:async()=>({ok:true,json:()=>new Promise(()=>{})}),timeoutMs:20});assert.equal((await stalled.load({imdbId:'tt0388629'})).issue,'timeout');
  const controller=new AbortController(),pending=createImdbClient({fetchImpl:()=>new Promise(()=>{})}).load({imdbId:'tt0388629'},{signal:controller.signal});controller.abort();assert.equal((await pending).issue,'cancelled');
});
test('TTL cache avoids repeated requests and invalidates when chart data change',async t=>{
  const store=library(t),s=store.addSeries({title:'No match'});let calls=0;const service=createRatingsService({store,client:{load:async()=>{calls++;return{status:'empty'};}}});t.after(()=>service.dispose());
  await service.load(s.id);await service.load(s.id);assert.equal(calls,1);await service.load(s.id,{refresh:true});assert.equal(calls,2);store.updateSeries(s.id,{imdbChart:{imdbId:'tt1',seasons:[]}});await service.load(s.id);assert.equal(calls,3);
});
test('confirmed selection/mapping survive legacy cloud replacement through metadata policy',async t=>{
  const {mergeLibrarySnapshots,compressLibraryForCloud,expandLibraryFromCloud}=require('../src/cloud');
  const store=library(t),choice={id:'tt0388629',title:'One Piece',year:1999,type:'tvSeries',confirmed:true,source:'user',updatedAt:100};
  const s=store.addSeries({title:'One Piece',imdbId:choice.id,imdbSelection:choice});const e=store.ensureEpisode(s,1);
  e.rating=8;e.ratingSource='IMDb';e.ratingIdentity={imdbId:choice.id,episodeId:'tt10',seriesId:s.id,unitId:e.id,number:1,season:1,episodeNumber:1,method:'unique-episode-title'};
  const service=createRatingsService({store,client:{load:async options=>{assert.equal(options.imdbSelection.id,choice.id);return{status:'empty'};}}});t.after(()=>service.dispose());
  assert.equal(expandLibraryFromCloud(compressLibraryForCloud(store.snapshot())).series[0].imdbSelection.id,choice.id);
  const remote=structuredClone(store.snapshot());delete remote.series[0].imdbSelection;remote.series[0].imdbId='tt11737520';remote.series[0].updatedAt=Date.now()+50;delete remote.series[0].episodes[0].ratingIdentity;remote.series[0].episodes[0].rating=null;remote.series[0].episodes[0].ratingSource=null;remote.series[0].episodes[0].updatedAt=Date.now()+50;remote.series[0].episodes[0].progress.pos=200;
  store.applyCloudData(mergeLibrarySnapshots(store.snapshot(),remote),new Date().toISOString());const revision=store.revision;service.syncScope();
  const current=store.getSeries(s.id);assert.equal(current.imdbSelection.id,choice.id);assert.equal(current.imdbId,choice.id);assert.equal(current.episodes[0].ratingIdentity.episodeId,'tt10');assert.equal(current.episodes[0].progress.pos,200);assert.equal(current.episodes[0].id,e.id);assert.ok(store.revision>revision);assert.equal(store.data.cloudDirty,true);
  await service.load(s.id);store.save(true,true,{cloud:true});const reopened=new Store(store.file);t.after(()=>clearTimeout(reopened._timer));assert.equal(reopened.getSeries(s.id).imdbSelection.id,choice.id);
});
test('newer explicit remote choice is respected; account scope does not leak confirmations',async t=>{
  const store=library(t),s=store.addSeries({id:'same-uuid',title:'One Piece',imdbId:'tt0388629',imdbSelection:{id:'tt0388629',confirmed:true,source:'user',updatedAt:100}});
  const service=createRatingsService({store,client:{load:async()=>({status:'empty'})}});t.after(()=>service.dispose());
  s.imdbId='tt11737520';s.imdbSelection={id:'tt11737520',confirmed:true,source:'user',updatedAt:200};service.syncScope();assert.equal(s.imdbSelection.id,'tt11737520');
  store.switchFile(path.join(path.dirname(store.file),'new-account.json'));store.addSeries({id:s.id,title:'Other account'});service.syncScope();assert.equal(store.getSeries(s.id).imdbSelection,undefined);
});
test('a complete fetch with unplaced records replaces a legacy truncated chart',async t=>{
  const store=library(t),old={imdbId:'tt0388629',title:'One Piece',seasons:[{season:1,episodes:[{id:'tt10',number:1,rating:7}]}]};
  const s=store.addSeries({title:'One Piece',imdbId:old.imdbId,imdbChart:old});
  const chart={...old,complete:false,retrievalComplete:true,fetchedEpisodes:3,seasons:[{season:1,episodes:[{id:'tt10',number:1,rating:8},{id:'tt11',number:2,rating:9}]}],unplacedEpisodes:[{id:'tt12',title:'Unknown number',rating:null}]};
  const service=createRatingsService({store,client:{load:async()=>({status:'ready',complete:false,issue:'invalid-number',chart})}});t.after(()=>service.dispose());await service.load(s.id);assert.equal(s.imdbChart.fetchedEpisodes,3);assert.equal(s.imdbChart.seasons[0].episodes.length,2);
});
test('fully retrieved unplaced titles invalidate uniqueness without fabricating positions',()=>{
  const series={id:'s',title:'Saga Part 2',episodeCount:1,episodes:[{id:'e',number:1,title:'Unique'}]},chart={imdbId:'tt1',title:'Saga',complete:false,retrievalComplete:true,seasons:[{season:1,episodes:[{id:'tt2',number:1,title:'Unique',rating:8}]}],unplacedEpisodes:[{id:'tt3',title:'Other'}]};
  assert.equal(Ratings.reference(series,chart,series.episodes[0]).episodeId,'tt2');chart.unplacedEpisodes[0].title='Unique';assert.equal(Ratings.reference(series,chart,series.episodes[0]),null);
});
test('malformed totals, pageInfo and duplicate coordinates are explicitly incomplete',async()=>{
  for(const mutate of [value=>value.data.title.episodes.episodes.total='2',value=>value.data.title.episodes.episodes.pageInfo={},value=>value.data.title.episodes.episodes.edges[1].node.series.episodeNumber.episodeNumber=1]){
    const value=page(nodes(2),2);mutate(value);const r=await clientFor([reply(value)]).client.load({imdbId:'tt0388629'});assert.equal(r.complete,false);assert.ok(r.issue);
  }
});
test('lib notification uses the reconciled snapshot, not its pre-reconciliation payload',async t=>{
  const store=library(t),s=store.addSeries({title:'One Piece',imdbId:'tt0388629',imdbSelection:{id:'tt0388629',confirmed:true,source:'user',updatedAt:100}});
  const service=createRatingsService({store,client:{load:async()=>({status:'empty'})}});t.after(()=>service.dispose());
  delete s.imdbSelection;s.imdbId='tt11737520';const stale=store.snapshot(),sent=[];
  const main=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8'),start=main.indexOf('const send ='),end=main.indexOf('function createWindow',start);
  const vm=require('vm');vm.runInNewContext(main.slice(start,end)+"send('lib:changed',payload)",{ratings:service,store,payload:stale,win:{isDestroyed:()=>false,webContents:{send:(ch,payload)=>sent.push({ch,payload})}}});
  assert.equal(store.getSeries(s.id).imdbId,'tt0388629');assert.equal(sent.find(e=>e.ch==='lib:changed').payload.series[0].imdbSelection?.id,'tt0388629');
});
