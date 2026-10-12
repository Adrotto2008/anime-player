'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {Store}=require('../src/store'),Cloud=require('../src/cloud'),{ROOT_KEYS,validateRoot}=require('../src/library-schema');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anime-root-safety-')),file=path.join(dir,'library.json'),store=new Store(file);store.addSeries({title:'Synthetic current',format:'TV'});store.save(true,true);t.after(()=>{clearTimeout(store._timer);fs.rmSync(dir,{recursive:true,force:true});});return {dir,file,store};}
test('recognized optional root fields and real legacy subsets are accepted without accepting arbitrary extensions',()=>{
 const old={settings:{language:'it'},series:[],franchises:[],deletedFranchises:[],deletedSeries:[],deletedEpisodes:[],updatedAt:1,cloudDirty:true};assert.equal(validateRoot(old),old);
 for(const key of ['settingsUpdatedAt','organization','franchiseLinks'])assert.ok(ROOT_KEYS.includes(key));
 assert.throws(()=>validateRoot({...old,futureExtension:{data:'must remain'}}),/root non riconosciuti/);
});
test('unknown root rejects load and reopen and preserves exact original bytes, with no backup or rewrite',t=>{
 const {dir,file,store}=fixture(t),raw=JSON.stringify({...store.snapshot(),futureExtension:{data:'retain me'}},null,3)+'\n';fs.writeFileSync(file,raw);const names=fs.readdirSync(dir);
 for(let i=0;i<2;i++)assert.throws(()=>new Store(file),/root non riconosciuti/);assert.equal(fs.readFileSync(file,'utf8'),raw);assert.deepEqual(fs.readdirSync(dir),names);
});
test('incompatible import, cloud apply, compression, expansion, merge and export cannot discard or transfer unknown roots',t=>{
 const {file,store}=fixture(t),before=store.snapshot(),bytes=fs.readFileSync(file),bad={...before,futureExtension:{opaque:1}};
 for(const action of [()=>store.importData(bad),()=>store.applyCloudData(bad,new Date().toISOString()),()=>Cloud.compressLibraryForCloud(bad),()=>Cloud.expandLibraryFromCloud(bad),()=>Cloud.mergeLibrarySnapshots(before,bad),()=>store.writeLibraryFile(file,bad)])assert.throws(action,/root non riconosciuti/);
 assert.deepEqual(store.snapshot(),before);assert.deepEqual(fs.readFileSync(file),bytes);assert.equal(store.file,file);
 store.data.futureExtension={private:1};assert.throws(()=>store.snapshot(),/root non riconosciuti/);delete store.data.futureExtension;
});
test('a file edited externally after load is not overwritten by an immediate or delayed save',async t=>{
 const {file,store}=fixture(t),raw=JSON.stringify({...store.snapshot(),futureExtension:'external'});fs.writeFileSync(file,raw);
 assert.throws(()=>store.save(true,true),/root non riconosciuti/);store.save();await new Promise(r=>setTimeout(r,450));assert.equal(fs.readFileSync(file,'utf8'),raw);assert.throws(()=>new Store(file),/root non riconosciuti/);
});
test('failed file switch and target write retain the valid Store and rejected target bytes',t=>{
 const {dir,file,store}=fixture(t),before=store.snapshot(),target=path.join(dir,'target.json'),raw=JSON.stringify({...before,futureExtension:1});fs.writeFileSync(target,raw);
 assert.throws(()=>store.switchFile(target),/root non riconosciuti/);assert.equal(store.file,file);assert.deepEqual(store.data.series,before.series);assert.equal(fs.readFileSync(target,'utf8'),raw);
 assert.throws(()=>store.writeLibraryFile(target,before),/root non riconosciuti/);assert.equal(store.file,file);assert.equal(fs.readFileSync(target,'utf8'),raw);assert.deepEqual(new Store(file).data.series,before.series);
});
test('required pre-cloud/pre-import backup failure rejects transformation without changing valid state',t=>{
 const {file,store}=fixture(t),before=store.snapshot(),bytes=fs.readFileSync(file),next={...before,series:[]};store.backup=()=>{throw Error('Synthetic backup unavailable');};
 for(const action of [()=>store.applyCloudData(next,new Date().toISOString()),()=>store.importData(next)])assert.throws(action,/backup unavailable/);
 assert.deepEqual(store.snapshot(),before);assert.deepEqual(fs.readFileSync(file),bytes);
});
test('incompatible cloud envelope is rejected before local state or upload changes',async t=>{
 const {dir,file,store}=fixture(t),before=store.snapshot(),bytes=fs.readFileSync(file);let writes=0;
 const remote={snapshot:{library:{...before,futureExtension:1},history:[],sync:{}},revision:2};
 const client={from:()=>({select(){return this;},eq(){return this;},maybeSingle:async()=>({data:remote}),update(){writes++;return this;}})};
 const cloud=new Cloud.CloudService({store,userDataPath:dir,safeStorage:{},client,env:{}});cloud.user={id:'A'};cloud.activeLibraryUserId='A';
 await assert.rejects(cloud._syncPrivateLibrary('A'),/root non riconosciuti/);assert.equal(writes,0);assert.deepEqual(store.snapshot(),before);assert.deepEqual(fs.readFileSync(file),bytes);
 remote.snapshot={library:before,futureEnvelope:1};await assert.rejects(cloud._syncPrivateLibrary('A'),/Snapshot cloud incompatibile/);assert.equal(writes,0);
 for(const incompatible of [null,{}, {library:null}]){remote.snapshot=incompatible;await assert.rejects(cloud._syncPrivateLibrary('A'),/incompatibile|Struttura/);assert.deepEqual(store.snapshot(),before);assert.deepEqual(fs.readFileSync(file),bytes);assert.equal(writes,0);}
});
