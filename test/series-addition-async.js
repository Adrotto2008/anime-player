'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {Store}=require('../src/store');
const {createSeriesAdder}=require('../src/series-addition');
const {createAdditionOperationService}=require('../src/addition-operations');
const {createWorkQueue}=require('../src/work-queue');

function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anime-player-addition-'));const store=new Store(path.join(dir,'library.json'));t.after(()=>{clearTimeout(store._timer);fs.rmSync(dir,{recursive:true,force:true});});return store;}
function media(){return{anilistId:730001,title:'Async Demo',altTitle:'Async Demo',titleAliases:['Async Demo'],description:'Synopsis',descriptionOriginal:'Synopsis',episodeCount:2,format:'TV',streamingEpisodes:[],related:[],genres:[],episodes:[]};}
test('saved library response does not wait for optional metadata and ratings',async t=>{
  const store=fixture(t),record=media();let releaseEpisodes,releaseRatings;
  const episodesGate=new Promise(r=>releaseEpisodes=r),ratingsGate=new Promise(r=>releaseRatings=r);
  const metadata={getAnimeBatch:async ids=>ids.map(()=>record),fetchEpisodes:async()=>{await episodesGate;return{episodes:[]};}};
  const sourceQueue={enqueue:async()=>({episodesFound:0,episodesAdded:0}),cancel(){}};
  const add=createSeriesAdder({store,metadata,sourceQueue,loadRatings:async()=>{await ratingsGate;return{status:'completed'};},workQueue:createWorkQueue({concurrency:2})});
  const ops=createAdditionOperationService({store,addSeries:add});
  t.after(()=>ops.dispose());
  const task=ops.start({anilistId:record.anilistId,onlySelected:true});
  const result=await Promise.race([task.core,new Promise((_,reject)=>setTimeout(()=>reject(new Error('core response waited for background')),1000))]);
  assert.ok(result.id);assert.equal(store.data.series.length,1);
  assert.equal(ops.list()[0].status,'running');
  releaseEpisodes();releaseRatings();
  assert.equal((await ops.wait(task.taskId)).status,'completed');
});

test('cancellation aborts in-flight optional providers and prevents their late writes',async t=>{
  const store=fixture(t),record=media();let release,entered;
  const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  const metadata={getAnimeBatch:async ids=>ids.map(()=>record),fetchEpisodes:async()=>{entered();await gate;return{episodes:[{number:1,title:'late'}]};}};
  const add=createSeriesAdder({store,metadata,sourceQueue:{enqueue:async()=>({}),cancel(){}},workQueue:createWorkQueue({concurrency:1})});
  const ops=createAdditionOperationService({store,addSeries:add});t.after(()=>ops.dispose());
  const task=ops.start({anilistId:record.anilistId,onlySelected:true});await task.core;await started;
  ops.cancel(task.taskId);release();
  assert.equal((await ops.wait(task.taskId)).status,'cancelled');
  assert.equal(store.data.series[0].episodes.some(ep=>ep.title==='late'),false);
});
