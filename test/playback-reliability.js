'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),vm=require('vm');
const {EventEmitter}=require('events');
const {Store}=require('../src/store');
const {PlayerManager}=require('../src/player');
const meta=require('../src/metadata');
const {redact}=require('../src/source-state');
const repo=path.join(__dirname,'..');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anime-player-playback-'));
  const store=new Store(path.join(dir,'library.json'));
  const series=store.addSeries({title:'Synthetic TV',format:'TV',malId:123});
  store.addSources(series.id,[{number:1,url:'https://fixture.test/1.mp4'},{number:2,url:'https://fixture.test/2.mp4'}]);
  store.setSettings({mpvPath:'fixture',autoplayNext:false});
  const players=[];
  t.after(async()=>{for(const player of players)await player.stop();clearTimeout(store._timer);fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,store,series,ep:series.episodes[0],players};
}
function mainFixture(store,player,manager) {
  const handlers={},events={},req=require('module').createRequire(path.join(repo,'main.js'));
  const electron={app:{requestSingleInstanceLock:()=>true,whenReady:()=>({then:()=>{}}),on:(ch,fn)=>events[ch]=fn,quit:()=>{}},
    ipcMain:{handle:(ch,fn)=>handlers[ch]=(...args)=>fn(null,...args)}};
  const context={require:n=>n==='electron'?electron:req(n),__dirname:repo,module:{exports:{}},process,console,setTimeout,clearTimeout};
  vm.runInNewContext(fs.readFileSync(path.join(repo,'main.js'),'utf8')+'\nmodule.exports.fixture=(s,p,m)=>{store=s;player=p;mpvManager=m;register();};',context);
  context.module.exports.fixture(store,player,manager || {validate:async()=>({ok:true,path:'fixture'}),find:async()=>({ok:true,path:'fixture'})});
  return {handlers,events,electron};
}
function managed(t,f,options={}) {
  const launches=[],notifications=[];
  const player=new PlayerManager({store:f.store,paths:{userData:f.dir,shaderDir:path.join(repo,'shaders')},notify:(...v)=>notifications.push(v),...options});
  player._launch=async c=>launches.push(c);
  return {player,launches,notifications};
}
for(const phase of ['mpv','AniSkip']) test(`AP-07 Stop during ${phase} prevents late launch and metadata writes`,async t=>{
  const f=fixture(t),{player,launches}=managed(t,f),gate=deferred(),entered=deferred();
  const original=meta.fetchAniSkipTimes;meta.fetchAniSkipTimes=async()=>{entered.resolve();await gate.promise;return [{skipType:'op',start:0,end:50}];};
  t.after(()=>{meta.fetchAniSkipTimes=original;});
  const manager=phase==='mpv'?{validate:async()=>{entered.resolve();await gate.promise;return{ok:true,path:'fixture'};}}:undefined;
  const {handlers}=mainFixture(f.store,player,manager);
  const pending=handlers['player:play'](f.series.id,f.ep.id);await entered.promise;await handlers['player:stop']();gate.resolve();await pending;
  assert.equal(launches.length,0);assert.deepEqual(f.ep.skipTimes,[]);
});
test('AP-07 two IPC Play requests with inverted AniSkip replies keep only the latest',async t=>{
  const f=fixture(t),{player,launches}=managed(t,f),gates=[deferred(),deferred()],entered=[deferred(),deferred()];let n=0;
  const original=meta.fetchAniSkipTimes;meta.fetchAniSkipTimes=async()=>{const i=n++;entered[i].resolve();await gates[i].promise;return [];};t.after(()=>{meta.fetchAniSkipTimes=original;});
  const {handlers}=mainFixture(f.store,player);
  const first=handlers['player:play'](f.series.id,f.ep.id);await entered[0].promise;
  const second=handlers['player:play'](f.series.id,f.series.episodes[1].id);await entered[1].promise;
  gates[1].resolve();await second;gates[0].resolve();await first;
  assert.deepEqual(launches.map(c=>c.ep.id),[f.series.episodes[1].id]);
});
for(const action of ['stop','account','delete']) test(`AP-07 ${action} during URL renewal cancels the original generation`,async t=>{
  const f=fixture(t),gate=deferred(),entered=deferred();
  f.ep.sources[0].provider='animeunity';f.ep.sources[0].resolutionState='found';
  const {player,launches}=managed(t,f,{resolveAutomaticSource:async()=>{entered.resolve();await gate.promise;return {url:'https://fixture.test/fresh.mp4',resolutionState:'resolved'};}});
  const {handlers}=mainFixture(f.store,player);const pending=player.play(f.series.id,f.ep.id);await entered.promise;
  if(action==='delete')await handlers['episodes:delete'](f.series.id,f.ep.id);
  else {await player.stop({reason:action==='account'?'account-change':'app-stop'});if(action==='account')f.store.switchFile(path.join(f.dir,'other.json'));}
  const invalidated=player.playRequestId;gate.resolve();await pending;
  assert.equal(launches.length,0);assert.ok(invalidated>1,'deletion must invalidate preparation, not just remove its unit');
});
test('AP-07 active request retains finite source fallback after a renewal error',async t=>{
  const f=fixture(t);f.ep.sources[0].provider='animeunity';f.ep.sources[0].resolutionState='found';
  f.store.addSources(f.series.id,[{number:1,url:'https://fixture.test/fallback.mp4'}]);
  const {player,launches}=managed(t,f,{resolveAutomaticSource:async()=>{throw Error('Synthetic failure');}});
  await player.play(f.series.id,f.ep.id);assert.equal(launches.length,1);assert.match(launches[0].url,/fallback/);assert.equal(player.playRequestId,1);
});
class FakeSession extends EventEmitter {
  start(){} send(){} seekAbsolute(){} seekRelative(){}
  quit(reason){this.emit('exit',{code:0,eof:false,reason,requestedReason:reason});}
}
function fakePlayback(t,f,{manualIntervals=false}={}) {
  const intervals=new Set();
  const req=require('module').createRequire(path.join(repo,'src/player.js')),context={require:n=>n==='./mpv'?{MpvSession:FakeSession,pipePath:()=> 'fixture'}:req(n),module:{exports:{}},console,setTimeout,clearTimeout,
    setInterval:manualIntervals?fn=>{const timer={fn};intervals.add(timer);return timer;}:setInterval,
    clearInterval:manualIntervals?timer=>intervals.delete(timer):clearInterval};
  vm.runInNewContext(fs.readFileSync(path.join(repo,'src/player.js'),'utf8'),context);
  const events=[],player=new context.module.exports.PlayerManager({store:f.store,paths:{userData:f.dir,shaderDir:path.join(repo,'shaders')},notify:(...v)=>events.push(v),progressIntervalMs:40});
  f.players.push(player);return {player,events,tick:()=>{for(const timer of intervals)timer.fn();}};
}
test('AP-09 continuous position events produce bounded periodic disk checkpoints',async t=>{
  const f=fixture(t),{player,tick}=fakePlayback(t,f,{manualIntervals:true});await player.play(f.series.id,f.ep.id);const session=player.cur.session;
  let saves=0;const original=f.store.setProgress.bind(f.store);f.store.setProgress=(...a)=>{saves++;return original(...a);};
  session.emit('duration',1000);
  for(let i=1;i<=15;i++){session.emit('time',i/10);if(i%3===0)tick();}
  assert.ok(f.ep.progress.pos>=1,'continuous playback must checkpoint before exit');
  const saved=JSON.parse(fs.readFileSync(f.store.file,'utf8'));assert.ok(saved.series[0].episodes[0].progress.pos>=1);
  assert.ok(saves>=2 && saves<=5,`unexpected checkpoint count ${saves}`);
});
test('AP-09 pause and seek persist the observed position without repeated unchanged saves',async t=>{
  const f=fixture(t),{player}=fakePlayback(t,f);await player.play(f.series.id,f.ep.id);const session=player.cur.session;
  session.emit('duration',1000);session.emit('time',12);session.emit('pause',true);assert.equal(f.ep.progress.pos,12);
  const revision=f.store.revision;session.emit('pause',true);assert.equal(f.store.revision,revision);
  session.emit('seek');session.emit('time',200);session.emit('seeked');await delay(300);assert.equal(f.ep.progress.pos,200);
});
test('AP-09 shutdown waits for final playback flush before Electron may quit',async t=>{
  const f=fixture(t),{player}=fakePlayback(t,f);await player.play(f.series.id,f.ep.id);player.cur.session.emit('time',42);
  const gate=deferred(),session=player.cur.session;session.quit=()=>gate.promise.then(()=>session.emit('exit',{code:0,eof:false,reason:'shutdown'}));
  const {events,electron}=mainFixture(f.store,player);let prevented=0,quits=0;electron.app.quit=()=>{quits++;};
  try {events['before-quit']({preventDefault:()=>{prevented++;}});assert.equal(prevented,1);assert.equal(quits,0);}
  finally {gate.resolve();}
  await delay(30);assert.equal(quits,1);
  const saved=JSON.parse(fs.readFileSync(f.store.file,'utf8'));assert.equal(saved.series[0].episodes[0].progress.pos,42);
});
test('AP-14 diagnostics redact URL credentials, fragments, signed queries and HTTP secrets',()=>{
  const secret='https://user:pass@cdn.test/file?token=SIGNED#SECRET\nCookie: SESSION=COOKIE; other=VALUE\nAuthorization: Bearer AUTH\nSet-Cookie: SESSION=OTHER\npassword=PASSWORD api_key=API access_token=ACCESS';
  const sanitized=redact(secret);for(const value of ['user:pass','SIGNED','SECRET','COOKIE','VALUE','AUTH','OTHER','PASSWORD','API','ACCESS'])assert.ok(!sanitized.includes(value),value);
  assert.equal(redact(sanitized),sanitized,'repeated diagnostic/persistence redaction must be idempotent');
});
function sessionFixture(t,options={}) {
  const req=require('module').createRequire(path.join(repo,'src/mpv.js'));const proc=new EventEmitter();proc.stderr=new EventEmitter();proc.stdout=new EventEmitter();proc.kill=()=>proc.emit('close',null,'SIGTERM');
  const sockets=[];const net={connect:()=>{const socket=new EventEmitter();socket.destroy=()=>{socket.destroyed=true;};socket.write=()=>{};sockets.push(socket);return socket;}};
  const context={require:n=>n==='child_process'?{spawn:()=>proc}:n==='net'?net:req(n),module:{exports:{}},process,setTimeout,clearTimeout,setInterval,clearInterval};
  vm.runInNewContext(fs.readFileSync(path.join(repo,'src/mpv.js'),'utf8'),context);
  const session=new context.module.exports.MpvSession({mpvPath:'fixture',args:[],pipe:'fixture',ipcTimeoutMs:30,loadTimeoutMs:50,quitTimeoutMs:10,...options});
  const result=deferred();session.on('exit',result.resolve);session.start();t.after(()=>{if(!session.closed)proc.emit('close',0,null);clearTimeout(session.killTimer);clearTimeout(session.connectTimer);});
  return {session,proc,sockets,result};
}
for(const [input,expected] of [['app-stop','app-stop'],['replaced','replaced'],['account-change','account-change'],['shutdown','shutdown'],['quit','user-close'],['eof','eof'],['error','source-error'],['abnormal','abnormal']]) test(`AP-14 termination classification: ${input}`,async t=>{
  const {session,proc,sockets,result}=sessionFixture(t);sockets[0].emit('connect');
  if(['quit','eof','error'].includes(input))session._onMessage({event:'end-file',reason:input,file_error:input==='error'?'Failed to open file':undefined});
  else if(input!=='abnormal')session.quit(input);
  proc.emit('close',input==='abnormal'?9:0,null);const r=await result.promise;assert.equal(r.reason,expected);
});
test('AP-14 IPC timeout is observable, bounded and stops mpv',async t=>{
  const {sockets,result}=sessionFixture(t,{loadTimeoutMs:1000});sockets[0].emit('error',Error('Unavailable'));
  const r=await Promise.race([result.promise,delay(300).then(()=>null)]);assert.ok(r,'IPC timeout must terminate and report');assert.equal(r.reason,'ipc-timeout');
});
test('AP-14 connected IPC with no loaded file reports a loading timeout',async t=>{
  const {sockets,result}=sessionFixture(t);sockets[0].emit('connect');const r=await Promise.race([result.promise,delay(300).then(()=>null)]);assert.ok(r);assert.equal(r.reason,'load-timeout');
});
test('AP-14 an established IPC connection that stops replying times out once',async t=>{
  const {session,sockets,result}=sessionFixture(t,{loadTimeoutMs:1000,heartbeatMs:20,responseTimeoutMs:30});sockets[0].emit('connect');session._onMessage({event:'file-loaded'});
  const r=await Promise.race([result.promise,delay(300).then(()=>null)]);assert.ok(r);assert.equal(r.reason,'ipc-timeout');assert.equal(r.connected,true);
});
test('AP-14 IPC heartbeat accepts a reply while playback is paused',async t=>{
  const {session,sockets}=sessionFixture(t,{loadTimeoutMs:1000,heartbeatMs:20,responseTimeoutMs:50});sockets[0].emit('connect');session._onMessage({event:'file-loaded'});
  await delay(25);assert.ok(session.pendingCommandId);session._onMessage({request_id:session.pendingCommandId,error:'success',data:1});
  assert.equal(session.pendingCommandId,null);session.quit();
});
for(const kind of ['url','movie'])test(`AP-07 ${kind} IPC Stop during mpv validation cancels launch`,async t=>{
  const f=fixture(t),{player,launches}=managed(t,f),gate=deferred(),entered=deferred();let pending;
  const {handlers}=mainFixture(f.store,player,{validate:async()=>{entered.resolve();await gate.promise;return{ok:true,path:'fixture'};}});
  if(kind==='url')pending=handlers['player:playUrl']('https://fixture.test/raw.mp4');
  else {const film=f.store.addSeries({title:'Synthetic film',format:'MOVIE'});f.store.addContentSources(film.id,[{number:1,url:'https://fixture.test/film.mp4'}]);pending=handlers['movie:play'](film.id);}
  await entered.promise;await player.stop();gate.resolve();await pending;assert.equal(launches.length,0);
});
for(const action of ['account','delete-series','delete-unit'])test(`AP-07 ${action} during AniSkip cancels preparation without mutating the next library`,async t=>{
  const f=fixture(t),{player,launches}=managed(t,f),gate=deferred(),entered=deferred(),original=meta.fetchAniSkipTimes;
  meta.fetchAniSkipTimes=async()=>{entered.resolve();await gate.promise;return[{skipType:'op',start:0,end:50}];};t.after(()=>{meta.fetchAniSkipTimes=original;});
  const {handlers}=mainFixture(f.store,player);const pending=handlers['player:play'](f.series.id,f.ep.id);await entered.promise;
  if(action==='account'){await player.stop({reason:'account-change'});f.store.switchFile(path.join(f.dir,'next-account.json'));}
  else await handlers[action==='delete-series'?'series:delete':'episodes:delete'](f.series.id,f.ep.id);
  const before=JSON.stringify(f.store.snapshot());gate.resolve();await pending;assert.equal(launches.length,0);assert.equal(JSON.stringify(f.store.snapshot()),before);
});
test('AP-07 a superseded session EOF cannot override a new request still preparing',async t=>{
  const f=fixture(t),{player}=fakePlayback(t,f);f.store.setSettings({autoplayNext:true});await player.play(f.series.id,f.ep.id);
  const cur=player.cur;player.beginRequest(f.series.id,f.series.episodes[1].id);
  let autoplay=0;player.play=async()=>{autoplay++;};cur.session.emit('exit',{eof:true,code:0,reason:'eof'});assert.equal(autoplay,0);
});
test('AP-07 concurrent renewals with inverted responses keep the newest generation',async t=>{
  const f=fixture(t),gates=[deferred(),deferred()],entered=[deferred(),deferred()];let n=0;
  f.ep.sources[0].provider='animeunity';f.ep.sources[0].resolutionState='found';
  const {player,launches}=managed(t,f,{resolveAutomaticSource:async()=>{const i=n++;entered[i].resolve();await gates[i].promise;return{...f.ep.sources[0],url:`https://fixture.test/renewal-${i}.mp4`,resolutionState:'resolved'};}});
  const first=player.play(f.series.id,f.ep.id);await entered[0].promise;const second=player.play(f.series.id,f.ep.id);await entered[1].promise;
  gates[1].resolve();await second;gates[0].resolve();await first;assert.equal(launches.length,1);assert.match(launches[0].url,/renewal-1/);
});
test('AP-09 repeated Stop flushes once, records one watch session and removes stop listeners',async t=>{
  const f=fixture(t),{player}=fakePlayback(t,f);await player.play(f.series.id,f.ep.id);const session=player.cur.session;session.emit('duration',1000);session.emit('time',20);
  let saves=0,watches=0;const save=f.store.setProgress.bind(f.store);f.store.setProgress=(...args)=>{saves++;return save(...args);};player.onWatchSession=()=>watches++;
  await Promise.all([player.stop(),player.stop()]);assert.equal(saves,1);assert.equal(watches,1);assert.equal(session.listenerCount('spawn-error'),1);
  assert.equal(player.diagnostics.read().length,1);assert.equal(player.diagnostics.read()[0].reason,'app-stop');
});
test('AP-14 bounded diagnostic history excludes source URL, cookie and arguments',t=>{
  const f=fixture(t),{PlaybackDiagnostics}=require('../src/playback-diagnostics'),diagnostics=new PlaybackDiagnostics(f.dir);
  for(let i=0;i<55;i++)diagnostics.record({startedAt:Date.now(),series:f.series,ep:f.ep,source:{...f.ep.sources[0],referer:'https://fixture.test/?token=COOKIE'},args:['SECRET']},
    {reason:'source-error',stdout:'https://fixture.test/SECRET?token=COOKIE\nCookie: CREDENTIAL=SECRET'});
  assert.equal(diagnostics.read().length,50);const raw=fs.readFileSync(diagnostics.file,'utf8');for(const value of ['SECRET','COOKIE','CREDENTIAL','referer','args'])assert.ok(!raw.includes(value));
});
test('AP-07 Stop while replacing an existing mpv session prevents the prepared launch',async t=>{
  const f=fixture(t),{player}=fakePlayback(t,f);let launches=0;const write=player._writeInputConf.bind(player);player._writeInputConf=()=>{launches++;write();};
  await player.play(f.series.id,f.ep.id);const session=player.cur.session,gate=deferred();session.quit=()=>gate.promise.then(()=>session.emit('exit',{code:0,reason:'replaced'}));
  const replacement=player.play(f.series.id,f.series.episodes[1].id);await delay(0);
  const stopped=player.stop();gate.resolve();await Promise.all([replacement,stopped]);assert.equal(launches,1);assert.equal(player.cur,null);
});
test('AP-09 checkpoint during a cloud upload retains the local revision and pending progress',async t=>{
  const {CloudService,compressLibraryForCloud}=require('../src/cloud');
  const f=fixture(t),{player}=fakePlayback(t,f);await player.play(f.series.id,f.ep.id);
  const remote={revision:7,snapshot:{library:compressLibraryForCloud(f.store.snapshot())},updated_at:new Date().toISOString()};
  const gate=deferred(),entered=deferred();
  const client={from:table=>{assert.equal(table,'user_library_snapshots');let value;
    const query={select:()=>query,eq:()=>query,update:v=>{value=v;return query;},single:()=>query.maybeSingle(),maybeSingle:async()=>{
      if(!value)return {data:remote};entered.resolve();await gate.promise;return{data:{revision:value.revision,updated_at:value.updated_at}};
    }};return query;
  }};
  const cloud=new CloudService({store:f.store,userDataPath:f.dir,safeStorage:{},env:{},client});cloud.user={id:'fixture-user'};cloud.activeLibraryUserId='fixture-user';cloud.state.libraryRevision=7;cloud._scheduleSync=()=>{};
  const upload=cloud._syncPrivateLibrary('fixture-user');await entered.promise;const revision=f.store.revision;
  player.cur.session.emit('duration',1000);player.cur.session.emit('time',33);player.cur.session.emit('pause',true);
  assert.ok(f.store.revision>revision);const checkpointRevision=f.store.revision;gate.resolve();await upload;
  assert.equal(f.store.getEpisode(f.series.id,f.ep.id).progress.pos,33);assert.equal(f.store.revision,checkpointRevision);assert.equal(f.store.data.cloudDirty,true);
});
test('AP-14 diagnostics collect output drained after the process exit event',async t=>{
  const {session,proc,result}=sessionFixture(t);proc.emit('exit',2,null);proc.stdout.emit('data',Buffer.from('HTTP error 403 Forbidden https://fixture.test/SECRET?token=PRIVATE'));
  proc.emit('close',2,null);const r=await result.promise;assert.equal(r.reason,'network-error');assert.match(r.networkEvidence,/403/);assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
test('AP-07 late skip events from a replaced session cannot control the current player',async t=>{
  const f=fixture(t),{player}=fakePlayback(t,f);await player.play(f.series.id,f.ep.id);const old=player.cur.session;
  await player.play(f.series.id,f.series.episodes[1].id);let skips=0;player.skipCurrentSegment=()=>skips++;
  old.emit('skip','intro');assert.equal(skips,0);player.cur.session.emit('skip','intro');assert.equal(skips,1);
});
