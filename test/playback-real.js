'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),http=require('http');
const {execFile}=require('child_process');
const {Store}=require('../src/store');
const {PlayerManager}=require('../src/player');
const {MpvSession,pipePath}=require('../src/mpv');
const mpvPath=process.env.ANIME_PLAYER_TEST_MPV || path.join(process.env.APPDATA || '', 'Anime Player','mpv',`win32-${process.arch}`,'mpv.exe');
const available=fs.existsSync(mpvPath);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(predicate,timeout=12000) {const start=Date.now();while(!predicate()){if(Date.now()-start>timeout)throw Error('Real playback timed out');await delay(25);}}
function wav(seconds=16) {
  const n=8000*seconds,b=Buffer.alloc(44+n*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);
  b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);return b;
}
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anime-player-real-')),file=path.join(dir,'synthetic.wav');fs.writeFileSync(file,wav());
  const store=new Store(path.join(dir,'library.json')),players=[],sessions=[];
  t.after(async()=>{for(const p of players)await p.stop();for(const s of sessions)if(!s.closed){const done=new Promise(r=>s.once('exit',r));s.quit('app-stop');await done;}
    clearTimeout(store._timer);fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,file,store,players,sessions};
}
function session(f,url,options={}) {
  const pipe=pipePath(),s=new MpvSession({mpvPath,pipe,args:['--no-config','--vo=null','--ao=null',`--input-ipc-server=${pipe}`,url],...options});
  f.sessions.push(s);const exited=new Promise(r=>s.once('exit',r));s.start();return {s,exited};
}
test('real mpv: default periodic checkpoint, pause, seek, cloud object replacement and account switch', {skip:!available,timeout:20000},async t=>{
  const f=fixture(t),s=f.store.addSeries({title:'Synthetic playback',format:'TV'});f.store.addSources(s.id,[{number:1,url:f.file}]);const ep=s.episodes[0];
  f.store.setSettings({mpvPath,defaultPreset:'off',extraArgs:'--no-config --vo=null --ao=null',autoplayNext:false});
  const errors=[],p=new PlayerManager({store:f.store,paths:{userData:f.dir,shaderDir:path.join(__dirname,'..','shaders')},notify:(ch,value)=>{if(ch==='player:error')errors.push(value);}});f.players.push(p);
  await p.play(s.id,ep.id);await waitFor(()=>p.cur?.pos>6);
  let saved=JSON.parse(fs.readFileSync(f.store.file,'utf8'));assert.ok(saved.series[0].episodes[0].progress.pos>4,'default 5-second checkpoint must reach disk during continuous playback');
  p.cur.session.send(['set_property','pause',true]);await waitFor(()=>f.store.getEpisode(s.id,ep.id).progress.pos>6);
  const priorPosition=p.cur.pos;
  const beforeCloud=p.cur.ep;
  f.store.applyCloudData(f.store.snapshot(),new Date().toISOString());assert.notEqual(beforeCloud,f.store.getEpisode(s.id,ep.id));
  assert.equal(p.cur.ep,f.store.getEpisode(s.id,ep.id),'settings sync refreshes the active episode immediately');
  p.seekAbsolute(10);await waitFor(()=>p.cur?.pos>=9);await waitFor(()=>f.store.getEpisode(s.id,ep.id).progress.pos>=9);
  assert.ok(Math.abs(f.store.getEpisode(s.id,ep.id).progress.pos-p.cur.pos)<0.1,'save the observed seek position, including mpv preroll');
  assert.ok(f.store.revision>0 && f.store.data.cloudDirty,'checkpoint remains a pending local cloud revision');
  await p.stop({reason:'account-change'});saved=JSON.parse(fs.readFileSync(f.store.file,'utf8'));assert.ok(saved.series[0].episodes[0].progress.pos>priorPosition);
  assert.equal(p.diagnostics.read().at(-1).reason,'account-change');
  f.store.switchFile(path.join(f.dir,'other-account.json'));assert.equal(f.store.data.series.length,0);assert.equal(errors.length,0);
});
test('real mpv: EOF and voluntary quit are distinguished by end-file events', {skip:!available,timeout:12000},async t=>{
  const f=fixture(t);
  const pipe=pipePath(),s=new MpvSession({mpvPath,pipe,args:['--no-config','--vo=null','--ao=null','--speed=8',`--input-ipc-server=${pipe}`,f.file]});f.sessions.push(s);
  const ended=new Promise(r=>s.once('exit',r));s.start();const result=await ended;assert.equal(result.reason,'eof');assert.equal(result.eof,true);
  const manual=session(f,f.file);await waitFor(()=>manual.s.connected);manual.s.send(['quit']);const closed=await manual.exited;assert.equal(closed.reason,'user-close');assert.equal(closed.endReason,'quit');
});
test('real mpv: HTTP loading error retains evidence and hides signed URL', {skip:!available,timeout:12000},async t=>{
  const f=fixture(t),server=http.createServer((req,res)=>{res.writeHead(403);res.end('Synthetic denial');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();server.close();});
  const {exited}=session(f,`http://127.0.0.1:${server.address().port}/bad.wav?token=PRIVATE`);const result=await exited;
  assert.equal(result.reason,'network-error',JSON.stringify(result));assert.match(result.networkEvidence,/403/);assert.ok(result.error);assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});
test('real mpv: unavailable IPC has one bounded timeout and forced termination', {skip:!available,timeout:10000},async t=>{
  const f=fixture(t),pipe=pipePath();const {exited}=session(f,f.file,{pipe:pipePath(),ipcTimeoutMs:300,quitTimeoutMs:100,args:['--no-config','--vo=null','--ao=null',`--input-ipc-server=${pipe}`,f.file]});
  const result=await exited;assert.equal(result.reason,'ipc-timeout');assert.equal(result.forced,true);assert.equal(result.connected,false);
});
test('real mpv: connected IPC and stalled HTTP load report load timeout', {skip:!available,timeout:10000},async t=>{
  const f=fixture(t),server=http.createServer(()=>{});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
  const {exited}=session(f,`http://127.0.0.1:${server.address().port}/stalled.wav`,{loadTimeoutMs:700,ipcTimeoutMs:3000,quitTimeoutMs:100});
  const result=await exited;assert.equal(result.reason,'load-timeout');assert.equal(result.connected,true);assert.equal(result.loaded,false);
});
test('real Electron quit during mpv playback flushes before process exit', {skip:!available || (process.platform==='linux' && !process.env.DISPLAY),timeout:20000},async t=>{
  const f=fixture(t),result=path.join(f.dir,'electron-result.json'),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve,reject)=>execFile(require('electron'),[path.join(__dirname,'electron-playback-shutdown.js'),`--fixture=${f.dir}`,`--mpv=${mpvPath}`],{env,windowsHide:true,timeout:15000},(error,stdout,stderr)=>error?reject(Error(`${error.message}\n${stdout}\n${stderr}`)):resolve()));
  const report=JSON.parse(fs.readFileSync(result,'utf8'));assert.equal(report.ok,true,report.error);
  const saved=JSON.parse(fs.readFileSync(path.join(f.dir,'electron-library.json'),'utf8'));assert.ok(saved.series[0].episodes[0].progress.pos>1);
  const diagnostics=JSON.parse(fs.readFileSync(path.join(f.dir,'playback-diagnostics.json'),'utf8'));assert.equal(diagnostics.at(-1).reason,'shutdown');
});
