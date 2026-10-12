'use strict';
const {app}=require('electron'),fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict'),{EventEmitter}=require('events');
const root=path.resolve(__dirname,'..'),arg=n=>process.argv.find(s=>s.startsWith('--'+n+'='))?.split('=').slice(1).join('='),profile=arg('profile'),result=arg('result');
app.setPath('userData',profile);app.setPath('sessionData',path.join(profile,'session'));
let win,store;const cases=[],timer=setTimeout(()=>finish(Error('Timeout')),30000);
function finish(error){clearTimeout(timer);clearTimeout(store?._timer);fs.writeFileSync(result,JSON.stringify({ok:!error,cases,error:error?.stack,electron:process.versions.electron},null,2));win?.destroy();app.exit(error?1:0);}
app.whenReady().then(async()=>{
  const req=require('module').createRequire(path.join(root,'main.js')),{Store}=req('./src/store'),{UpdateService}=req('./src/updates');
  store=new Store(path.join(profile,'library.json'));store.setSettings({language:'it',onboardingComplete:true});store.addSeries({title:'Synthetic preserved series'});store.save(true,true);
  const libraryBytes=fs.readFileSync(store.file),calls=[],updater=new EventEmitter();let playing=true;
  const info={version:'0.5.48',releaseDate:'2026-10-12',releaseNotes:'<img src=x onerror=alert(1)> Changelog sintetico',files:[{url:'AnimePlayer-Setup-0.5.48.exe',size:100,sha512:Buffer.alloc(64).toString('base64')}]};
  updater.checkForUpdates=async()=>updater.emit('update-available',info);updater.downloadUpdate=async()=>{updater.emit('download-progress',{percent:75,total:100,transferred:75,bytesPerSecond:12});updater.emit('update-downloaded',info);};updater.quitAndInstall=()=>calls.push('install');
  const fakeApp={isPackaged:true,requestSingleInstanceLock:()=>true,whenReady:()=>({then:()=>{}}),on:()=>{},quit:()=>calls.push('quit'),getVersion:()=> '0.5.47'};
  const service=new UpdateService({app:fakeApp,profile,cap:{format:'nsis',installable:true},updater,verify:()=>{},isPlaying:()=>playing,notify:s=>win?.webContents.send('updates:state',s)});
  const ctx={require:n=>n==='electron'?{...require('electron'),app:fakeApp,shell:{openExternal:()=>calls.push('external')}}:req(n),__dirname:root,module:{exports:{}},process,console,setTimeout,clearTimeout};
  vm.runInNewContext(fs.readFileSync(path.join(root,'main.js'),'utf8')+'\nmodule.exports.probe=(s,u)=>{store=s;updates=u;player={state:()=>({playing:true})};cloud={getSession:()=>({configured:false,connected:false})};register();createWindow();return win;}',ctx);
  win=ctx.module.exports.probe(store,service);win.setTitle('Anime Player — verifica aggiornamenti, dati sintetici');await new Promise(r=>win.webContents.once('did-finish-load',r));
  const js=code=>win.webContents.executeJavaScript(code),wait=async code=>{for(let n=0;n<100;n++){if(await js(code))return;await new Promise(r=>setTimeout(r,30));}throw Error('Missing UI: '+code);};
  await wait("[...document.querySelectorAll('#rail button')].some(b=>b.textContent.includes('Impostazioni'))");
  await js("[...document.querySelectorAll('#rail button')].find(b=>b.textContent.includes('Impostazioni')).click()");await wait("!!document.querySelector('[data-updates]')");
  await js("document.querySelector('[data-update=check]').click()");await wait("document.querySelector('[data-updates]').textContent.includes('Nuova versione: 0.5.48')");cases.push('production settings view checks through trusted IPC');
  assert.equal(await js("document.querySelector('.update-notes').textContent.includes('<img') && !document.querySelector('.update-notes img')"),true);cases.push('untrusted changelog renders as text');
  await js("document.querySelector('[data-update=download]').click()");await wait("document.querySelector('[data-updates]').textContent.includes('Aggiornamento scaricato')");
  assert.equal(await js("document.querySelector('[data-update=install]').disabled"),true);assert.equal(await js("window.animeApi.invoke('updates:install').then(()=>false).catch(e=>e.message.includes('riproduzione'))"),true);assert.deepEqual(calls,[]);cases.push('downloads while playing; UI and main reject restart');
  const screenshot=arg('screenshot');if(screenshot){await js("document.querySelector('[data-updates]').scrollIntoView({block:'center',behavior:'instant'})");fs.writeFileSync(screenshot,(await req('./test/capture-surface').captureSurface(win)).toPNG());}
  await js("document.querySelector('[data-update=later]').click()");await wait("document.querySelector('[data-update=on-quit]').checked");assert.equal(service.state.installOnQuit,true);cases.push('Later arms installation on voluntary exit without closing mpv');
  await js("document.querySelector('[data-update=on-quit]').click()");await wait("!document.querySelector('[data-update=on-quit]').checked");assert.equal(service.state.installOnQuit,false);
  await js("document.querySelector('[data-update=automatic]').click()");await wait("!document.querySelector('[data-update=automatic]').checked");assert.equal(JSON.parse(fs.readFileSync(service.file)).checkAtStartup,false);assert.deepEqual(fs.readFileSync(store.file),libraryBytes);cases.push('global preferences persist without rewriting library');
  assert.equal(await js("window.animeApi.invoke('updates:configure',{checkAtStartup:true,url:'https://evil.test'}).then(()=>false).catch(()=>true)"),true);cases.push('renderer cannot override official feed');
  playing=false;service.change({});await wait("!document.querySelector('[data-update=install]').disabled");await js("document.querySelector('[data-update=install]').click()");await wait("document.querySelector('[data-updates]').textContent.includes('Salvataggio e riavvio')");assert.deepEqual(calls,['quit']);cases.push('explicit restart waits for existing shutdown; installer not executed by IPC');
  await win.webContents.loadURL('data:text/html,untrusted');assert.equal(await js("window.animeApi.invoke('updates:state').then(()=>false).catch(e=>e.message.includes('non autorizzato'))"),true);cases.push('production update IPC rejects untrusted document');
  finish();
}).catch(finish);
