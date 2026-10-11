'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),vm=require('vm');
const {Store}=require('../src/store');
const {PlayerManager}=require('../src/player');
const {CloudService,mergeLibrarySnapshots,compressLibraryForCloud,expandLibraryFromCloud}=require('../src/cloud');
const meta=require('../src/metadata');
const Parts=require('../src/content-parts');
const clone=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anime-player-integrity-'));
  const stores=[];
  const create=(name='library.json')=>{const store=new Store(path.join(dir,name));stores.push(store);return store;};
  t.after(()=>{for(const s of stores)clearTimeout(s._timer);fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,create,store:create()};
}
function film(store,format='MOVIE') {
  const s=store.addSeries({title:'Synthetic film',format,episodeCount:1,malId:123,anilistId:456});
  store.addContentSources(s.id,[{number:1,url:'https://manual.test/full.mp4',referer:'https://headers.test/',userAgent:'Fixture UA'}]);
  return {s,part:s.mediaParts[0]};
}
function ipc(store,player) {
  const handlers={},repo=path.join(__dirname,'..'),req=require('module').createRequire(path.join(repo,'main.js'));
  const electron={app:{requestSingleInstanceLock:()=>true,whenReady:()=>({then:()=>{}}),on:()=>{},quit:()=>{}},
    ipcMain:{handle:(ch,fn)=>handlers[ch]=(...args)=>fn(null,...args)}};
  const context={require:name=>name==='electron'?electron:req(name),__dirname:repo,module:{exports:{}},process,console,setTimeout,clearTimeout};
  vm.runInNewContext(fs.readFileSync(path.join(repo,'main.js'),'utf8')+'\nmodule.exports.fixture=(s,p,m)=>{store=s;player=p;mpvManager=m;register();};',context,{filename:'main.js'});
  context.module.exports.fixture(store,player,{validate:async()=>({ok:true,path:'fixture'}),find:async()=>({ok:true,path:'fixture'})});
  return handlers;
}
// A fluent fake models the same SELECT + conditional UPDATE contract as Supabase.
function cloudFixture(store,dir,remote) {
  const gates={read:null,write:null},entered=deferred();const writes=[];
  const client={from:table=>{
    assert.equal(table,'user_library_snapshots');
    let operation='read',value,filters={};
    const query={select:()=>query,eq:(k,v)=>{filters[k]=v;return query;},
      insert:v=>{operation='insert';value=clone(v);return query;},update:v=>{operation='update';value=clone(v);return query;},
      single:()=>query.maybeSingle(),maybeSingle:async()=>{
        if(operation==='read') {if(gates.read)await gates.read.promise;return {data:clone(remote.value)};}
        writes.push({operation,value,filters});entered.resolve();
        if(gates.write)await gates.write.promise;
        if(operation==='update' && filters.revision!==remote.value.revision)return {data:null};
        remote.value={...value,updated_at:value.updated_at};return {data:{revision:value.revision,updated_at:value.updated_at}};
      }};return query;
  }};
  const cloud=new CloudService({store,userDataPath:dir,safeStorage:{},env:{},client});
  cloud.user={id:'fixture-user'};cloud.activeLibraryUserId='fixture-user';cloud.state.libraryRevision=remote.value?.revision || 0;
  cloud._scheduleSync=()=>{};
  return {cloud,gates,entered,writes};
}
for(const format of ['MOVIE','OVA','ONA','SPECIAL']) for(const outcome of ['empty','valid','failed']) {
  test(`AP-04 ${format}: repeated playback, AniSkip ${outcome}, refresh and reopen create no TV units`,async t=>{
    const {store,create}=fixture(t),{s,part}=film(store,format);store.setSettings({mpvPath:'fixture'});
    let calls=0,played=0;const original=meta.fetchAniSkipTimes;
    meta.fetchAniSkipTimes=async()=>{calls++;if(outcome==='failed')throw Error('Fixture failure');return outcome==='empty'?[]:[{skipType:'op',start:0,end:60}];};
    t.after(()=>{meta.fetchAniSkipTimes=original;});
    const handlers=ipc(store,{play:async()=>{played++;}});
    const id=part.id,source=clone(part.sources[0]);
    for(let i=0;i<3;i++) {await handlers['player:play'](s.id,id);assert.equal(s.episodes.length,0);store.refreshSeriesMetadata(s.id,{},[{number:1,title:'TV metadata'}]);}
    assert.equal(played,3);assert.equal(calls,0,'parts must not request TV AniSkip by their display number');
    assert.deepEqual(s.mediaParts.map(p=>p.id),[id]);assert.deepEqual(part.sources[0],source);
    store.save(true);const reopened=create();assert.equal(reopened.getSeries(s.id).episodes.length,0);
    assert.deepEqual(reopened.getSeries(s.id).mediaParts.map(p=>p.id),[id]);
  });
}
for(const outcome of ['empty','valid','failed']) test(`AP-04 TV AniSkip ${outcome} updates only the saved unit`,async t=>{
  const {store}=fixture(t),s=store.addSeries({title:'Synthetic TV',format:'TV',malId:123,anilistId:456});
  store.addSources(s.id,[{number:1,url:'https://manual.test/1.mp4'}]);const ep=s.episodes[0];store.setSettings({mpvPath:'fixture'});
  const original=meta.fetchAniSkipTimes;meta.fetchAniSkipTimes=async()=>{if(outcome==='failed')throw Error('Fixture failure');return outcome==='empty'?[]:[{skipType:'op',start:0,end:60}];};
  t.after(()=>{meta.fetchAniSkipTimes=original;});await ipc(store,{play:async()=>{}})['player:play'](s.id,ep.id);
  assert.equal(s.episodes.length,1);assert.equal(s.episodes[0].id,ep.id);assert.equal(ep.skipTimes.length,outcome==='valid'?1:0);
});
test('AP-04 late AniSkip cannot resurrect a deleted episode',async t=>{
  const {store}=fixture(t),s=store.addSeries({title:'Late TV',format:'TV',malId:123,anilistId:456});
  store.addSources(s.id,[{number:1,url:'https://manual.test/1.mp4'}]);const ep=s.episodes[0];store.setSettings({mpvPath:'fixture'});
  const gate=deferred(),entered=deferred(),original=meta.fetchAniSkipTimes;
  meta.fetchAniSkipTimes=()=>{entered.resolve();return gate.promise;};t.after(()=>{meta.fetchAniSkipTimes=original;});
  const request=ipc(store,{play:async()=>{}})['episodes:skipTimes'](s.id,ep.id);await entered.promise;
  store.deleteEpisode(s.id,ep.id);gate.resolve([]);await request;
  assert.equal(s.episodes.length,0);store.refreshSeriesMetadata(s.id,{episodeCount:1},[{number:1}]);assert.equal(s.episodes.length,0);
});
test('AP-05 duplicate single keys survive merge/import without replacing IDs or protected data',t=>{
  const {store,create}=fixture(t),{s,part}=film(store);store.setProgress(s.id,part.id,{pos:42,duration:120});store.rateEpisode(s.id,part.id,8);
  store.setVideoPreference(s.id,'it');const other={...clone(part),id:'independent-cut',number:part.number,key:'single',title:'Different cut',sources:[{url:'https://manual.test/alternate.mp4',userAgent:'Other UA'}],progress:{pos:8,duration:90,watched:false,updatedAt:1}};
  s.mediaParts.push(other);const saved=store.snapshot(),merged=mergeLibrarySnapshots(saved,saved);
  assert.equal(merged.series[0].mediaParts.length,2);assert.ok(merged.series[0].mediaParts.some(p=>p.id===part.id));
  const imported=create('import.json');imported.importData(merged);imported.save(true);
  assert.deepEqual(imported.getEpisode(s.id,part.id).sources,part.sources);assert.equal(imported.getEpisode(s.id,part.id).progress.pos,42);
  assert.equal(imported.getEpisode(s.id,part.id).personalRating,8);assert.equal(imported.getSeries(s.id).videoPreference.mode,'it');
  assert.ok(imported.getEpisode(s.id,'independent-cut'));assert.deepEqual(mergeLibrarySnapshots(merged,merged),merged);
});
test('AP-05 independent works and same-number episodes are not conflated',t=>{
  const {store}=fixture(t),s=store.addSeries({title:'TV'});store.addSources(s.id,[{number:1,url:'https://manual.test/1.mp4'}]);
  const local=store.snapshot(),remote=clone(local),original=s.episodes[0].id;
  remote.series[0].episodes[0].id='different-episode';remote.series[0].episodes[0].sources=[{url:'https://manual.test/cut.mp4'}];
  remote.series.push({...clone(remote.series[0]),id:'different-work'});
  const merged=mergeLibrarySnapshots(local,remote);assert.equal(merged.series.length,2);
  assert.deepEqual(new Set(merged.series.find(w=>w.id===s.id).episodes.map(e=>e.id)),new Set([original,'different-episode']));
});
test('AP-05 renewal during cloud object replacement uses persistent IDs and preserves headers',async t=>{
  const {store,dir}=fixture(t),{s,part}=film(store);
  store.addContentSources(s.id,[{number:1,provider:'animeunity',providerEpisodeId:99,url:'https://provider.test/full.mp4?token=old',resolutionState:'resolved',referer:'https://custom.test/',userAgent:'Custom'}]);
  const source=part.sources.find(s=>s.provider),gate=deferred(),entered=deferred();let launch;
  const player=new PlayerManager({store,paths:{userData:dir,shaderDir:''},notify:()=>{},resolveAutomaticSource:()=>{entered.resolve();return gate.promise;}});player._launch=async c=>{launch=c;};
  const request=player.play(s.id,part.id);await entered.promise;store.applyCloudData(store.snapshot(),new Date().toISOString());
  gate.resolve({...source,url:'https://provider.test/full.mp4?token=new',resolutionState:'resolved'});await request;
  assert.ok(launch,'playback must launch after renewal');assert.match(launch.url,/token=new/);
  const current=store.getEpisode(s.id,part.id).sources.find(s=>s.provider);assert.ok(current.id);assert.equal(current.id,source.id);
  assert.equal(current.referer,'https://custom.test/');assert.equal(current.userAgent,'Custom');assert.equal(launch.source,current);
  const merged=mergeLibrarySnapshots(store.snapshot(),{...store.snapshot(),series:[{...store.snapshot().series[0],mediaParts:[{...clone(part),sources:[source]}]}]});
  assert.equal(merged.series[0].mediaParts[0].sources.filter(s=>s.id===current.id).length,1);
});
test('AP-05 removed source does not launch after renewal',async t=>{
  const {store,dir}=fixture(t),{s,part}=film(store);store.addContentSources(s.id,[{number:1,provider:'animeunity',providerEpisodeId:99,url:'https://provider.test/full.mp4?token=old',resolutionState:'resolved'}]);
  const gate=deferred(),entered=deferred();let launches=0;const source=part.sources.find(s=>s.provider);
  const player=new PlayerManager({store,paths:{userData:dir,shaderDir:''},notify:()=>{},resolveAutomaticSource:()=>{entered.resolve();return gate.promise;}});player._launch=async()=>{launches++;};
  const request=player.play(s.id,part.id);await entered.promise;store.setSources(s.id,part.id,[]);gate.resolve({...source,url:'https://provider.test/new.mp4',resolutionState:'resolved'});await request;
  assert.equal(launches,0);assert.equal(player.activeRequest,null);
});
for(const mutation of ['progress','delete-part','delete-series','headers-settings-rating']) test(`AP-06 ${mutation} during upload remains dirty and survives retry/reopen`,async t=>{
  const {store,dir,create}=fixture(t),{s,part}=film(store);store.setProgress(s.id,part.id,{pos:10});store.save(true);
  const remote={value:{revision:7,snapshot:{library:compressLibraryForCloud(store.snapshot())},updated_at:new Date().toISOString()}};
  const {cloud,gates,entered}=cloudFixture(store,dir,remote);gates.write=deferred();
  const request=cloud._syncPrivateLibrary('fixture-user');await entered.promise;
  if(mutation==='progress')store.setProgress(s.id,part.id,{pos:42});
  if(mutation==='delete-part')store.deleteEpisode(s.id,part.id);
  if(mutation==='delete-series')store.deleteSeries(s.id);
  if(mutation==='headers-settings-rating') {store.rateEpisode(s.id,part.id,9);store.setSettings({theme:'compact'});store.setSources(s.id,part.id,[part.sources[0].url,'https://manual.test/extra.mp4']);}
  const latest=store.snapshot();gates.write.resolve();await request;
  assert.equal(store.data.cloudDirty,true,'changes after the transmitted revision are still pending');
  assert.deepEqual(store.snapshot().series,latest.series);assert.deepEqual(store.data.deletedEpisodes,latest.deletedEpisodes);assert.deepEqual(store.data.deletedSeries,latest.deletedSeries);
  gates.write=null;await cloud._syncPrivateLibrary('fixture-user');assert.equal(store.data.cloudDirty,false);
  const reopened=create();assert.deepEqual(reopened.snapshot().series,store.snapshot().series);
  if(mutation==='progress')assert.equal(expandLibraryFromCloud(remote.value.snapshot.library).series[0].mediaParts[0].progress.pos,42);
  if(mutation==='delete-part')assert.equal(remote.value.snapshot.library.series[0].mediaParts.length,0);
  if(mutation==='delete-series')assert.equal(remote.value.snapshot.library.series.length,0);
});
test('AP-06 initial insert also leaves changes made during upload pending',async t=>{
  const {store,dir}=fixture(t),{s,part}=film(store),remote={value:null};
  const {cloud,gates,entered}=cloudFixture(store,dir,remote);gates.write=deferred();const request=cloud._syncPrivateLibrary('fixture-user');await entered.promise;
  store.setProgress(s.id,part.id,{pos:43});gates.write.resolve();await request;
  assert.equal(store.getEpisode(s.id,part.id).progress.pos,43);assert.equal(store.data.cloudDirty,true);
});
test('AP-06 read/remote conflict cannot discard a concurrent local edit or a remote addition',async t=>{
  const {store,dir}=fixture(t),{s,part}=film(store);store.markCloudSynced(new Date().toISOString());
  const other={...clone(s),id:'remote-work',title:'Remote addition'};
  const remote={value:{revision:8,snapshot:{library:{...compressLibraryForCloud(store.snapshot()),series:[...compressLibraryForCloud(store.snapshot()).series,other]}},updated_at:new Date().toISOString()}};
  const {cloud,gates,writes}=cloudFixture(store,dir,remote);cloud.state.libraryRevision=7;gates.read=deferred();
  const request=cloud._syncPrivateLibrary('fixture-user');store.setProgress(s.id,part.id,{pos:44});gates.read.resolve();await request;
  assert.equal(store.getEpisode(s.id,part.id).progress.pos,44);assert.ok(store.getSeries('remote-work'));assert.equal(writes.length,1);
});
for(const account of ['other-user','fixture-user']) test(`AP-06 account switch during request (${account}) rejects the stale response`,async t=>{
  const {store,dir}=fixture(t),{s,part}=film(store),remote={value:{revision:7,snapshot:{library:compressLibraryForCloud(store.snapshot())},updated_at:new Date().toISOString()}};
  const {cloud,gates,entered}=cloudFixture(store,dir,remote);gates.write=deferred();const request=cloud._syncPrivateLibrary('fixture-user');await entered.promise;
  cloud.user={id:'other-user'};await cloud._activateLibrary('other-user');
  if(account==='fixture-user') {cloud.user={id:'fixture-user'};await cloud._activateLibrary('fixture-user');}
  const before=store.snapshot(),state=clone(cloud.state);gates.write.resolve();await request;
  assert.deepEqual(store.snapshot(),before);assert.deepEqual(cloud.state,state);
});
test('AP-04 legacy conversion is idempotent by UUID, preserves independent cuts and backs up exact bytes',t=>{
  const {create,dir}=fixture(t);
  const legacy={id:'legacy-work',title:'Legacy',format:'MOVIE',episodes:[{id:'saved-episode',number:1,title:'Full',sources:[{url:'https://manual.test/full.mp4',referer:'https://headers.test/',userAgent:'Saved UA'}],progress:{pos:17,duration:90,watched:false,updatedAt:3},personalRating:7}],movieSources:[{url:'https://manual.test/old.mp4'}]};
  const raw=JSON.stringify({settings:{language:'it'},series:[legacy]});const file=path.join(dir,'legacy.json');fs.writeFileSync(file,raw);
  const store=create('legacy.json');assert.equal(fs.readFileSync(file,'utf8'),raw,'load alone does not persist a structural migration');
  const migrated=clone(store.getSeries(legacy.id));for(let i=0;i<3;i++)store.migrateFranchises();assert.deepEqual(store.getSeries(legacy.id),migrated);
  store.save(true,true);const backups=fs.readdirSync(dir).filter(f=>f.startsWith('legacy.json.pre-integrity-'));assert.equal(backups.length,1);
  assert.equal(fs.readFileSync(path.join(dir,backups[0]),'utf8'),raw);
  assert.equal(store.getEpisode(legacy.id,'saved-episode').personalRating,7);assert.equal(store.getEpisode(legacy.id,'saved-episode').progress.pos,17);
  store.save(true);assert.equal(fs.readdirSync(dir).filter(f=>f.startsWith('legacy.json.pre-integrity-')).length,1);
  const copy={...clone(migrated),episodes:[clone(legacy.episodes[0])]};Parts.migrateParts(copy);assert.equal(copy.mediaParts.filter(p=>p.id==='saved-episode').length,1);
  const standalone={id:'stable-legacy',title:'Old film',format:'MOVIE',episodes:[],movieSources:[{url:'https://manual.test/old.mp4'}]};
  const first=clone(standalone),second=clone(standalone);Parts.migrateParts(first);Parts.migrateParts(second);assert.equal(first.mediaParts[0].id,second.mediaParts[0].id);
});
test('AP-04 failed backup prevents a migration write; import creates a separate rollback copy',t=>{
  const {store,dir}=fixture(t);film(store);store.save(true,true);const original=fs.readFileSync(store.file,'utf8');
  const backup=store.backup;store.backup=()=>{throw Error('Synthetic backup failure');};store._pendingMigrationBackup=true;store._migrationBackups.clear();
  assert.throws(()=>store.save(true,true),/backup failure/);assert.equal(fs.readFileSync(store.file,'utf8'),original);
  store.backup=backup;store.importData(store.snapshot());
  const rollback=fs.readdirSync(dir).find(f=>f.includes('.pre-import-'));assert.equal(fs.readFileSync(path.join(dir,rollback),'utf8'),original);
});
test('AP-05 cloud roundtrip preserves opaque manual links, headers, classification and source IDs',t=>{
  const {store,create}=fixture(t),s=store.addSeries({title:'Manual TV'});
  store.addSources(s.id,[{number:1,url:'https://manual.test/opaque',referer:'https://custom.test/',userAgent:'Custom'},
    {number:1,url:'https://manual.test/alternate',referer:'https://different.test/',userAgent:'Other'}]);
  const ep=s.episodes[0];store.setSourceLanguage(s.id,ep.id,ep.sources[0].url,'it');
  const restored=expandLibraryFromCloud(compressLibraryForCloud(store.snapshot()));const imported=create('roundtrip.json');imported.importData(restored);
  assert.deepEqual(imported.getEpisode(s.id,ep.id).sources,ep.sources);
});
test('AP-06 optimistic revision conflict retries with both the current edit and remote additions',async t=>{
  const {store,dir}=fixture(t),{s,part}=film(store),remote={value:{revision:7,snapshot:{library:compressLibraryForCloud(store.snapshot())},updated_at:new Date().toISOString()}};
  const {cloud,gates,entered}=cloudFixture(store,dir,remote);gates.write=deferred();const request=cloud._syncPrivateLibrary('fixture-user');await entered.promise;
  store.setProgress(s.id,part.id,{pos:51});remote.value.revision=8;
  remote.value.snapshot.library.series.push({...clone(remote.value.snapshot.library.series[0]),id:'other-remote-work',title:'Remote addition'});
  gates.write.resolve();await request;assert.equal(store.data.cloudDirty,true);assert.equal(store.getEpisode(s.id,part.id).progress.pos,51);
  gates.write=null;await cloud._syncPrivateLibrary('fixture-user');assert.ok(store.getSeries('other-remote-work'));assert.equal(store.getEpisode(s.id,part.id).progress.pos,51);
  assert.equal(store.data.cloudDirty,false);assert.equal(remote.value.revision,9);
});
test('AP-06 rebase protects same-clock edits, source removals and tombstones while retaining remote changes',async t=>{
  const {store,dir}=fixture(t),{s,part}=film(store);store.setProgress(s.id,part.id,{pos:10});
  const saved=store.snapshot(),remote={value:{revision:8,snapshot:{library:compressLibraryForCloud(saved)},updated_at:new Date().toISOString()}};
  remote.value.snapshot.library.series.push({...clone(remote.value.snapshot.library.series[0]),id:'added-remotely'});
  const {cloud,gates,entered}=cloudFixture(store,dir,remote);cloud.state.libraryRevision=7;gates.write=deferred();const request=cloud._syncPrivateLibrary('fixture-user');await entered.promise;
  const now=Date.now;Date.now=()=>saved.series[0].mediaParts[0].progress.updatedAt;t.after(()=>{Date.now=now;});
  store.setProgress(s.id,part.id,{pos:56});store.setSources(s.id,part.id,[]);gates.write.resolve();await request;
  assert.ok(store.getSeries('added-remotely'));assert.equal(store.getEpisode(s.id,part.id).progress.pos,56);assert.equal(store.getEpisode(s.id,part.id).sources.length,0);assert.equal(store.data.cloudDirty,true);
  Date.now=now;gates.write=null;await cloud._syncPrivateLibrary('fixture-user');assert.equal(store.data.cloudDirty,false);assert.equal(store.getEpisode(s.id,part.id).sources.length,0);
  const deleted=store.snapshot();store.deleteSeries(s.id);assert.equal(mergeLibrarySnapshots(store.snapshot(),{...deleted,series:deleted.series.map(w=>({...w,updatedAt:Date.now()+999999}))}).series.some(w=>w.id===s.id),false);
});
test('AP-06 account activation transfers the latest anonymous snapshot once and preserves later anonymous edits',async t=>{
  const {store,dir}=fixture(t),{s,part}=film(store);
  const cloud=new CloudService({store,userDataPath:dir,safeStorage:{},env:{},client:{}});
  cloud.state.history.push({id:'pending-history',seriesId:s.id,episodeId:part.id,synced:false});cloud.state.favorites.push(s.id);
  cloud._saveState();
  store.setProgress(s.id,part.id,{pos:67});cloud.user={id:'fixture-user'};await cloud._activateLibrary('fixture-user');assert.equal(store.getEpisode(s.id,part.id).progress.pos,67);
  assert.ok(cloud.state.history.some(h=>h.id==='pending-history'));assert.ok(cloud.state.favorites.includes(s.id));
  cloud.user=null;await cloud._activateLibrary(null);assert.equal(cloud.state.history.length,0);assert.equal(cloud.state.favorites.length,0);
  const anonymous=store.addSeries({title:'New anonymous work'});store.save(true);
  cloud.user={id:'other'};await cloud._activateLibrary('other');assert.equal(store.data.series.length,0);
  cloud.user=null;await cloud._activateLibrary(null);assert.ok(store.getSeries(anonymous.id),'a subsequent sign-in cannot blank the anonymous library');
});
for(const target of ['catalog','progress','history','favorites','settings'])test(`AP-06 ${target} response cannot write into a switched account`,async t=>{
  const {store,dir}=fixture(t),{s,part}=film(store);const gate=deferred(),entered=deferred();
  const client={from:()=>{const query={select:()=>query,eq:()=>query,in:()=>query,maybeSingle:()=>{entered.resolve();return gate.promise;},then:(resolve,reject)=>{entered.resolve();return gate.promise.then(resolve,reject);}};return query;}};
  const cloud=new CloudService({store,userDataPath:dir,safeStorage:{},env:{},client});cloud.user={id:'fixture-user'};cloud.activeLibraryUserId='fixture-user';
  const context=cloud._context('fixture-user'),catalog={anime:new Map([[s.id,'remote-anime']]),episodes:new Map([[`${s.id}:${part.id}`,'remote-episode']])};
  const operations={catalog:()=>cloud._resolveCatalog(context),progress:()=>cloud._syncProgress('fixture-user',catalog,context),history:()=>cloud._syncHistory('fixture-user',catalog,context),favorites:()=>cloud._syncFavorites('fixture-user',catalog,context),settings:()=>cloud._syncSettings('fixture-user',context)};
  const request=operations[target]();await entered.promise;cloud.user={id:'other'};await cloud._activateLibrary('other');const before=store.snapshot(),state=clone(cloud.state);
  gate.resolve({data:target==='settings'?{settings:{theme:'compact'},updated_at:new Date().toISOString()}:[{id:'remote-history',episode_id:'remote-episode',position_seconds:99,updated_at:new Date().toISOString()}]});await request;
  assert.deepEqual(store.snapshot(),before);assert.deepEqual(cloud.state,state);
});
test('AP-06 complete sync preserves edits during the first upload through subsequent progress/settings passes',async t=>{
  const {store,dir}=fixture(t),s=store.addSeries({title:'Full sync TV'});store.addSources(s.id,[{number:1,url:'https://manual.test/1.mp4'}]);
  const ep=s.episodes[0];store.setProgress(s.id,ep.id,{pos:10});
  const remote={value:{revision:7,snapshot:{library:compressLibraryForCloud(store.snapshot())},updated_at:new Date().toISOString()}};
  const {cloud,gates,entered}=cloudFixture(store,dir,remote),privateClient=cloud.client;gates.write=deferred();
  cloud.client={from:table=>{
    if(table==='user_library_snapshots')return privateClient.from(table);
    const response={data:table==='user_progress'?[{episode_id:'catalog-episode',position_seconds:10,completed:false,updated_at:new Date(Date.now()+1000).toISOString()}]:[]};
    const query={select:()=>query,eq:()=>query,upsert:()=>query,maybeSingle:async()=>({data:null}),then:(resolve,reject)=>Promise.resolve(response).then(resolve,reject)};return query;
  }};
  cloud.ensureProfile=async()=>{};cloud._resolveCatalog=async()=>({anime:new Map(),episodes:new Map([[`${s.id}:${ep.id}`,'catalog-episode']])});
  const request=cloud._syncForUser('fixture-user');await entered.promise;store.setProgress(s.id,ep.id,{pos:74});store.setSettings({theme:'compact'});
  gates.write.resolve();await request;assert.equal(store.getEpisode(s.id,ep.id).progress.pos,74);assert.equal(store.data.settings.theme,'compact');
  assert.equal(expandLibraryFromCloud(remote.value.snapshot.library).series[0].episodes[0].progress.pos,74);assert.equal(store.data.cloudDirty,false);
});
test('AP-06 late auth session cannot replace a newer account; player flush completes before Store switch',async t=>{
  const {store,dir}=fixture(t),{s,part}=film(store),gate=deferred(),entered=deferred();
  const cloud=new CloudService({store,userDataPath:dir,safeStorage:{},env:{},client:{auth:{getSession:()=>gate.promise}},
    beforeLibrarySwitch:async()=>{entered.resolve();store.setProgress(s.id,part.id,{pos:81});}});
  cloud.user={id:'fixture-user'};const request=cloud.getSession();cloud.user={id:'other'};gate.resolve({data:{session:{user:{id:'fixture-user'}}}});await request;assert.equal(cloud.user.id,'other');
  cloud.user={id:'fixture-user'};await cloud._activateLibrary('fixture-user');await entered.promise;assert.equal(store.getEpisode(s.id,part.id).progress.pos,81);
});
test('AP-05 automatic source IDs/custom headers survive cloud rediscovery while signed URLs stay local',t=>{
  const {store,create}=fixture(t),{s,part}=film(store);const automatic={number:1,provider:'animeunity',providerEpisodeId:88,url:'https://provider.test/full.mp4?token=secret-fixture',resolutionState:'resolved',referer:'https://custom.test/',userAgent:'Custom'};
  store.addContentSources(s.id,[automatic]);part.sources.find(source=>source.provider).id='original-saved-source-id';
  const compact=compressLibraryForCloud(store.snapshot());assert.equal(JSON.stringify(compact).includes('secret-fixture'),false);
  const imported=create('rediscovery.json');imported.importData(expandLibraryFromCloud(compact));
  imported.addContentSources(s.id,[{...automatic,url:'https://provider.test/full.mp4?token=new-fixture',referer:'https://resolver.test/',userAgent:undefined}]);
  const rediscovered=imported.getEpisode(s.id,part.id).sources.find(source=>source.provider);
  assert.equal(rediscovered.id,'original-saved-source-id');assert.equal(rediscovered.referer,'https://custom.test/');assert.equal(rediscovered.userAgent,'Custom');
});
test('AP-06 metadata timestamps do not erase personal ratings; explicit newer clears still synchronize',t=>{
  const {store}=fixture(t),{s,part}=film(store);store.rateEpisode(s.id,part.id,8);store.updateSeries(s.id,{personalRating:9});
  const local=store.snapshot(),remote=clone(local);remote.series[0].updatedAt=Date.now()+10000;remote.series[0].personalRating=null;delete remote.series[0].personalRatingUpdatedAt;
  remote.series[0].mediaParts[0].updatedAt=Date.now()+10000;remote.series[0].mediaParts[0].personalRating=null;delete remote.series[0].mediaParts[0].personalRatingUpdatedAt;
  const merged=mergeLibrarySnapshots(local,remote);assert.equal(merged.series[0].personalRating,9);assert.equal(merged.series[0].mediaParts[0].personalRating,8);
  const cleared=clone(local);cleared.series[0].mediaParts[0].personalRating=null;cleared.series[0].mediaParts[0].personalRatingUpdatedAt=local.series[0].mediaParts[0].personalRatingUpdatedAt+1;
  assert.equal(mergeLibrarySnapshots(local,cleared).series[0].mediaParts[0].personalRating,null);
});
test('AP-06 the transmitted payload is immutable when favorites change during upload',async t=>{
  const {store,dir}=fixture(t),{s}=film(store),remote={revision:7,snapshot:{library:compressLibraryForCloud(store.snapshot())}},entered=deferred(),gate=deferred();let payload;
  const client={from:()=>{let write=false;const query={select:()=>query,eq:()=>query,update:value=>{payload=value;write=true;return query;},maybeSingle:async()=>{
    if(!write)return {data:remote};entered.resolve();await gate.promise;return {data:{revision:8,updated_at:new Date().toISOString()}};
  }};return query;}};
  const cloud=new CloudService({store,userDataPath:dir,safeStorage:{},env:{},client});cloud.user={id:'fixture-user'};cloud.activeLibraryUserId='fixture-user';cloud.state.libraryRevision=7;
  cloud._scheduleSync=()=>{};cloud.sync=async()=>{};const request=cloud._syncPrivateLibrary('fixture-user');await entered.promise;
  await cloud.setFavorite(s.id,true);assert.deepEqual(payload.snapshot.sync.favorites,[]);gate.resolve();await request;
  assert.deepEqual(cloud.state.favorites,[s.id]);assert.equal(store.data.cloudDirty,true);
});
test('AP-04 a later one-shot metadata conversion backs up an already saved modern library',t=>{
  const {store,dir}=fixture(t),s=store.addSeries({title:'Unknown OVA',format:'OVA'});
  store.addSources(s.id,[{number:1,url:'https://manual.test/ova.mp4'}]);store.save(true,true);const raw=fs.readFileSync(store.file,'utf8'),id=s.episodes[0].id;
  store.refreshSeriesMetadata(s.id,{episodeCount:1});store.save(true,true);
  const backup=fs.readdirSync(dir).find(f=>f.includes('.pre-integrity-'));assert.ok(backup);assert.equal(fs.readFileSync(path.join(dir,backup),'utf8'),raw);
  assert.equal(store.getEpisode(s.id,id).kind,'part');
});
test('AP-05 optional catalog sync cannot conflate independent same-number units or duplicate works',async t=>{
  const {store,dir}=fixture(t),s=store.addSeries({title:'Independent TV cuts',anilistId:456});
  store.addSources(s.id,[{number:1,url:'https://manual.test/a.mp4'},{number:2,url:'https://manual.test/2.mp4'}]);
  s.episodes.push({...clone(s.episodes[0]),id:'different-cut',sources:[]});store.addSeries({title:'Independent TV copy',anilistId:456,episodes:[{...clone(s.episodes[0]),id:'different-work-unit'}]});
  const client={from:table=>{const response={data:table==='anime'?[{id:'catalog-anime',external_id:'456'}]:[1,2].map(n=>({id:`catalog-${n}`,anime_id:'catalog-anime',season_number:1,episode_number:n}))};
    const query={select:()=>query,in:()=>query,then:(resolve,reject)=>Promise.resolve(response).then(resolve,reject)};return query;}};
  const cloud=new CloudService({store,userDataPath:dir,safeStorage:{},env:{},client});cloud.user={id:'fixture-user'};cloud.activeLibraryUserId='fixture-user';
  const catalog=await cloud._resolveCatalog(cloud._context('fixture-user'));assert.equal(catalog.episodes.size,1);
  assert.equal(catalog.episodes.get(`${s.id}:${s.episodes.find(e=>e.number===2).id}`),'catalog-2');assert.equal(cloud.pendingCatalogMatches,3);
  assert.equal(store.data.series.length,2);assert.equal(s.episodes.length,3);
});
