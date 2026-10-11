'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const S=require('../src/playback-shortcuts'),{decideSkip}=require('../src/skip-decision'),{Store}=require('../src/store'),A=require('../src/anime4k'),{PlayerManager}=require('../src/player'),{MpvSession}=require('../src/mpv');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<300;i++){if(await fn())return;await delay(20);}throw Error('Timed out');}
test('AP-08 case, modifier order, Shift text and special keys match mpv semantics',()=>{
  for(const [input,out]of [['CTRL+i','Ctrl+i'],['CTRL+I','Ctrl+I'],['alt+ctrl+shift+i','Ctrl+Alt+I'],['SHIFT+LEFT','Shift+LEFT'],['ctrl+f8','Ctrl+F8'],['Shift+2','2'],['Ctrl+Shift+2','Ctrl+2'],['','']])assert.equal(S.normalize(input),out);
  assert.equal(S.capture({key:'i',ctrlKey:true,altKey:true}),'Ctrl+Alt+i');assert.equal(S.capture({key:'I',ctrlKey:true,shiftKey:true}),'Ctrl+I');
  assert.equal(S.capture({key:'PageDown',shiftKey:true}),'Shift+PGDWN');assert.equal(S.capture({key:'Shift'}),null);assert.equal(S.capture({key:'o',repeat:true}),null);
  assert.equal(S.display('Ctrl+I'),'Ctrl + Shift + i');
});
test('invalid combinations, input injection, duplicate semantic keys and reserved commands rejected',()=>{
  for(const raw of ['ctrl+ctrl+i','CTRL+','Ctrl+F99','o\nq quit','Ctrl++','foo','Ctrl+;'])assert.throws(()=>S.normalize(raw));
  for(const raw of [{skipIntro:'Ctrl+Shift+i',skipEnding:'Ctrl+I'},{skipIntro:'Ctrl+1'},{skipEnding:'SPACE'},{skipIntro:'PGUP'}])assert.throws(()=>S.validate(raw));
  assert.throws(()=>S.capture({key:'Dead'}));assert.throws(()=>S.capture({key:'@'}));
  assert.equal(S.validate({skipIntro:'Ctrl+Alt+F8'}).skipIntro,'Ctrl+Alt+F8');
});
test('new defaults are manual, explicit disabled/legacy case survives and unsafe legacy text is never generated',()=>{
  assert.equal(S.effective({skipIntro:''}).skipIntro,'');assert.equal(S.bindings({skipIntro:'CTRL+I'}).skipIntro,'Ctrl+I');
  assert.equal(S.bindings({skipIntro:'o\nq quit'}).skipIntro,'');
  const conf=A.buildInputConf('/synthetic',{skipIntro:'CTRL+i',skipEnding:'',next:'',previous:''});assert.match(conf,/Ctrl\+i script-message ap-skip-intro/);assert.ok(!conf.includes('ap-next'));assert.ok(!conf.includes('ap-skip-ending'));
  assert.ok(!A.buildInputConf('/synthetic',{},false).includes('ap-skip'));
});
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anime-shortcuts-'));const store=new Store(path.join(dir,'library.json')),series=store.addSeries({title:'Synthetic',format:'TV',cover:'fixture',personalRating:8});store.addSources(series.id,[{number:1,url:'https://fixture.test/1',referer:'https://headers.test/',userAgent:'unchanged'}]);const ep=series.episodes[0];ep.skipTimes=[{skipType:'op',start:10,end:20},{skipType:'mixed-ed',start:60,end:70}];t.after(()=>{clearTimeout(store._timer);fs.rmSync(dir,{recursive:true,force:true});});return {dir,store,series,ep};}
test('preferences reopen/import/private snapshot cloud roundtrip preserve IDs, headers, content and organization',t=>{
  const f=fixture(t),protect=series=>series.map(s=>({id:s.id,title:s.title,cover:s.cover,personalRating:s.personalRating,episodes:s.episodes.map(e=>({id:e.id,number:e.number,progress:e.progress,skipTimes:e.skipTimes,sources:e.sources.map(x=>({id:x.id,url:x.url,referer:x.referer,userAgent:x.userAgent}))}))})),before=protect(f.store.data.series),organization=JSON.stringify(f.store.data.organization);
  f.store.setSettings({shortcuts:{next:'Ctrl+N',previous:'PGUP',skipIntro:'Ctrl+i',skipEnding:''}});f.store.save(true);
  const reopened=new Store(f.store.file);t.after(()=>clearTimeout(reopened._timer));assert.deepEqual(reopened.data.settings.shortcuts,f.store.data.settings.shortcuts);assert.equal(reopened.data.settings.skipOpening,false);assert.equal(reopened.data.settings.skipEnding,false);
  reopened.importData(f.store.snapshot());assert.deepEqual(protect(reopened.data.series),before);assert.equal(JSON.stringify(reopened.data.organization),organization);
  const cloud=require('../src/cloud'),packed=cloud.compressLibraryForCloud(f.store.snapshot()),remote=cloud.expandLibraryFromCloud(packed);reopened.applyCloudData(remote,new Date().toISOString());
  assert.deepEqual(reopened.data.settings.shortcuts,f.store.data.settings.shortcuts);assert.deepEqual(protect(reopened.data.series),before);
});
const intervals=[{skipType:'op',start:10,end:20},{skipType:'mixed-op',start:40,end:50},{skipType:'ed',start:60,end:70}];
test('stale UI offer and unmatched legacy timestamp never query or seek the new episode',async t=>{
  const f=fixture(t),commands=[],p=new PlayerManager({store:f.store,paths:{userData:f.dir},notify:()=>{}});
  p.cur={series:f.series,ep:f.ep,requestId:2,scope:f.store.scope,session:{request:async cmd=>{commands.push(cmd);return 12;}}};
  for(const offer of [{requestId:1,seriesId:f.series.id,episodeId:f.ep.id},{requestId:2,seriesId:f.series.id,episodeId:'old'}])assert.equal(await p.skipCurrentSegment('intro',offer),false);
  assert.equal(await p.skipSegment(999),false);assert.deepEqual(commands,[]);
});
for(const [name,time,kind,target,reason]of [['far before',7,'intro',null,'outside-interval'],['two seconds before',8,'intro',20],['before boundary',9.99,'intro',20],['start',10,'intro',20],['inside',15,'intro',20],['at end',20,'intro',null,'outside-interval'],['after',21,'intro',null,'outside-interval'],['next irregular',38,'intro',50],['second inside',42,'intro',50],['ending',61,'ending',70],['wrong kind',42,'ending',null,'outside-interval']])test('deterministic seek: '+name,()=>{const d=decideSkip({episode:{id:'fixture'},time,duration:90,intervals,kind});assert.equal(d.ok,target!==null);if(d.ok)assert.equal(d.target,target);else assert.equal(d.reason,reason);});
test('missing episode/data, malformed timestamps, real duration bounds, recap and unknown kind never seek',()=>{
  const base={episode:{id:'ep'},time:10,duration:90,kind:'intro'};
  for(const overrides of [{episode:null},{time:NaN},{time:-1},{duration:0},{duration:NaN},{time:100},{kind:'recap'},{intervals:[]},...[-1,null,'10',NaN,Infinity].map(start=>({intervals:[{skipType:'op',start,end:20}]})),{intervals:[{skipType:'op',start:10,end:100}]},{intervals:[{skipType:'op',start:20,end:10}]},{intervals:[{skipType:'recap',start:10,end:20}]}])assert.equal(decideSkip({...base,...overrides}).ok,false);
  assert.equal(decideSkip({...base,intervals:[{skipType:'mixed-op',start:10,end:20}]}).target,20);
  assert.equal(decideSkip({...base,kind:'ending',intervals:[{skipType:'mixed-ed',start:10,end:20}]}).target,20);
  assert.equal(decideSkip({...base,intervals:[{skipType:'op',start:10,end:25},{skipType:'op',start:10,end:20}]}).target,20);
});
for(const change of ['stop','episode','source','exit'])test('late manual seek response is discarded after '+change,async t=>{
  const f=fixture(t),commands=[],p=new PlayerManager({store:f.store,paths:{userData:f.dir},notify:()=>{}});let resolve;
  const pending=new Promise(r=>resolve=r),cur={series:f.series,ep:f.ep,requestId:p.playRequestId,scope:f.store.scope,session:{request:async command=>{commands.push(command);if(command[1]==='time-pos')return pending;return 90;}}};p.cur=cur;
  const skipped=p.skipCurrentSegment('intro');if(change==='stop')cur.stopping=true;else if(change==='exit')p.cur=null;else{p.playRequestId++;p.cur={...cur,ep:{id:'new'}};}resolve(12);
  assert.equal(await skipped,false);assert.ok(!commands.some(x=>x[0]==='seek'));
});
test('concurrent/repeated keys use one current request and bounded OSD, never legacy duration fallback',async t=>{
  const f=fixture(t),commands=[],p=new PlayerManager({store:f.store,paths:{userData:f.dir},notify:()=>{}});f.series.introDuration=90;let time=12;
  p.cur={series:f.series,ep:f.ep,requestId:0,scope:f.store.scope,session:{request:async cmd=>{commands.push(cmd);if(cmd[1]==='time-pos')return time;if(cmd[1]==='duration')return 90;if(cmd[0]==='seek')time=cmd[1];},send:cmd=>commands.push(cmd)}};
  assert.deepEqual(await Promise.all([p.skipCurrentSegment('intro'),p.skipCurrentSegment('intro'),p.skipCurrentSegment('intro')]),[true,false,false]);assert.equal(commands.filter(x=>x[0]==='seek').length,1);
  p.cur.skipCooldown=0;assert.equal(await p.skipCurrentSegment('intro'),false);assert.equal(time,20);assert.equal(commands.filter(x=>x[0]==='show-text').length,1);
  f.ep.skipTimes.push({skipType:'op',start:20,end:25});assert.equal(await p.skipCurrentSegment('intro'),false);assert.equal(time,20,'repeated keys must not chain adjacent segments');
  f.ep.skipTimes=[];assert.equal(await p.skipCurrentSegment('intro'),false);assert.equal(time,20);
});
test('MpvSession requests use independent IDs, errors reject and exit cancels all pending responses',async()=>{
  const s=new MpvSession({}),sent=[];s.sock={destroyed:false,write:text=>sent.push(JSON.parse(text)),destroy(){this.destroyed=true;}};
  const a=s.request(['get_property','duration']),b=s.request(['get_property','time-pos']);s._onMessage({request_id:sent[1].request_id,error:'success',data:12});s._onMessage({request_id:sent[0].request_id,error:'success',data:90});assert.equal(await a,90);assert.equal(await b,12);
  const failure=s.request(['bad']);s._onMessage({request_id:sent.at(-1).request_id,error:'invalid parameter'});await assert.rejects(failure);
  const closing=s.request(['get_property','duration']);s._cleanup();await assert.rejects(closing,/terminata/);assert.equal(s.requests.size,0);assert.equal(s.send(['quit']),false);
});
const mpv=process.env.ANIME_PLAYER_TEST_MPV||path.join(process.env.APPDATA||'','Anime Player','mpv','win32-x64','mpv.exe');
test('queued shortcut updates never cross episode/session generations',async t=>{
  const f=fixture(t),p=new PlayerManager({store:f.store,paths:{userData:f.dir,shaderDir:''},notify:()=>{}}),commands=[];let release,entered;
  const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
  const old={series:f.series,ep:f.ep,requestId:0,scope:f.store.scope,session:{loaded:true,configureShortcuts:async keys=>{commands.push(keys);entered();await gate;return {ok:true};}}};p.cur=old;
  const a=p.applyShortcuts({...S.DEFAULTS,skipIntro:'Ctrl+Alt+F8'}),aRejected=assert.rejects(a,/Sessione cambiata/);await ready;
  const b=p.applyShortcuts({...S.DEFAULTS,skipIntro:'Ctrl+Alt+F9'}),bRejected=assert.rejects(b,/Sessione cambiata/);
  p.playRequestId++;p.cur={...old,requestId:1,session:{loaded:true,configureShortcuts:async()=>{throw Error('Must not apply to new session');}}};release();await Promise.all([aRejected,bRejected]);assert.equal(commands.length,1);
});
test('Store settings/import/private sync notify live player; invalid legacy preferences stay intact and report once',async t=>{
  const f=fixture(t),events=[],applied=[],p=new PlayerManager({store:f.store,paths:{userData:f.dir,shaderDir:''},notify:(...v)=>events.push(v)});
  p.cur={series:f.series,ep:f.ep,requestId:0,scope:f.store.scope,session:{loaded:true,configureShortcuts:async keys=>{applied.push(keys);return {ok:true};}}};
  f.store.setSettings({shortcuts:{...S.DEFAULTS,skipIntro:'Ctrl+Alt+F8'}});await until(()=>p.cur.shortcutKeys?.skipIntro==='Ctrl+Alt+F8');
  const remote=f.store.snapshot();remote.settings.shortcuts={...S.DEFAULTS,skipIntro:'Ctrl+Alt+F9'};
  f.store.applyCloudData(remote,new Date().toISOString());await until(()=>p.cur.shortcutKeys.skipIntro==='Ctrl+Alt+F9');
  remote.settings.shortcuts.skipIntro='Ctrl+Alt+F10';f.store.importData(remote);await until(()=>p.cur.shortcutKeys.skipIntro==='Ctrl+Alt+F10');
  const count=applied.length;assert.equal(f.store.applyCloudData(remote,new Date().toISOString(),{expected:{scope:-1,revision:-1}}),false);assert.equal(applied.length,count);
  f.store.setSettings({shortcuts:{...S.DEFAULTS,skipIntro:'malformed legacy'}});await until(()=>events.length===1);p._syncShortcuts();assert.equal(events.length,1);assert.equal(f.store.data.settings.shortcuts.skipIntro,'malformed legacy');assert.equal(p.cur.shortcutKeys.skipIntro,'Ctrl+Alt+F10');
});
test('application launch leaves input.conf untouched and removes command-line input-conf override',t=>{
  const f=fixture(t),file=path.join(f.dir,'input.conf');fs.writeFileSync(file,'fixture sentinel - do not modify');
  const p=new PlayerManager({store:f.store,paths:{userData:f.dir,shaderDir:''},notify:()=>{}});p._writeShortcutScript();assert.equal(fs.readFileSync(file,'utf8'),'fixture sentinel - do not modify');
  const args=A.buildArgs({settings:{},presetId:'off',url:'fixture',shaderDir:'',pipe:'fixture'});assert.ok(!args.some(x=>x.startsWith('--input-conf=')));
});
test('serialized updates snapshot keys and finish in order without late overwrite',async t=>{
  const f=fixture(t),applied=[],p=new PlayerManager({store:f.store,paths:{userData:f.dir,shaderDir:''},notify:()=>{}});
  p.cur={series:f.series,ep:f.ep,requestId:0,scope:f.store.scope,session:{loaded:true,configureShortcuts:async keys=>{await delay(15);applied.push(keys);return {ok:true};}}};
  const raw={...S.DEFAULTS,skipIntro:'Ctrl+Alt+F8'},first=p.applyShortcuts(raw);raw.skipIntro='Ctrl+Alt+F9';const second=p.applyShortcuts(raw);await Promise.all([first,second]);assert.deepEqual(applied.map(x=>x.skipIntro),['Ctrl+Alt+F8','Ctrl+Alt+F9']);assert.equal(p.cur.shortcutKeys.skipIntro,'Ctrl+Alt+F9');
});
function wave(seconds){const b=Buffer.alloc(44+8000*seconds*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);return b;}
test('real mpv Lua: exact OP/ED seeks, live case/modifiers/special keys, disable, restore, custom conflict and restart',{skip:!fs.existsSync(mpv),timeout:25000},async t=>{
  const f=fixture(t),file=process.env.ANIME_PLAYER_TEST_MEDIA||path.join(f.dir,'synthetic.wav'),custom=path.join(f.dir,'custom-input.conf');if(!process.env.ANIME_PLAYER_TEST_MEDIA)fs.writeFileSync(file,wave(90));fs.writeFileSync(custom,'Ctrl+Alt+k show-text "Protected custom binding"\n');f.ep.sources[0].url=file;
  f.store.setSettings({mpvPath:mpv,defaultPreset:'off',extraArgs:`--no-config --vo=null --ao=null --pause=yes "--input-conf=${custom}"`,autoplayNext:false});
  const errors=[],p=new PlayerManager({store:f.store,paths:{userData:f.dir,shaderDir:path.join(__dirname,'../shaders')},notify:(ch,v)=>{if(ch==='player:error')errors.push(v);}});t.after(()=>p.stop());
  await p.play(f.series.id,f.ep.id);await until(()=>p.cur?.shortcutKeys);let cur=p.cur,s=cur.session;
  const position=()=>s.request(['get_property','time-pos']);
  const press=async(key,start,end)=>{cur.skipCooldown=0;await s.request(['set_property','pause',true]);await s.request(['seek',start,'absolute+exact']);await until(async()=>Math.abs(await position()-start)<.15);await s.request(['keypress',key]);await until(async()=>Math.abs(await position()-end)<.15);};
  await press('Ctrl+O',12,20);await press('Ctrl+E',61,70);await press('Ctrl+O',8,20);
  cur.skipCooldown=0;await s.request(['keypress','Ctrl+O']);await delay(100);assert.equal(await position(),20);
  await p.applyShortcuts({...S.DEFAULTS,skipIntro:'Ctrl+i'});await press('Ctrl+i',12,20);
  await p.applyShortcuts({...S.DEFAULTS,skipIntro:'Ctrl+I'});await press('Ctrl+I',12,20);
  await p.applyShortcuts({...S.DEFAULTS,skipIntro:'Ctrl+Alt+F8'});await press('Ctrl+Alt+F8',12,20);
  await s.request(['keybind','Ctrl+Alt+k','show-text "Protected custom binding"']);
  await assert.rejects(p.applyShortcuts({...S.DEFAULTS,skipIntro:'Ctrl+Alt+k'}),/Protected custom binding/);assert.equal(cur.shortcutKeys.skipIntro,'Ctrl+Alt+F8');await press('Ctrl+Alt+F8',12,20);
  await p.applyShortcuts({...S.DEFAULTS,skipIntro:''});await s.request(['seek',12,'absolute+exact']);await until(async()=>Math.abs(await position()-12)<.15);await s.request(['keypress','Ctrl+Alt+F8']);await delay(150);assert.equal(await position(),12);
  await p.applyShortcuts(S.DEFAULTS);await press('Ctrl+O',12,20);
  f.store.setSettings({shortcuts:{...S.DEFAULTS,skipIntro:'Ctrl+Alt+F9'}});await until(()=>cur.shortcutKeys.skipIntro==='Ctrl+Alt+F9');await press('Ctrl+Alt+F9',12,20);
  const remote=f.store.snapshot();remote.settings.shortcuts={...S.DEFAULTS,skipIntro:'Ctrl+Alt+F10'};f.store.applyCloudData(remote,new Date().toISOString());await until(()=>cur.shortcutKeys.skipIntro==='Ctrl+Alt+F10');await press('Ctrl+Alt+F10',12,20);
  f.store.addSources(f.series.id,[{number:1,url:file+'?synthetic-source-2'}]);f.store.getEpisode(f.series.id,f.ep.id).sources[1].url=file;
  await p.play(f.series.id,f.ep.id,{sourceIndex:1});await until(()=>p.cur?.shortcutKeys);cur=p.cur;s=cur.session;assert.equal(cur.sourceIndex,1);await press('Ctrl+Alt+F10',12,20);
  const next=f.store.ensureEpisode(f.store.getSeries(f.series.id),2);f.store.addSources(f.series.id,[{number:2,url:file}]);next.skipTimes=[];await p.play(f.series.id,next.id);await until(()=>p.cur?.shortcutKeys);cur=p.cur;s=cur.session;await s.request(['set_property','pause',true]);await s.request(['seek',12,'absolute+exact']);await until(async()=>Math.abs(await position()-12)<.15);assert.equal(await p.skipCurrentSegment('intro'),false);assert.equal(await position(),12);
  await p.stop();assert.equal(s.closed,true);assert.equal(s.requests.size,0);assert.equal(s.bindingRequests.size,0);assert.equal(p.cur,null);assert.equal(errors.length,0,JSON.stringify(errors));
});
test('real mpv respects a synthetic input.conf and its custom Anime4K key',{skip:!fs.existsSync(mpv),timeout:15000},async t=>{
  const f=fixture(t),config=path.join(f.dir,'config');fs.mkdirSync(config);
  const input=path.join(config,'input.conf'),contents='Ctrl+Alt+x show-text "Synthetic protected skip key"\nCtrl+1 show-text "Synthetic protected preset key"\nF9 cycle pause\n';fs.writeFileSync(input,contents);
  const file=process.env.ANIME_PLAYER_TEST_MEDIA||path.join(f.dir,'synthetic.wav');if(!process.env.ANIME_PLAYER_TEST_MEDIA)fs.writeFileSync(file,wave(90));f.ep.sources[0].url=file;
  f.store.setSettings({mpvPath:mpv,defaultPreset:'off',autoplayNext:false,extraArgs:`"--config-dir=${config}" --vo=null --ao=null --pause=yes`});
  const p=new PlayerManager({store:f.store,paths:{userData:f.dir,shaderDir:path.join(__dirname,'../shaders')},notify:()=>{}});t.after(()=>p.stop());await p.play(f.series.id,f.ep.id);await until(()=>p.cur?.shortcutKeys);
  const s=p.cur.session,bindings=await s.request(['get_property','input-bindings']);assert.ok(bindings.some(x=>x.key==='Ctrl+Alt+x'&&!x.is_weak&&x.priority>=0));
  await assert.rejects(p.applyShortcuts({...S.DEFAULTS,skipIntro:'Ctrl+Alt+x'}),/Synthetic protected skip key/);assert.equal(p.cur.shortcutKeys.skipIntro,S.DEFAULTS.skipIntro);
  const shaders=await s.request(['get_property','glsl-shaders']);await s.request(['keypress','Ctrl+1']);assert.deepEqual(await s.request(['get_property','glsl-shaders']),shaders);
  assert.equal(await s.request(['get_property','pause']),true);await s.request(['keypress','F9']);await until(async()=>await s.request(['get_property','pause'])===false);
  assert.equal(fs.readFileSync(input,'utf8'),contents);assert.ok(!s.args.some(x=>x.startsWith('--input-conf=')));await p.stop();
});
