'use strict';
// Real Electron DOM/input test, isolated Store and IPC fixtures. No account or provider requests.
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { Store } = require('../src/store');
const resultFile = process.argv.find(arg=>arg.startsWith('--result='))?.slice(9);
const baselineRenderer = process.argv.find(arg=>arg.startsWith('--baseline-renderer='))?.slice(20);
const dir = fs.mkdtempSync(path.join(resultFile ? path.dirname(resultFile) : os.tmpdir(),'anime-player-renderer-'));
app.setPath('userData', dir);
let win; const errors = [];
const report = value => { if(resultFile) fs.writeFileSync(resultFile, JSON.stringify(value,null,2)); };
const timeout = setTimeout(() => { report({ok:false,error:'Electron regression timeout'}); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  const store = new Store(path.join(dir,'library.json'));
  store.setSettings({language:'en',onboardingComplete:true});
  const records = [store.addSeries({ title:'Saga', franchiseId:'group', franchiseType:'season', franchiseOrder:1 }),
    store.addSeries({ title:'Saga Season 2', franchiseId:'group', franchiseType:'season', franchiseOrder:2 }),
    store.addSeries({ title:'Standalone' }), store.addSeries({ title:'Survivor' })];
  const handle=(ch,fn)=>ipcMain.handle(ch,(_e,...args)=>fn(...args));
  handle('lib:get',()=>store.snapshot()); handle('presets:list',()=>[]); handle('app:version',()=>app.getVersion());
  handle('player:state',()=>({playing:false})); handle('auth:state',()=>({connected:false,configured:false}));
  let failDeleteOnce=!baselineRenderer;
  handle('series:ratings',()=>store.snapshot()); handle('series:delete',(id)=>{if(failDeleteOnce){failDeleteOnce=false;throw new Error('Deletion failed (IPC fixture)');}store.deleteSeries(id);return store.snapshot();});
  handle('series:search',text=>[{anilistId:195604,title:'Black Clover Season 2',format:'TV'}]);
  const chart={imdbId:'tt7441658',title:'Black Clover',maxEpisodes:1,seasons:[{season:2,episodes:[{number:1,id:'tt9150376',title:"Whoever's Strongest Wins",rating:7.8}]},{season:5,episodes:[{number:1,id:'tt46662871',title:'The Battle Begins',rating:9.4}]}]};
  handle('series:create',()=>{
    const base=store.addSeries({title:'Black Clover',anilistId:97940,episodeCount:170,franchiseId:'black',franchiseType:'season',franchiseOrder:1,franchiseTitle:'Black Clover',imdbChart:chart});
    const s=store.addSeries({title:'Black Clover Season 2',anilistId:195604,franchiseId:'black',franchiseType:'season',imdbChart:chart});
    const ep=store.ensureEpisode(s,1);ep.duration=1380;ep.durationSource='Kitsu';
    ep.thumb='https://example.test/shared-thumbnail.jpg';
    store.ensureEpisode(s,2).thumb=ep.thumb;
    const first=store.ensureEpisode(base,52);first.duration=1380;first.progress.duration=2460;
    return {id:s.id,lib:store.snapshot(),franchiseId:'black',franchiseCount:2};
  });
  win = new BrowserWindow({show:false,webPreferences:{preload:path.join(__dirname,'../preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  win.webContents.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message)});
  store.on('changed',()=>win.webContents.send('lib:changed',store.snapshot()));
  await win.loadFile(baselineRenderer ? path.join(baselineRenderer,'index.html') : path.join(__dirname,'../renderer/index.html'));
  if(baselineRenderer){
    win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Page.enable');
    win.webContents.debugger.on('message',(_e,method)=>{if(method==='Page.javascriptDialogOpening')win.webContents.debugger.sendCommand('Page.handleJavaScriptDialog',{accept:true}).catch(error=>report({ok:false,phase:'native-dialog',error:error.message}));});
  }
  const js=code=>win.webContents.executeJavaScript(code);
  const tick=()=>new Promise(resolve=>setTimeout(resolve,80));
  await tick();
  await js(`document.querySelector('#dialog-root .scrim .icon-btn')?.click()`);
  // Exercise a real keyboard event immediately after each deletion, including the last child.
  for (const record of records.slice(0,3)) {
    await js(`Array.from(document.querySelectorAll('button')).find(x=>x.classList.contains('franchise-poster'))?.click()`);
    await js(`Array.from(document.querySelectorAll('button.poster')).find(x=>x.textContent.includes(${JSON.stringify(record.title)}))?.click()`);
    await tick();
    await js(`document.querySelector('.actions .danger').click()`);
    if(!baselineRenderer){
      assert.strictEqual(await js(`document.querySelectorAll('#dialog-root .scrim').length`),1);
      await js(`document.querySelector('#dialog-root .foot .danger').click()`);
      if(record===records[0]){
        await tick();assert.ok(store.getSeries(record.id));
        assert.strictEqual(await js(`document.querySelector('#dialog-root .foot .danger').disabled`),false);
        await js(`document.querySelector('#dialog-root .foot .btn').click()`);await tick();
        assert.strictEqual(await js(`document.querySelectorAll('#dialog-root .scrim').length`),0);
        await js(`document.querySelector('.actions .danger').click()`);
        await js(`document.querySelector('#dialog-root .foot .danger').click()`);
      }
    }
    await tick();
    assert.strictEqual(store.getSeries(record.id),undefined);
    assert.strictEqual(await js(`document.querySelectorAll('#dialog-root .scrim').length`),0);
    await js(`document.querySelector('.search').focus()`);
    win.webContents.sendInputEvent({type:'char',keyCode:'S'});
    await tick();
    assert.strictEqual(await js(`document.querySelector('.search').value`),'S');
    await js(`document.querySelector('.search').value='';document.querySelector('.search').dispatchEvent(new Event('input',{bubbles:true}))`);
    await tick();
  }
  // Search in the add dialog also accepts a keyboard event, and opens the selected ID.
  await js(`Array.from(document.querySelectorAll('button')).find(x=>x.textContent.trim()==='Add series').click()`);
  await js(`document.querySelector('#dialog-root input').focus()`);win.webContents.sendInputEvent({type:'char',keyCode:'B'});await tick();
  assert.strictEqual(await js(`document.querySelector('#dialog-root input').value`),'B');
  await js(`Array.from(document.querySelectorAll('#dialog-root button')).find(x=>x.textContent==='Search').click()`);await tick();
  await js(`document.querySelector('#dialog-root .res button').click()`);await tick();
  if(baselineRenderer){
    report({ok:true,baseline:true,deletionInputResponsive:true,selectedTitle:await js(`document.querySelector('.hero h1').textContent`),expectedTitle:'Black Clover Season 2',errors});
    clearTimeout(store._timer);clearTimeout(timeout);win.destroy();app.exit(0);return;
  }
  assert.strictEqual(await js(`document.querySelector('.hero h1').textContent`),'Black Clover Season 2');
  assert.strictEqual(await js(`Array.from(document.querySelectorAll('.eps .th')).filter(el=>el.style.backgroundImage.includes('shared-thumbnail.jpg')).length`),2,'shared episode thumbnails must both remain visible');
  assert.ok((await js(`document.querySelector('.ep-info').textContent`)).includes('metadata'),'metadata duration must be labeled');
  await js(`Array.from(document.querySelectorAll('.actions button')).find(x=>x.textContent.includes(window.i18n.t('ratingsChart'))).click()`);await tick();
  await js(`document.querySelector('.ratings-cell[title^="S2 E1:"]').click()`);await tick();
  assert.strictEqual(await js(`document.querySelector('.hero h1').textContent`),'Black Clover');
  assert.ok((await js(`document.querySelector('.ep-info').textContent`)).includes('41 min'),'measured duration must override metadata');
  assert.ok(!(await js(`document.querySelector('.ep-info').textContent`)).includes('metadata'));
  await js(`Array.from(document.querySelectorAll('.actions button')).find(x=>x.textContent.includes(window.i18n.t('ratingsChart'))).click()`);await tick();
  await js(`document.querySelector('.ratings-cell[title^="S5 E1:"]').click()`);await tick();
  assert.strictEqual(await js(`document.querySelector('.hero h1').textContent`),'Black Clover Season 2');
  assert.deepStrictEqual(errors,[]);
  report({ok:true,cases:['season deletion','last season deletion','standalone deletion','failed deletion and cancel','immediate keyboard input','AniList search','selected record navigation','IMDb global and sequel navigation','measured versus metadata duration'],errors});
  console.log('Electron Windows: deletion of season, last season, standalone; immediate keyboard/library/AniList search and selected record verified.');
  clearTimeout(store._timer); clearTimeout(timeout); win.destroy(); app.exit(0);
}).catch(error=>{report({ok:false,error:error.stack});console.error(error);clearTimeout(timeout);if(win)win.destroy();app.exit(1);});
