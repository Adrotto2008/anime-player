'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const P=require('../src/watchparty-protocol');
test('adaptive correction converges below 500 ms without repeated seeks',()=>{
  let position=9.2,host=10,now=10000,seeks=0;
  for(let i=0;i<80;i++){const remote={content:{key:'unit'},position:host,serverTime:now,duration:100,paused:false,speed:1};const result=P.correction({remote,local:{key:'unit',position,duration:100},serverNow:now+120,now,lastSeek:0});if(result.kind==='seek'){position=result.target;seeks++;}else position+=result.speed*.5;host+=.5;now+=500;}
  assert.ok(Math.abs(host-position)<.5);assert.equal(seeks,0);
});
test('large drift seeks once; cooldown, pause, buffering and incompatible editions have explicit outcomes',()=>{
  const remote={content:{key:'unit'},position:30,serverTime:10000,duration:100,paused:false,speed:1};const local={key:'unit',position:10,duration:100};
  assert.equal(P.correction({remote,local,serverNow:10000,now:10000}).kind,'seek');
  assert.equal(P.correction({remote,local,serverNow:10000,now:10000,lastSeek:9000}).kind,'rate');
  assert.equal(P.correction({remote,local:{...local,localPaused:true},serverNow:10000,now:10000}).reason,'local-pause');
  assert.equal(P.correction({remote,local:{...local,buffering:true},serverNow:10000,now:10000}).reason,'buffering');
  assert.equal(P.correction({remote,local:{...local,duration:110},serverNow:10000,now:10000}).reason,'version');
  assert.equal(P.correction({remote:{...remote,paused:true},local,serverNow:10000,now:10000}).kind,'seek-pause');
  assert.equal(P.correction({remote,local:{...local,key:'other'},serverNow:10000,now:10000}).reason,'content');
});
test('only safe shareable source metadata crosses the protocol',()=>{
  for(const value of ['file:///C:/private/movie.mp4','https://u:p@example.com/file','https://example.com/file?token=private','https://127.0.0.1/file','http://example.com/file','https://example.com/file#secret'])assert.equal(P.publicUrl(value),null);
  const value=P.content({key:'catalog:1:1',title:'Content',anilistId:1,sourceUrl:'https://example.com/file?secret=x',privateToken:'secret',filePath:'C:/private'});
  assert.equal(value.sourceUrl,undefined);assert.equal(value.privateToken,undefined);assert.equal(value.filePath,undefined);assert.equal(P.publicUrl('https://example.com/file.mp4'),'https://example.com/file.mp4');
});
test('credentials stay within the main service and are invalidated across account changes',async()=>{
  const {CloudService}=require('../src/cloud');
  const f=Object.create(CloudService.prototype);f.user={id:'a'};f._accountEpoch=1;f.client={auth:{getSession:async()=>({data:{session:{access_token:'secret',user:{id:'a'}}}})}};
  assert.equal((await f.watchPartyCredentials()).accessToken,'secret');f._authChanging=true;assert.equal(await f.watchPartyCredentials(),null);f._authChanging=false;
  f.client.auth.getSession=async()=>{f._accountEpoch++;return {data:{session:{access_token:'stale',user:{id:'a'}}}};};await assert.rejects(()=>f.watchPartyCredentials(),/cambiata/);
  const {WatchPartyService}=require('../src/watchparty');const player={};const cloud={user:null,watchPartyCredentials:async()=>null};const service=new WatchPartyService({player,store:{},cloud});service.guest={token:'never-render',expires:Date.now()+10000};service.invites.set('server-secret',{id:'server-secret',uiId:'ui-id',from:'Friend',expires:Date.now()+10000});
  const json=JSON.stringify(service.snapshot());assert.ok(!json.includes('never-render'));assert.ok(!json.includes('server-secret'));assert.ok(json.includes('ui-id'));await service.stop();
});
test('sync preferences validate atomically and stopped service cannot reopen a pending inbox',async()=>{
  const {WatchPartyService}=require('../src/watchparty');let release,calls=0;
  const service=new WatchPartyService({player:{},store:{},cloud:{user:{id:'a'},watchPartyCredentials:async()=>({accessToken:'main-only'})},fetchImpl:async()=>{calls++;return new Promise(resolve=>{release=()=>resolve({ok:true,json:async()=>({ticket:'single-use',userId:'a'})});});},Socket:class{constructor(){throw Error('Stopped service opened socket');}}});
  const before=structuredClone(service.preferences);assert.throws(()=>service.configure({shareSource:true,sync:{deadband:.2,hardSeek:999}}),/non valida/);assert.deepEqual(service.preferences,before);
  const pending=service.openInbox();await new Promise(r=>setImmediate(r));await service.stop();release();await pending;assert.equal(calls,1);assert.equal(service.inboxSocket,null);
});
test('accepted invitations disappear, while expired invitations never start admission',async()=>{
  const {WatchPartyService}=require('../src/watchparty');const service=new WatchPartyService({player:{},store:{},cloud:{user:null}});let joined=0;
  service.join=async input=>{joined++;assert.equal(input.invite,'server-secret');};service.invites.set('server-secret',{id:'server-secret',uiId:'ui-id',code:'ABCDEFG2',from:'Friend',expires:Date.now()+600000});
  await service.acceptInvite('ui-id');assert.equal(joined,1);assert.equal(service.snapshot().invites.length,0);
  service.invites.set('expired',{id:'expired',uiId:'expired-ui',from:'Friend',expires:Date.now()-1});await assert.rejects(()=>service.acceptInvite('expired-ui'),/scaduto/);assert.equal(joined,1);await service.stop();
});
test('party discovery preserves series language and exhausted sources expose manual recovery',async()=>{
  const {PartyPlayback}=require('../src/watchparty-playback'),engine=require('../src/source-engine'),original=engine.AnimeUnityClient.prototype.findSources;let played;
  engine.AnimeUnityClient.prototype.findSources=async()=>['ja','it'].map(audio=>({url:'https://example.com/'+audio,language:{audio,subtitles:audio==='ja'?'it':null,origin:'provider',confidence:'declared'}}));
  const content={key:'catalog:1:episode:1',kind:'catalog',title:'Fixture',anilistId:1,number:1};
  const s={room:{playback:{content,position:0,serverTime:Date.now(),speed:1},permissions:{}},connection:'connected',store:{data:{series:[{anilistId:1,videoPreference:{mode:'it',updatedAt:1},episodes:[{number:1,sources:[]}]}],settings:{}}},player:{playPartySource:async(source,c,options)=>played={source,options}},telemetry:{},isHost:()=>false,publish:()=>{},osd:()=>{},send:()=>{}};
  try{const playback=new PartyPlayback(s);await playback.load(content);assert.equal(played.source.url,'https://example.com/it');assert.equal(played.options.effectiveMode,'it');await playback.event('error');assert.equal(playback.needsSource,true);s.player.cur={partyContent:content};await playback.event('loaded');assert.equal(playback.needsSource,false);}finally{engine.AnimeUnityClient.prototype.findSources=original;}
});
test('equal numeric AniList and MAL IDs cannot collide in content identity',async()=>{
  const {PartyPlayback}=require('../src/watchparty-playback'),playback=new PartyPlayback({preferences:{shareSource:false}});
  const a=await playback.describe({series:{title:'A',anilistId:1},ep:{number:1}}),b=await playback.describe({series:{title:'B',malId:1},ep:{number:1}});assert.notEqual(a.key,b.key);assert.match(a.key,/anilist:1/);assert.match(b.key,/mal:1/);
});
test('guest refresh precedes expiry and preserves identity; account transitions do not fall back to a guest',async()=>{
  const {WatchPartyService}=require('../src/watchparty');let header;
  const cloud={user:null,watchPartyCredentials:async()=>null},service=new WatchPartyService({player:{},store:{},cloud,fetchImpl:async(url,options)=>{header=options.headers.Authorization;return {ok:true,json:async()=>({token:'renewed',expires:Date.now()+3600000})};}});
  service.guest={token:'original-identity',expires:Date.now()+240000};assert.equal(await service.authorization('Guest'),'Guest renewed');assert.equal(header,'Guest original-identity');cloud.user={id:'changing-account'};await assert.rejects(()=>service.authorization(),/temporaneamente/);await service.stop();
});
test('host resync waits for native correction and cannot overwrite canonical time with its paused position',async()=>{
  const {PartyPlayback}=require('../src/watchparty-playback');let releasePause;const messages=[];
  const cur={pos:0,dur:100,paused:true,speed:1,partyContent:{key:'unit'},session:{loaded:true,request:async command=>{if(command[1]==='pause'){await new Promise(r=>{releasePause=r;});cur.paused=command[2];}else if(command[0]==='seek')cur.pos=command[1];}}};
  const s={player:{cur},room:{playback:{content:{key:'unit'},epoch:'e',position:20,duration:100,speed:1,paused:false,serverTime:Date.now()}},preferences:{sync:{...P.DEFAULT_SYNC}},connection:'connected',isHost:()=>true,telemetry:{},send:m=>messages.push(m),publish:()=>{},osd:()=>{}};
  const playback=new PartyPlayback(s);playback.localContent={key:'unit'};const pending=playback.apply(true);const resync=playback.resync();playback.snapshot(true);assert.equal(messages.filter(m=>m.type==='snapshot').length,0);
  releasePause();await pending;await resync;assert.equal(cur.paused,false);assert.ok(cur.pos>=20);playback.snapshot(true);assert.ok(messages.find(m=>m.type==='snapshot').position>=20);
});
