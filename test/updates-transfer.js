'use strict';
// Real electron-updater HTTP download and SHA-512 validation; inert fixture bytes only.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),http=require('http'),crypto=require('crypto'),yaml=require('js-yaml');
const {NsisUpdater}=require('electron-updater'),{NodeHttpExecutor}=require('builder-util/out/nodeHttpExecutor'),{UpdateService}=require('../src/updates');
for(const corrupted of [false,true])test('real updater '+(corrupted?'rejects corrupt transfer':'downloads and validates transfer'),async t=>{
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'anime-update-transfer-'));const bytes=Buffer.alloc(1024*256,42);
  const info={version:'0.5.48',files:[{url:'AnimePlayer-Setup-0.5.48.exe',size:bytes.length,sha512:crypto.createHash('sha512').update(bytes).digest('base64')}],path:'AnimePlayer-Setup-0.5.48.exe',sha512:crypto.createHash('sha512').update(bytes).digest('base64')};
  const server=http.createServer((req,res)=>{if(req.url.startsWith('/latest.yml')){res.end(yaml.dump(info));}else{res.setHeader('Content-Length',bytes.length);res.end(corrupted?Buffer.alloc(bytes.length,7):bytes);}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(profile,{recursive:true,force:true});});
  const config=path.join(profile,'app-update.yml');fs.writeFileSync(config,yaml.dump({updaterCacheDirName:'test-update-cache'}));
  const adapter={version:'0.5.47',name:'Anime Player test',isPackaged:true,userDataPath:profile,baseCachePath:profile,appUpdateConfigPath:config,whenReady:async()=>{},onQuit:()=>{throw Error('automatic install hook forbidden');},quit:()=>{throw Error('fixture installer must never execute');}};
  const updater=new NsisUpdater(null,adapter);updater.httpExecutor=new NodeHttpExecutor();
  // Reuse the real stream/checksum downloader with Node HTTP transport for this isolated harness.
  updater.httpExecutor.download=require('electron-updater/out/electronHttpExecutor').ElectronHttpExecutor.prototype.download;
  updater.setFeedURL({provider:'generic',url:'http://127.0.0.1:'+server.address().port});updater.disableDifferentialDownload=true;
  let transferError;updater.on('error',e=>transferError=e);
  const service=new UpdateService({app:{getVersion:()=>adapter.version,quit:()=>{throw Error('No install');}},profile,cap:{format:'nsis',installable:true},updater});
  await service.check();assert.equal(service.state.status,'available',transferError?.stack);await service.download();
  assert.equal(service.state.status,corrupted?'error':'downloaded',transferError?.stack || service.state.error);
  if(!corrupted){assert.deepEqual(fs.readFileSync(updater.installerPath),bytes);assert.ok(service.state.progress?.transferred>0);require('../src/updates').verifyDownloaded(updater);fs.writeFileSync(updater.installerPath,'tampered cached installer');assert.throws(()=>service.install(),/Integrità/);assert.equal(service.state.status,'error');await service.download();assert.equal(service.state.status,'downloaded');assert.deepEqual(fs.readFileSync(updater.installerPath),bytes);}else {assert.match(transferError?.message,/checksum/i);assert.throws(()=>service.install());}
});
