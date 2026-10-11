'use strict';
const assert=require('assert');const fs=require('fs');const os=require('os');const path=require('path');
const {Store}=require('../src/store');const Model=require('../src/franchise-model');
const {resolveFranchise}=require('../src/franchise');const {discoverRelatedWorks}=require('../src/franchise-discovery');
const {createSeriesAdder}=require('../src/series-addition');const {createFranchiseService}=require('../src/franchise-service');
const {createSourceDiscoveryQueue,discoverSeriesSources}=require('../src/source-discovery');
const {mergeLibrarySnapshots,compressLibraryForCloud,expandLibraryFromCloud}=require('../src/cloud');
const rel=(id,format,relation)=>({id,title:`Work ${id}`,format,relation,type:'ANIME'});
const media=(id,format='TV',episodeCount=12,related=[])=>({anilistId:id,title:`Work ${id}`,format,episodeCount,related,year:2024});
const graph=new Map([
  [1,media(1,'TV',12,[rel(2,'TV','SEQUEL'),rel(3,'MOVIE','SIDE_STORY'),rel(4,'OVA','SIDE_STORY'),rel(5,'SPECIAL','SIDE_STORY'),rel(6,'TV','SPIN_OFF'),rel(7,'MOVIE','SUMMARY'),rel(8,'TV','ALTERNATIVE'),rel(9,'ONA','PREQUEL')])],
  [2,media(2,'TV',12,[rel(1,'TV','PREQUEL')])],
  [3,media(3,'MOVIE',1,[rel(1,'TV','PARENT'),rel(10,'MOVIE','SEQUEL')])],
  [4,media(4,'OVA',3,[rel(1,'TV','PARENT')])], [5,media(5,'SPECIAL',1,[rel(1,'TV','PARENT')])],
  [6,media(6,'TV',12,[rel(11,'TV','SEQUEL'),rel(12,'MOVIE','SIDE_STORY')])],
  [7,media(7,'MOVIE',1,[rel(1,'TV','PARENT')])], [8,media(8,'TV',12)],
  [9,media(9,'ONA',1,[rel(1,'TV','SEQUEL')])],
  [10,media(10,'MOVIE',1,[rel(1,'TV','PARENT'),rel(3,'MOVIE','PREQUEL')])],
  [11,media(11)], [12,media(12,'MOVIE',1)],
]);
const fetchGraph=async ids=>ids.map(id=>graph.get(Number(id))).filter(Boolean);
const protectedRecord=record=>Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(record))).filter(([key])=>!key.startsWith('franchise') && key!=='updatedAt'));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
(async()=>{
  const calls=[];
  const core=await resolveFranchise(1,fetchGraph);
  const found=await discoverRelatedWorks([...core.items,...core.movies],async ids=>{calls.push(...ids.map(Number));return fetchGraph(ids);});
  assert.deepStrictEqual(new Set(found.automatic.map(s=>s.anilistId)),new Set([4,5,10]),'OVA, special and parent-confirmed movie sequel are recovered');
  const candidates=new Map(found.suggestions.map(s=>[s.anilistId,s]));
  assert.strictEqual(candidates.get(6).category,'spinoff');assert.strictEqual(candidates.get(7).category,'other');
  assert.strictEqual(candidates.get(8).category,'other');assert.strictEqual(candidates.get(9).category,'other');
  assert.ok(!calls.includes(11) && !calls.includes(12),'weak relations do not traverse another franchise');
  assert.strictEqual(new Set([...found.automatic,...found.suggestions].map(s=>s.anilistId)).size,found.automatic.length+found.suggestions.length);
  const mixed=await discoverRelatedWorks([media(20,'TV',12,[rel(7,'MOVIE','SIDE_STORY'),rel(7,'MOVIE','SUMMARY'),rel(6,'TV','SIDE_STORY'),rel(6,'TV','SPIN_OFF')])],fetchGraph);
  assert.strictEqual(mixed.suggestions.find(s=>s.anilistId===7).category,'other');
  assert.strictEqual(mixed.suggestions.find(s=>s.anilistId===6).category,'spinoff');
  assert.strictEqual((await discoverRelatedWorks([graph.get(1)],fetchGraph,{maxItems:1})).truncated,true);

  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anime-player-managed-franchise-')),stores=[];
  const create=name=>{const store=new Store(path.join(dir,name));stores.push(store);return store;};
  try {
    const store=create('managed.json'),queue={enqueue:()=>{},cancel:()=>{}};
    const metadata={getAnimeBatch:fetchGraph,getAnime:async id=>graph.get(Number(id)) || media(Number(id)),fetchEpisodes:async()=>({episodes:[]}),fetchImdbData:async()=>null};
    const add=createSeriesAdder({store,metadata,sourceQueue:queue});
    const first=await add({anilistId:1});const id=first.franchiseId;
    assert.ok(store.franchiseMembers(id).some(s=>s.anilistId===4));assert.ok(store.franchiseMembers(id).some(s=>s.anilistId===5));
    assert.ok(store.getFranchise(id).suggestions.some(s=>s.anilistId===6));
    assert.ok(!store.data.series.some(s=>[6,7,8,9,11,12].includes(s.anilistId)));
    const base=store.getSeries(first.id),second=store.data.series.find(s=>s.anilistId===2);
    store.addSources(base.id,[{number:1,url:'https://saved.test/001.mp4',referer:'https://headers.test/',userAgent:'Custom'}]);
    store.setProgress(base.id,base.episodes[0].id,{pos:70,duration:100,watched:false});store.setVideoPreference(base.id,'it');
    store.updateSeries(base.id,{preset:'aa-hq',personalRating:8,cover:'https://saved.test/cover.jpg'});
    const protectedBase=protectedRecord(base);
    store.updateFranchise(id,{title:'My franchise',cover:'https://saved.test/group.jpg',banner:'https://saved.test/banner.jpg'});
    store.setMembership(second.id,{franchiseId:id,category:'spinoff',order:50});
    await add({anilistId:1});store.refreshSeriesMetadata(base.id,{title:'Metadata title'});
    assert.strictEqual(store.getFranchise(id).title,'My franchise');assert.strictEqual(second.franchiseType,'spinoff');assert.strictEqual(second.franchiseOrder,50);
    // The user title on a work is outside the franchise customization contract.
    base.title=protectedBase.title;assert.deepStrictEqual(protectedRecord(base),protectedBase);
    store.reorderFranchise(id,store.franchiseMembers(id).map(s=>s.id).reverse());
    assert.strictEqual(base.franchiseMembership.manual,true);
    const other=store.ensureFranchise({title:'Destination'});
    store.setMembership(base.id,{franchiseId:other.id,category:'other',order:2});
    const autoCloud=JSON.parse(JSON.stringify(store.snapshot()));
    autoCloud.series.find(s=>s.id===base.id).franchiseMembership={franchiseId:id,category:'season',order:1,manual:false,updatedAt:Date.now()+100000};
    autoCloud.series.find(s=>s.id===base.id).updatedAt=Date.now()+100000;
    const combined=mergeLibrarySnapshots(store.snapshot(),autoCloud);
    assert.strictEqual(combined.series.find(s=>s.id===base.id).franchiseId,other.id,'manual membership beats later automatic metadata');
    store.setMembership(base.id,{franchiseId:null});await add({anilistId:1});
    assert.strictEqual(base.franchiseId,null,'re-adding cannot reverse manual detachment');
    assert.deepStrictEqual(protectedRecord(base),protectedBase);
    const explicit=await add({anilistId:1,franchiseId:other.id,category:'season'});
    assert.strictEqual(explicit.id,base.id);assert.strictEqual(store.data.series.filter(s=>s.anilistId===1).length,1);
    const manualFilm=await add({anilistId:7,franchiseId:other.id,category:'other'});
    assert.strictEqual(store.getSeries(manualFilm.id).franchiseType,'other');assert.strictEqual(store.getSeries(manualFilm.id).episodes.length,0);
    const duplicate=store.addSeries({...media(1),title:'Duplicate with different saved data'});
    store.addSources(duplicate.id,[{number:1,url:'https://other.test/different.mp4'}]);store.setMembership(duplicate.id,{franchiseId:id});
    const originalDuplicate=protectedRecord(duplicate),preview=store.previewFranchiseMerge(id,other.id);
    assert.strictEqual(preview.duplicates.length,1);assert.throws(()=>store.mergeFranchises(id,other.id),/duplicati/);
    store.getFranchise(id).excludedAniListIds=['99'];store.getFranchise(id).suggestions.push({...media(99),category:'other'});
    store.mergeFranchises(id,other.id,{duplicatePolicy:'detach'});
    assert.strictEqual(duplicate.franchiseId,null);assert.deepStrictEqual(protectedRecord(duplicate),originalDuplicate);
    assert.deepStrictEqual(protectedRecord(base),protectedBase);assert.strictEqual(store.getFranchise(id),undefined);
    assert.ok(!store.franchiseMembers(other.id).some((s,index,list)=>s.anilistId != null && list.slice(index+1).some(x=>x.anilistId===s.anilistId)));
    assert.ok(store.getFranchise(other.id).excludedAniListIds.includes('99'));
    assert.ok(!store.getFranchise(other.id).suggestions.some(s=>s.anilistId===99),'dismissed content stays dismissed through merge');
    store.save(true);const reopened=create('managed.json');assert.deepStrictEqual(reopened.snapshot().franchises,store.snapshot().franchises);
    const imported=create('import.json');imported.importData(store.snapshot());
    const roundTrip=expandLibraryFromCloud(compressLibraryForCloud(imported.snapshot()));
    assert.strictEqual(roundTrip.franchises.find(g=>g.id===other.id).title,'Destination');
    assert.strictEqual(roundTrip.series.find(s=>s.id===base.id).franchiseMembership.manual,true);
    const customLocal=store.snapshot(),customRemote=store.snapshot();
    customLocal.franchises.find(g=>g.id===other.id).custom.title={value:'Local manual title',updatedAt:100};
    customRemote.franchises.find(g=>g.id===other.id).custom.cover={value:'https://img.test/remote.jpg',updatedAt:200};
    customRemote.franchises.find(g=>g.id===other.id).suggestions.push({...media(99),category:'other'});
    const customMerged=mergeLibrarySnapshots(customLocal,customRemote).franchises.find(g=>g.id===other.id);
    assert.strictEqual(customMerged.title,'Local manual title');assert.strictEqual(customMerged.cover,'https://img.test/remote.jpg');
    assert.ok(customMerged.mergedFranchiseMetadata.some(g=>g.id===id),'merged source metadata is preserved through cloud');
    assert.ok(!customMerged.suggestions.some(s=>s.anilistId===99),'stale cloud suggestions cannot undo a manual dismissal');
    const conflictStore=create('internal-duplicates.json'),sourceGroup=conflictStore.ensureFranchise({title:'Source'}),targetGroup=conflictStore.ensureFranchise({title:'Target'});
    const repeated=[conflictStore.addSeries(media(50)),conflictStore.addSeries(media(50))];
    for(const record of repeated) {record.franchiseId=targetGroup.id;record.franchiseType='season';delete record.franchiseMembership;}
    conflictStore.migrateFranchises();const savedRepeated=repeated.map(protectedRecord);
    assert.strictEqual(conflictStore.previewFranchiseMerge(sourceGroup.id,targetGroup.id).duplicates[0].scope,'target');
    assert.throws(()=>conflictStore.mergeFranchises(sourceGroup.id,targetGroup.id),/duplicati/);
    conflictStore.mergeFranchises(sourceGroup.id,targetGroup.id,{duplicatePolicy:'detach'});
    assert.strictEqual(conflictStore.franchiseMembers(targetGroup.id).length,1);
    assert.deepStrictEqual(repeated.map(protectedRecord),savedRepeated);

    const additionGate=deferred(),additionStarted=deferred(),additionStore=create('addition-cancel.json');
    const additionGroup=additionStore.ensureFranchise({title:'Pending group'});
    const addPending=createSeriesAdder({store:additionStore,sourceQueue:queue,metadata:{...metadata,fetchImdbData:async()=>{additionStarted.resolve();await additionGate.promise;return null}}});
    const adding=addPending({anilistId:3,franchiseId:additionGroup.id});await additionStarted.promise;
    await createFranchiseService({store:additionStore,metadata,addSeries:addPending,sourceQueue:queue,player:{stopIfSeries:async()=>{}}}).delete(additionGroup.id);
    additionGate.resolve();assert.strictEqual((await adding).cancelled,true);assert.strictEqual(additionStore.data.series.length,0);

    // All pending jobs are serialized; deletion cannot import their late results.
    const scheduled=[],gate=deferred(),entered=deferred(),notifications=[];
    const asyncStore=create('async.json');const a=asyncStore.addSeries({...media(30),franchiseId:'async',franchiseType:'season'});
    const b=asyncStore.addSeries({...media(31,'MOVIE',1),franchiseId:'async',franchiseType:'movie'});
    const pendingQueue=createSourceDiscoveryQueue({store:asyncStore,metadata,schedule:job=>scheduled.push(job),
      discover:(record,titles)=>discoverSeriesSources(record,titles,{store:asyncStore,
        animeUnity:{findSources:async()=>{entered.resolve();await gate.promise;return[{number:1,url:'https://late.test/video.mp4'}]}},
        animeWorld:{findSources:async()=>[]}}),onComplete:(sid,r)=>notifications.push({sid,r})});
    const stops=[],service=createFranchiseService({store:asyncStore,metadata,sourceQueue:pendingQueue,addSeries:async()=>{},player:{stopIfSeries:async sid=>stops.push(sid)}});
    const beforeDelete=asyncStore.snapshot();const pending=pendingQueue.enqueue(a.id);pendingQueue.enqueue(b.id);
    while(scheduled.length)scheduled.shift()();await entered.promise;
    await service.delete('async');gate.resolve();await pending;await pendingQueue.waitForIdle();
    assert.deepStrictEqual(new Set(stops),new Set([a.id,b.id]));assert.strictEqual(asyncStore.data.series.length,0);
    assert.strictEqual(notifications.length,0);assert.strictEqual(asyncStore.data.deletedSeries.length,2);
    assert.strictEqual(mergeLibrarySnapshots(asyncStore.snapshot(),beforeDelete).series.length,0);
    assert.ok(!mergeLibrarySnapshots(asyncStore.snapshot(),beforeDelete).franchises.some(g=>g.id==='async'));

    const scanGate=deferred(),scanStarted=deferred();const scanStore=create('scan.json');
    scanStore.addSeries({...graph.get(1),franchiseId:'scan',franchiseType:'season'});
    const scanService=createFranchiseService({store:scanStore,sourceQueue:queue,player:{stopIfSeries:async()=>{}},
      addSeries:async()=>{throw Error('late addition must not run')},metadata:{getAnimeBatch:async ids=>{scanStarted.resolve();await scanGate.promise;return fetchGraph(ids)}}});
    const scanning=scanService.scan('scan');await scanStarted.promise;await scanService.delete('scan');scanGate.resolve();
    assert.strictEqual((await scanning).cancelled,true);assert.strictEqual(scanStore.data.series.length,0);
  } finally {for(const s of stores)clearTimeout(s._timer);fs.rmSync(dir,{recursive:true,force:true});}
  console.log('Managed franchises: complete safe graph, weak suggestions, manual edits/order/move/detach, explicit duplicate merge, migration/import/cloud and deletion during queued discovery/graph scan passed.');
})().catch(error=>{console.error(error);process.exitCode=1});
