'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),yaml=require('js-yaml'),{EventEmitter}=require('events');
const {ReleaseCatalog,describe}=require('../src/release-catalog'),{MpvDevice}=require('../src/mpv-device'),{UpdateService}=require('../src/updates');
const cap={format:'nsis',installable:true},version='0.5.48',base='https://github.com/Adrotto2008/anime-player/releases/download/v'+version+'/';
const file={url:`AnimePlayer-Setup-${version}.exe`,size:100,sha512:Buffer.alloc(64).toString('base64')};
const raw={tag_name:'v'+version,published_at:'2026-10-12',body:'<script>untrusted</script>',assets:[{name:'latest.yml'},{name:file.url,size:100,browser_download_url:base+file.url}]};
function catalog(extra={}){return new ReleaseCatalog({current:'0.5.50',cap,platform:'win32',arch:'x64',fetch:async url=>url.endsWith('.yml')?yaml.dump({version,files:[file]}):JSON.stringify(url.includes('?')?[raw]:raw),...extra});}
function profile(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'anime-version-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
test('release pagination, direction, legacy, unsupported arch and uncertified downgrade',async()=>{
 const c=catalog(),page=await c.page(2);assert.equal(page.page,2);assert.equal(page.releases[0].direction,'downgrade');assert.equal(page.releases[0].installable,true);await assert.rejects(c.page(0));
 assert.equal(describe({...raw,tag_name:'v0.5.46'},'0.5.50',cap,'win32','x64').legacy,true);
 assert.equal(describe(raw,'0.6.0',cap,'win32','x64').installable,false);assert.equal(describe(raw,'0.5.50',cap,'win32','arm64').installable,false);
 assert.equal(describe({...raw,prerelease:true},'0.5.50',cap),null);
});
test('selected manifest points to exact official release, rejects changed version and missing assets',async()=>{
 const c=catalog(),selected=await c.resolve(version);assert.equal(selected.base,base);assert.equal(selected.info.version,version);
 await assert.rejects(c.resolve('../evil'));
 await assert.rejects(catalog({fetch:async url=>url.endsWith('.yml')?yaml.dump({version:'0.5.49',files:[file]}):JSON.stringify(raw)}).resolve(version));
 await assert.rejects(catalog({fetch:async url=>url.endsWith('.yml')?yaml.dump({version,files:[{...file,url:'https://evil.test/x.exe'}]}):JSON.stringify(raw)}).resolve(version));
 await assert.rejects(catalog({fetch:async url=>url.endsWith('.yml')?yaml.dump({version,files:[file]}):JSON.stringify({...raw,assets:[{name:'latest.yml'}]})}).resolve(version));
});
test('selected downgrade uses release feed, verifies completion, resets latest, pin persists',async t=>{
 const p=profile(t),updater=new EventEmitter(),feeds=[];updater.setFeedURL=f=>feeds.push(f);updater.checkForUpdates=async()=>updater.emit('update-available',{version,files:[file]});updater.downloadUpdate=async()=>updater.emit('update-downloaded',{version,files:[file]});
 const service=new UpdateService({profile:p,app:{getVersion:()=> '0.5.50',quit:()=>{}},cap,updater,verify:()=>{}});service.catalog=catalog();
 await service.select(version);assert.equal(service.state.status,'available');assert.equal(feeds[0].url,base);assert.equal(updater.allowDowngrade,true);await service.download();assert.equal(service.state.status,'downloaded');
 service.change({status:'idle'});await service.check();assert.equal(feeds.at(-1).provider,'github');assert.equal(updater.allowDowngrade,false);
 service.configure({mode:'pinned'});assert.equal(service.preferences.pinnedVersion,'0.5.50');assert.equal(service.preferences.checkAtStartup,false);await assert.rejects(async()=>service.select(version));
 const reopened=new UpdateService({profile:p,app:service.app,cap});assert.equal(reopened.preferences.mode,'pinned');reopened.start();assert.equal(reopened.timer,undefined);
 service.configure({mode:'automatic',popupAtStartup:false});assert.equal(service.preferences.checkAtStartup,true);
});
test('selected manifest changes cannot install',async t=>{
 const updater=new EventEmitter(),service=new UpdateService({profile:profile(t),app:{getVersion:()=> '0.5.50'},cap,updater});updater.setFeedURL=()=>{};service.catalog=catalog();updater.checkForUpdates=async()=>updater.emit('update-available',{version,files:[{...file,size:101}]});await service.select(version);assert.equal(service.state.status,'error');assert.throws(()=>service.download());
});
test('first mpv detection persists, cancellation does not complete, second launch/update revalidates path, missing path repairs',async t=>{
 const p=profile(t),device=new MpvDevice(p);assert.throws(()=>device.complete({ok:false}));assert.equal(fs.existsSync(device.file),false);
 let present=false;const manager={find:async()=>present?{ok:true,path:'synthetic-mpv',version:'0.40.0'}:{ok:false,status:'not-found'},validate:async target=>present?{ok:true,path:target,version:'0.40.0'}:{ok:false,status:'not-found'}};
 assert.equal((await device.inspect(manager,{})).complete,false);present=true;assert.equal((await device.inspect(manager,{})).complete,true);
 const reopened=new MpvDevice(p);assert.equal((await reopened.inspect(manager,{onboardingComplete:false})).ok,true);assert.equal(reopened.data.path,'synthetic-mpv');present=false;const missing=await reopened.inspect(manager,{});assert.equal(missing.ok,false);assert.equal(missing.repair,true);assert.equal(reopened.data.complete,true);
});
test('existing mpv path migrates despite false account onboarding flag and invalid executable cannot complete',async t=>{
 const device=new MpvDevice(profile(t));const manager={validate:async target=>({ok:true,path:target,version:'0.40.0'}),find:async()=>{throw Error('Never replace configured path');}};
 await device.inspect(manager,{mpvPath:'chosen-mpv',onboardingComplete:false});assert.equal(device.data.complete,true);assert.equal(device.data.path,'chosen-mpv');
});
