'use strict';
const {app,BrowserWindow,ipcMain}=require('electron'),fs=require('fs'),os=require('os'),path=require('path'),assert=require('node:assert/strict');
const {Store}=require('../src/store'),S=require('../src/playback-shortcuts');
const result=process.argv.find(x=>x.startsWith('--result='))?.slice(9),evidence=process.env.PHASE6_EVIDENCE_DIR;
const dir=process.argv.find(x=>x.startsWith('--profile='))?.slice(10)||fs.mkdtempSync(path.join(os.tmpdir(),'anime-shortcuts-electron-'));app.setPath('userData',dir);app.setPath('sessionData',dir);
let win,store;const cases=[],errors=[],saved=[];let live=false;
const report=body=>fs.writeFileSync(result,JSON.stringify({...body,cases,errors,saved,profile:'temporary synthetic',input:'Electron native sendInputEvent'},null,2));
const timeout=setTimeout(()=>{report({ok:false,error:'Timeout'});app.exit(1);},30000);
app.whenReady().then(async()=>{
  store=new Store(path.join(dir,'library.json'));store.setSettings({language:'it',onboardingComplete:true});
  const h=(ch,fn)=>ipcMain.handle(ch,(_e,...args)=>fn(...args));h('lib:get',()=>store.snapshot());h('presets:list',()=>[]);h('app:version',()=>require('../package.json').version);h('auth:state',()=>({configured:false,connected:false}));h('player:state',()=>({playing:false}));h('series:addTasks',()=>[]);h('organization:context',()=> 'fixture');
  h('settings:shortcuts',raw=>{const keys=S.validate(raw);saved.push(keys);store.setSettings({shortcuts:keys});return {lib:store.snapshot(),applied:live,nextLaunch:!live};});
  win=new BrowserWindow({show:true,width:1160,height:850,webPreferences:{preload:path.join(__dirname,'../preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  h('settings:shortcutCapture',active=>{win.shortcutCaptureActive=active===true;});
  // Exercise the actual production before-input listener, including its capture guard.
  const vm=require('vm'),main=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
  const listener=main.slice(main.indexOf("  win.webContents.on('before-input-event'"),main.indexOf("  win.loadFile("));
  vm.runInNewContext(listener,{win});
  win.webContents.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message);});
  const js=code=>win.webContents.executeJavaScript(code),tick=()=>new Promise(r=>setTimeout(r,25));
  const until=async condition=>{for(let i=0;i<240;i++){if(await js(`Boolean(${condition})`))return;await tick();}throw Error('Missing '+condition);};
  const click=text=>js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`);
  const row=action=>`document.querySelector('[data-shortcut="${action}"]').parentElement`;
  const control=async(action,text)=>{await js(`Array.from(${row(action)}.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(text)}).click()`);if(text==='Modifica')await until(`document.querySelector('[data-shortcut="${action}"]').value==='Premi i tasti…'`);};
  const value=action=>js(`document.querySelector('[data-shortcut="${action}"]').value`);
  const key=(keyCode,modifiers=[])=>{win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});};
  await win.loadFile(path.join(__dirname,'../renderer/index.html'));await until(`document.querySelector('.rail-bottom') || document.querySelectorAll('#rail button').length`);
  await click('Impostazioni');await until(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Scorciatoie di riproduzione')`);await click('Scorciatoie di riproduzione');await until(`document.querySelector('[data-shortcut="skipIntro"]')`);
  assert.equal(await value('skipIntro'),'Ctrl + Shift + o');cases.push('Settings dedicated playback shortcut section and defaults');
  await control('skipIntro','Modifica');key('I',['control','shift']);await until(`document.querySelector('[data-shortcut="skipIntro"]').value==='Ctrl + Shift + i'`);assert.equal(win.webContents.isDevToolsOpened(),false);cases.push('native Ctrl+Shift+i capture preserves uppercase without production DevTools interception');
  await control('skipEnding','Modifica');key('I',['control','shift']);await until(`document.querySelector('[role="status"]').textContent.includes('duplicata')`);assert.equal(await value('skipEnding'),'Premi i tasti…');key('Escape');await until(`document.querySelector('[data-shortcut="skipEnding"]').value==='Ctrl + Shift + e'`);cases.push('duplicate semantic key rejected; Escape restores previous assignment');
  await control('skipIntro','Modifica');key('Space');await until(`document.querySelector('[role="status"]').textContent.includes('Conflitto')`);key('Escape');cases.push('standard mpv conflict rejected');
  await control('skipEnding','Disabilita');assert.equal(await value('skipEnding'),'Disabilitata');await click('Salva');await until(`document.querySelector('[role="status"]').textContent.includes('prossimo avvio')`);assert.equal(saved.at(-1).skipIntro,'Ctrl+I');assert.equal(saved.at(-1).skipEnding,'');cases.push('disable and save with explicit next-launch feedback');
  live=true;await control('skipEnding','Ripristina predefinito');await control('skipIntro','Modifica');key('F8',['control','alt']);await until(`document.querySelector('[data-shortcut="skipIntro"]').value==='Ctrl + Alt + F8'`);await click('Salva');await until(`document.querySelector('[role="status"]').textContent.includes('sessione mpv corrente')`);cases.push('special key capture, default restore and live-application feedback');
  if(evidence){fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(path.join(evidence,'scorciatoie-ui.png'),(await win.webContents.capturePage()).toPNG());}
  await win.reload();await until(`document.querySelectorAll('#rail button').length`);await click('Scorciatoie');await until(`document.querySelector('[data-shortcut="skipIntro"]')`);assert.equal(await value('skipIntro'),'Ctrl + Alt + F8');assert.equal(await value('skipEnding'),'Ctrl + Shift + e');cases.push('reload retains settings without editing content');
  assert.equal(errors.length,0,JSON.stringify(errors));report({ok:true});clearTimeout(timeout);win.destroy();clearTimeout(store._timer);app.exit(0);
}).catch(error=>{report({ok:false,error:error.stack});clearTimeout(timeout);win?.destroy();clearTimeout(store?._timer);app.exit(1);});
