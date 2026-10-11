'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {Store,validateLibraryData}=require('../src/store');
const O=require('../src/organization');
const {createOrganizationService}=require('../src/organization-service');
const {mergeLibrarySnapshots,compressLibraryForCloud,expandLibraryFromCloud}=require('../src/cloud');
const {CloudService}=require('../src/cloud');
const clone=value=>JSON.parse(JSON.stringify(value));
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anime-order-'));
  const store=new Store(path.join(dir,'library.json'));
  t.after(()=>{clearTimeout(store._timer);fs.rmSync(dir,{recursive:true,force:true});});
  const a=store.addSeries({title:'Alpha'}),b=store.addSeries({title:'Beta'}),c=store.addSeries({title:'Gamma'});
  store.addSources(a.id,[{number:1,url:'https://manual.test/a.mp4',referer:'https://header.test/'}]);
  store.setProgress(a.id,a.episodes[0].id,{pos:71,duration:200,watched:false});
  store.ensureFranchise({id:'g',title:'Group'});store.setMembership(b.id,{franchiseId:'g',category:'season'});store.setMembership(c.id,{franchiseId:'g',category:'season'});
  const service=createOrganizationService({store}),context=service.context();
  const move=command=>service.move({...command,context});
  return {store,service,context,move,a,b,c,dir};
}
test('visual order keeps every content field, membership and linked franchise intact',t=>{
  const {store,move,a,b,c}=fixture(t),before=JSON.stringify(store.data.series);
  move({item:'franchise:g',from:'library',to:'library',before:'series:'+a.id});
  assert.deepEqual(O.ordered(store.data.organization,'library',['series:'+a.id,'franchise:g']),['franchise:g','series:'+a.id]);
  move({item:c.id,from:'members:g:season',to:'members:g:season',before:b.id});
  assert.deepEqual(O.ordered(store.data.organization,'members:g:season',[b.id,c.id]),[c.id,b.id]);
  assert.equal(JSON.stringify(store.data.series),before);
});
test('collections are visual placements, move and return keep membership',t=>{
  const {store,service,context,move,a}=fixture(t),before=JSON.stringify(store.data.series);
  const section=service.section({context,title:'Weekend'});
  move({item:'series:'+a.id,from:'library',to:'collection:'+section.id});
  assert.equal(O.placement(store.data.organization,'series:'+a.id),'collection:'+section.id);
  move({item:'series:'+a.id,from:'collection:'+section.id,to:'library'});
  assert.equal(O.placement(store.data.organization,'series:'+a.id),'library');
  assert.equal(JSON.stringify(store.data.series),before);
});
test('membership change requires explicit confirmation and detects concurrent changes',t=>{
  const {store,move,b}=fixture(t),before=store.snapshot();
  assert.throws(()=>move({item:b.id,from:'members:g:season',to:'members:g:movie'}),/conferm/i);
  assert.deepEqual(store.snapshot(),before);
  move({item:b.id,from:'members:g:season',to:'members:g:movie',confirmMembership:true});
  assert.equal(store.getSeries(b.id).franchiseMembership.category,'movie');
  assert.throws(()=>move({item:b.id,from:'members:g:season',to:'members:g:other',confirmMembership:true}),/cambiat/i);
  move({item:b.id,from:'members:g:movie',to:'independent',confirmMembership:true});
  assert.equal(store.getSeries(b.id).franchiseId,null);
});
test('order survives refresh, restart, import/export, cloud compression',t=>{
  const {store,move,a,dir}=fixture(t);
  move({item:'franchise:g',from:'library',to:'library',before:'series:'+a.id});
  const expected=store.snapshot().organization;
  store.refreshSeriesMetadata(a.id,{title:'Changed',description:'Original'});store.save(true,true);
  const reopened=new Store(store.file);t.after(()=>clearTimeout(reopened._timer));assert.deepEqual(reopened.data.organization,expected);
  const imported=new Store(path.join(dir,'import.json'));t.after(()=>clearTimeout(imported._timer));
  imported.importData(JSON.parse(JSON.stringify(store.snapshot())));assert.deepEqual(imported.data.organization,expected);
  assert.deepEqual(expandLibraryFromCloud(compressLibraryForCloud(store.snapshot())).organization,expected);
});
test('independent maps merge deterministically and late acknowledgements rebase whole decisions',t=>{
  const {store,move,a}=fixture(t);const base=store.snapshot();
  move({item:'franchise:g',from:'library',to:'library',before:'series:'+a.id});const local=store.snapshot();
  const remote=structuredClone(base);remote.organization=O.validate({version:1,lists:{'home:sections':{ids:['library','featured'],updatedAt:10}},sections:{},placements:{}});
  assert.deepEqual(mergeLibrarySnapshots(local,remote).organization,mergeLibrarySnapshots(remote,local).organization);
  remote.organization.lists.library={ids:['series:'+a.id,'franchise:g'],updatedAt:Date.now()+10000};
  const rebased=O.rebase(base,local,mergeLibrarySnapshots(local,remote));
  assert.deepEqual(rebased.organization.lists.library.ids,local.organization.lists.library.ids);
  assert.ok(rebased.organization.lists.library.updatedAt>remote.organization.lists.library.updatedAt);
});
test('invalid imports and deleted collections are safe and cancellation has no write',t=>{
  const {store,service,context,move,a}=fixture(t),revision=store.revision;
  // A drag preview/cancel has no service invocation and therefore no Store write.
  O.ordered(store.data.organization,'library',['series:'+a.id,'franchise:g']);assert.equal(store.revision,revision);
  assert.throws(()=>validateLibraryData({...store.snapshot(),organization:{version:99}}),/organizz/i);
  const section=service.section({context,title:'Short lived'});move({item:'series:'+a.id,from:'library',to:'collection:'+section.id});
  service.section({context,id:section.id,deleted:true});assert.equal(O.placement(store.data.organization,'series:'+a.id),'library');
  assert.throws(()=>move({item:'series:'+a.id,from:'library',to:'collection:'+section.id}),/sezione/i);
});
test('relative moves preserve hidden items and concurrent additions; stale account rejected',t=>{
  const {store,move,a,service,context,dir}=fixture(t),extra=store.addSeries({title:'Delta'});
  move({item:'franchise:g',from:'library',to:'library',after:'series:'+a.id});
  assert.ok(service.items('library').includes('series:'+extra.id));
  store.switchFile(path.join(dir,'other-account.json'));
  assert.throws(()=>service.move({context,item:'series:'+a.id,from:'library',to:'library'}),/sessione/i);
});
test('same timestamp conflicts converge and changes to unrelated lists are retained',t=>{
  const {store}=fixture(t),a=O.validate(store.data.organization),b=O.validate(store.data.organization);
  a.lists.library={ids:['a','b'],updatedAt:9};b.lists.library={ids:['b','a'],updatedAt:9};b.lists['home:sections']={ids:['recent','library'],updatedAt:9};
  assert.deepEqual(O.merge(a,b),O.merge(b,a));assert.deepEqual(O.merge(a,b).lists['home:sections'],b.lists['home:sections']);
});
test('persisted invalid organization fails closed without changing file bytes',t=>{
  const {store}=fixture(t);store.save(true,true);const raw=store.snapshot();raw.organization.lists.library={ids:['duplicate','duplicate'],updatedAt:2};
  const bytes=JSON.stringify(raw);fs.writeFileSync(store.file,bytes);assert.throws(()=>new Store(store.file),/libreria non modificata/i);assert.equal(fs.readFileSync(store.file,'utf8'),bytes);
});
test('first additive-format write makes exact backup; backup failure rolls back order',t=>{
  const {store,move,a}=fixture(t);store.save(true,true);const raw=store.snapshot();delete raw.organization;const bytes=JSON.stringify(raw);fs.writeFileSync(store.file,bytes);
  const loaded=new Store(store.file);t.after(()=>clearTimeout(loaded._timer));const svc=createOrganizationService({store:loaded});
  const backup=loaded.backup;loaded.backup=()=>{throw new Error('Synthetic backup failure');};const before=loaded.snapshot(),rev=loaded.revision;
  assert.throws(()=>svc.move({context:svc.context(),item:'franchise:g',from:'library',to:'library',before:'series:'+a.id}),/backup failure/);
  assert.deepEqual(loaded.snapshot(),before);assert.equal(loaded.revision,rev);assert.equal(fs.readFileSync(store.file,'utf8'),bytes);
  loaded.backup=backup;svc.move({context:svc.context(),item:'franchise:g',from:'library',to:'library',before:'series:'+a.id});
  const backups=fs.readdirSync(path.dirname(store.file)).filter(n=>n.includes('.pre-integrity-'));assert.equal(backups.length,1);assert.equal(fs.readFileSync(path.join(path.dirname(store.file),backups[0]),'utf8'),bytes);
});
test('atomic write failure leaves content, revision and previous order intact',t=>{
  const {store,move,a}=fixture(t);store.save(true,true);const before=store.snapshot(),rev=store.revision,rename=fs.renameSync;
  fs.renameSync=(from,to)=>{if(to===store.file)throw new Error('Synthetic disk failure');return rename(from,to);};
  try{assert.throws(()=>move({item:'franchise:g',from:'library',to:'library',before:'series:'+a.id}),/disk failure/);}finally{fs.renameSync=rename;}
  assert.deepEqual(store.snapshot(),before);assert.equal(store.revision,rev);
});
test('deleted works, stale anchors and incompatible sections reject without losing data',t=>{
  const {store,move,a}=fixture(t);const before=store.snapshot();
  assert.throws(()=>move({item:'franchise:g',from:'library',to:'home:recent'}),/compatibili/);
  assert.throws(()=>move({item:'franchise:g',from:'library',to:'library',before:'missing'}),/destinazione/);
  assert.deepEqual(store.snapshot(),before);store.deleteSeries(a.id);const tombstone=clone(store.data.deletedSeries);
  assert.throws(()=>move({item:'series:'+a.id,from:'library',to:'library'}),/cambiata/);assert.deepEqual(store.data.deletedSeries,tombstone);
});
test('membership validation keeps duplicate provider identities separate',t=>{
  const {store,move,a,b}=fixture(t);store.updateSeries(a.id,{anilistId:100});store.updateSeries(b.id,{anilistId:100});
  const standalone=store.ensureFranchise({id:'other',title:'Other'});store.setMembership(a.id,{franchiseId:standalone.id,category:'season'});
  // Cross-franchise drag is deliberately incompatible; explicit Manage content
  // remains the established route with duplicate validation.
  assert.throws(()=>move({item:a.id,from:'members:other:season',to:'members:g:season',confirmMembership:true}),/compatibile/);
  assert.throws(()=>store.setMembership(a.id,{franchiseId:'g'}),/stessa opera/);assert.equal(store.getSeries(a.id).franchiseId,'other');
});
for(const scenario of ['order','placement','membership','account','conflict'])test(`real CloudService held upload: ${scenario}`,async t=>{
  const {store,service,context,move,a,b,dir}=fixture(t),remote={value:{revision:2,updated_at:new Date().toISOString(),snapshot:{library:compressLibraryForCloud(store.snapshot())}}};
  remote.value.snapshot.library.organization.lists.library={ids:['series:'+a.id,'franchise:g'],updatedAt:Date.now()+5000};
  const gate=deferred(),entered=deferred(),writes=[];
  const client={from:table=>{assert.equal(table,'user_library_snapshots');let operation='read',value,filters={};
    const query={select:()=>query,eq:(key,v)=>{filters[key]=v;return query;},update:v=>{operation='update';value=clone(v);return query;},insert:v=>{operation='insert';value=clone(v);return query;},
      single:()=>query.maybeSingle(),maybeSingle:async()=>{if(operation==='read')return {data:clone(remote.value)};writes.push(value);entered.resolve();await gate.promise;
        if(scenario==='conflict')return {data:null};remote.value={...value};return {data:{revision:value.revision,updated_at:value.updated_at}};}};return query;}};
  const cloud=new CloudService({store,userDataPath:dir,safeStorage:{},env:{},client});cloud.user={id:'synthetic-user'};cloud.activeLibraryUserId='synthetic-user';cloud.state.libraryRevision=1;cloud._scheduleSync=()=>{};
  const pending=cloud._syncPrivateLibrary(cloud.user.id);await entered.promise;
  if(scenario==='placement'){const section=service.section({context,title:'Concurrent'});move({item:'series:'+a.id,from:'library',to:'collection:'+section.id});}
  else if(scenario==='membership')move({item:b.id,from:'members:g:season',to:'members:g:movie',confirmMembership:true});
  else move({item:'franchise:g',from:'library',to:'library',before:'series:'+a.id});
  const local=store.snapshot();
  if(scenario==='account'){store.switchFile(path.join(dir,'account-b.json'));cloud.user={id:'other-user'};cloud.activeLibraryUserId='other-user';cloud.accountEpoch++;}
  gate.resolve();await pending;assert.equal(writes.length,1);
  if(scenario==='account'){assert.equal(store.data.series.length,0);assert.deepEqual(store.data.organization,O.empty());return;}
  assert.equal(store.data.cloudDirty,true);
  if(scenario==='conflict')assert.deepEqual(store.snapshot().organization,local.organization);
  else if(scenario==='order'){assert.deepEqual(store.data.organization.lists.library.ids,local.organization.lists.library.ids);assert.ok(store.data.organization.lists.library.updatedAt>remote.value.snapshot.library.organization.lists.library.updatedAt);}
  else if(scenario==='placement')assert.deepEqual(store.data.organization.placements,local.organization.placements);
  else assert.deepEqual(store.getSeries(b.id).franchiseMembership.category,'movie');
});
