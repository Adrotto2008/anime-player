'use strict';
// Real Electron DOM/input test, isolated Store and IPC fixtures. No account or provider requests.
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { Store } = require('../src/store');
const resultFile = process.argv.find(arg=>arg.startsWith('--result='))?.slice(9);
const baselineRenderer = process.argv.find(arg=>arg.startsWith('--baseline-renderer='))?.slice(20);
const screenshotDir = process.argv.find(arg=>arg.startsWith('--screenshots='))?.slice(14);
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
  const fallbackChoices = [];
  handle('series:videoPreference',(id,mode)=>{store.setVideoPreference(id,mode);return store.snapshot()});
  handle('player:languageFallback',(token,mode)=>{fallbackChoices.push({token,mode});return true});
  handle('episodes:sourceLanguage',(sid,eid,url,mode)=>{store.setSourceLanguage(sid,eid,url,mode);return store.snapshot()});
  handle('episodes:setSources',(sid,eid,urls)=>{store.setSources(sid,eid,urls);return store.snapshot()});
  handle('episodes:checkSources',urls=>urls.map(()=>({status:'unknown'})));
  handle('franchise:update',(id,patch)=>{store.updateFranchise(id,patch);return store.snapshot()});
  handle('franchise:member',(sid,patch)=>{store.setMembership(sid,patch);return store.snapshot()});
  handle('franchise:reorder',(id,ids)=>{store.reorderFranchise(id,ids);return store.snapshot()});
  handle('franchise:mergePreview',(a,b)=>store.previewFranchiseMerge(a,b));
  handle('franchise:merge',(a,b,options)=>{store.mergeFranchises(a,b,options);return store.snapshot()});
  handle('franchise:delete',id=>{store.deleteFranchise(id);return store.snapshot()});
  handle('franchise:discover',()=>({lib:store.snapshot()}));
  handle('series:discoverSources',id=>{store.addContentSources(id,[{number:1,url:'https://film.test/full.mp4',provider:'animeworld',providerEpisodeId:'film',providerSourceId:'file',resolutionState:'resolved',language:{audio:'it',origin:'provider',confidence:'declared'}}]);return{lib:store.snapshot(),sourceDiscovery:{episodesFound:1,episodesAdded:1,providers:{animeworld:{status:'found'}}}}});
  handle('content:addLink',(id,options)=>{store.addContentSources(id,[{number:options.partNumber,url:options.url}]);return store.snapshot()});
  let failDeleteOnce=!baselineRenderer;
  handle('series:ratings',()=>store.snapshot()); handle('series:delete',(id)=>{if(failDeleteOnce){failDeleteOnce=false;throw new Error('Deletion failed (IPC fixture)');}store.deleteSeries(id);return store.snapshot();});
  handle('series:search',text=>text==='new film'?[{anilistId:700,title:'Added film',format:'MOVIE'}]:[{anilistId:195604,title:'Black Clover Season 2',format:'TV'}]);
  const chart={imdbId:'tt7441658',title:'Black Clover',maxEpisodes:1,seasons:[{season:2,episodes:[{number:1,id:'tt9150376',title:"Whoever's Strongest Wins",rating:7.8}]},{season:5,episodes:[{number:1,id:'tt46662871',title:'The Battle Begins',rating:9.4}]}]};
  handle('series:create',payload=>{
    if(payload.franchiseId){const s=store.addSeries({title:payload.anilistId===195604?'Added season':'Added film',anilistId:payload.anilistId,
      format:payload.anilistId===195604?'TV':'MOVIE'});store.setMembership(s.id,{franchiseId:payload.franchiseId,category:payload.category});return{id:s.id,lib:store.snapshot()};}
    const base=store.addSeries({title:'Black Clover',anilistId:97940,episodeCount:170,franchiseId:'black',franchiseType:'season',franchiseOrder:1,franchiseTitle:'Black Clover',imdbChart:chart});
    const s=store.addSeries({title:'Black Clover Season 2',anilistId:195604,franchiseId:'black',franchiseType:'season',imdbChart:chart});
    const ep=store.ensureEpisode(s,1);ep.duration=1380;ep.durationSource='Kitsu';
    ep.thumb='https://example.test/shared-thumbnail.jpg';
    store.ensureEpisode(s,2).thumb=ep.thumb;
    store.addSources(s.id,[{number:1,url:'https://media.test/ita.mp4',provider:'animeworld',resolutionState:'resolved',language:{audio:'it',subtitles:null,origin:'provider',confidence:'declared'}},
      {number:2,url:'https://media.test/embed',provider:'animeunity',resolutionState:'found',language:{audio:'ja',subtitles:'it',origin:'provider',confidence:'suggested'}},
      {number:1,url:'https://manual.test/Ep_01.mp4',mediaTracks:{audio:[{id:1,lang:null}],subtitles:[],checkedAt:Date.now(),origin:'mpv'}}]);
    const first=store.ensureEpisode(base,52);first.duration=1380;first.progress.duration=2460;
    return {id:s.id,lib:store.snapshot(),franchiseId:'black',franchiseCount:2};
  });
  win = new BrowserWindow({show:false,webPreferences:{preload:path.join(__dirname,'../preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:!screenshotDir}});
  win.webContents.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message)});
  store.on('changed',()=>win.webContents.send('lib:changed',store.snapshot()));
  await win.loadFile(baselineRenderer ? path.join(baselineRenderer,'index.html') : path.join(__dirname,'../renderer/index.html'));
  if(baselineRenderer){
    win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Page.enable');
    win.webContents.debugger.on('message',(_e,method)=>{if(method==='Page.javascriptDialogOpening')win.webContents.debugger.sendCommand('Page.handleJavaScriptDialog',{accept:true}).catch(error=>report({ok:false,phase:'native-dialog',error:error.message}));});
  }
  const js=async code=>{try{return await win.webContents.executeJavaScript(code);}catch(error){throw new Error(`Renderer script: ${code}\n${errors.join('\n')}\n${error.message}`);}};
  const tick=()=>new Promise(resolve=>setTimeout(resolve,80));
  const capture=async name=>{if(screenshotDir){await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');fs.mkdirSync(screenshotDir,{recursive:true});fs.writeFileSync(path.join(screenshotDir,name+'.png'),(await win.webContents.capturePage()).toPNG());}};
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
  assert.strictEqual(await js(`document.querySelector('#video-version').value`),'auto');
  assert.ok((await js(`document.querySelector('#video-version option[value="it"]').textContent`)).includes('1 episodes'));
  assert.ok((await js(`document.querySelector('#video-version option[value="ja-sub-it"]').textContent`)).includes('not found'),'unresolved embed does not count as language availability');
  await js(`document.querySelector('#video-version').focus()`);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Down'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Down'});await tick();
  const chosen = store.data.series.find(item=>item.anilistId === 195604);
  assert.strictEqual(chosen.videoPreference.mode,'it','native keyboard selector persists the season preference');
  await js(`document.querySelector('.ep .acts .menu-btn').click(); document.querySelector('.menu-item').click()`);await tick();
  assert.strictEqual(await js(`document.querySelector('#dialog-root select').value`),'unknown','observed untagged audio does not imply manual classification');
  assert.ok((await js(`document.querySelector('#dialog-root .dialog-body').textContent`)).includes('Audio: ?'));
  await js(`const languageSelect=document.querySelector('#dialog-root select');languageSelect.value='it';languageSelect.dispatchEvent(new Event('change'))`);await tick();
  await js(`document.querySelector('#dialog-root .foot .primary').click()`);await tick();
  assert.strictEqual(chosen.episodes[0].sources.find(source=>!source.provider).language.origin,'manual');
  win.webContents.send('player:language-fallback',{token:'cancel-fixture',choices:['ja-sub-it'],requested:'it'});await tick();
  assert.strictEqual(fallbackChoices.length,0,'showing alternatives is not consent');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await tick();
  assert.deepStrictEqual(fallbackChoices,[{token:'cancel-fixture',mode:null}]);
  win.webContents.send('player:language-fallback',{token:'accept-fixture',choices:['ja-sub-it'],requested:'it'});await tick();
  await js(`document.querySelector('[data-video-choice="ja-sub-it"]').click()`);await tick();
  assert.deepStrictEqual(fallbackChoices[1],{token:'accept-fixture',mode:'ja-sub-it'});
  await js(`Array.from(document.querySelectorAll('.actions button')).find(x=>x.textContent.includes(window.i18n.t('ratingsChart'))).click()`);await tick();
  await js(`document.querySelector('.ratings-cell[title^="S2 E1:"]').click()`);await tick();
  assert.strictEqual(await js(`document.querySelector('.hero h1').textContent`),'Black Clover');
  assert.ok((await js(`document.querySelector('.ep-info').textContent`)).includes('41 min'),'measured duration must override metadata');
  assert.ok(!(await js(`document.querySelector('.ep-info').textContent`)).includes('metadata'));
  await js(`Array.from(document.querySelectorAll('.actions button')).find(x=>x.textContent.includes(window.i18n.t('ratingsChart'))).click()`);await tick();
  await js(`document.querySelector('.ratings-cell[title^="S5 E1:"]').click()`);await tick();
  assert.strictEqual(await js(`document.querySelector('.hero h1').textContent`),'Black Clover Season 2');
  assert.strictEqual(await js(`document.querySelector('#video-version').value`),'it','returning to season restores its preference');
  const legacy = require('./onepiece-franchise.fixture.json').records.filter(s => [167404,21,459].includes(s.anilistId))
    .map(s => ({...s,id:`legacy-${s.anilistId}`,episodes:[],franchiseId:'167404',franchiseTitle:'MONSTERS: 103 Mercies Dragon Damnation',
      franchiseType:s.format==='MOVIE'?'movie':'season',franchiseOrder:s.anilistId===167404?1:s.anilistId===21?2:null}));
  store.importData({settings:store.data.settings,series:legacy}); await tick();
  await js(`Array.from(document.querySelectorAll('#rail button')).find(x=>x.textContent.includes(window.i18n.t('library'))).click()`);await tick();
  assert.strictEqual(await js(`document.querySelector('.franchise-poster .t').textContent`),'ONE PIECE');
  await js(`document.querySelector('.franchise-poster').click()`);await tick();
  assert.strictEqual(await js(`document.querySelector('.hero h1').textContent`),'ONE PIECE');
  assert.deepStrictEqual(await js(`Array.from(document.querySelectorAll('[data-franchise-category="season"] .franchise-child .t')).map(x=>x.textContent)`),['ONE PIECE'],
    'the one-shot must not appear among the series seasons');
  await js(`document.querySelector('.back').click()`);await tick();
  await js(`Array.from(document.querySelectorAll('button.poster')).find(x=>x.textContent.includes('MONSTERS')).click()`);await tick();
  assert.strictEqual(await js(`document.querySelector('.hero h1').textContent`),'MONSTERS: 103 Mercies Dragon Damnation');
  // Managed group actions use the same renderer, with isolated IPC/store fixtures.
  const groupId='21';
  const openGroup=async()=>{
    await js(`Array.from(document.querySelectorAll('#rail button')).find(x=>x.textContent.includes(window.i18n.t('library'))).click()`);await tick();
    await js(`Array.from(document.querySelectorAll('.franchise-poster')).find(x=>x.textContent.includes('ONE PIECE') || x.textContent.includes('My display title')).click()`);await tick();
  };
  const groupAction=async key=>{
    const menuAfter=await js(`document.querySelector('.franchise-page .menu-btn').click();Array.from(document.querySelectorAll('.menu-item')).map(x=>x.textContent)`);
    win.webContents.send('lib:changed',store.snapshot());await tick();
    assert.ok(await js(`!!document.querySelector('.menu')`),`Franchise menu closed after click: ${menuAfter.join(', ')}`);
    await js(`Array.from(document.querySelectorAll('.menu-item')).find(x=>x.textContent.includes(window.i18n.t(${JSON.stringify(key)}))).click()`);await tick();
  };
  await openGroup();
  assert.strictEqual(await js(`document.querySelectorAll('[data-franchise-category="special"],[data-franchise-category="spinoff"],[data-franchise-category="other"]').length`),0,'empty category sections consume no space');
  await groupAction('editFranchise');
  await js(`document.querySelector('#dialog-root input').value='My display title';document.querySelector('#dialog-root .foot .primary').click()`);await tick();
  assert.strictEqual(await js(`document.querySelector('.hero h1').textContent`),'My display title');
  assert.ok(store.getFranchise(groupId).custom.title);
  await groupAction('deleteFranchise');
  const warning=await js(`document.querySelector('#dialog-root').textContent`);
  assert.ok(warning.includes('My display title') && warning.includes('seasons') && warning.includes('movies') && warning.includes('local links'));
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await tick();
  assert.strictEqual(store.franchiseMembers(groupId).length,2,'cancel does not remove any member');
  await groupAction('addContent');
  await js(`document.querySelector('#dialog-root select[aria-label="'+window.i18n.t('contentCategory')+'"]').value='season';document.querySelector('#dialog-root input').value='new season';Array.from(document.querySelectorAll('#dialog-root button')).find(x=>x.textContent===window.i18n.t('search')).click()`);await tick();
  await js(`document.querySelector('#dialog-root .res .primary').click()`);await tick();
  assert.strictEqual(await js(`document.querySelector('.hero h1').textContent`),'Added season');
  const addedMember=store.data.series.find(s=>s.title==='Added season');assert.strictEqual(addedMember.franchiseId,groupId);
  await js(`Array.from(document.querySelectorAll('.actions button')).find(x=>x.textContent.includes(window.i18n.t('manageContent'))).click()`);await tick();
  await js(`document.querySelector('#dialog-root select[aria-label="'+window.i18n.t('contentCategory')+'"]').value='spinoff';document.querySelector('#dialog-root .foot .primary').click()`);await tick();
  assert.strictEqual(addedMember.franchiseType,'spinoff');
  await openGroup();assert.strictEqual(await js(`document.querySelectorAll('[data-franchise-category="spinoff"] .franchise-child').length`),1);
  await capture('franchise');
  await js(`document.querySelector('[data-franchise-category="movie"] .franchise-child').click()`);await tick();
  assert.ok(await js(`!!document.querySelector('#video-version')`),'film exposes video versions');
  await js(`Array.from(document.querySelectorAll('.actions button')).find(x=>x.textContent.includes(window.i18n.t('discoverLinks'))).click()`);await tick();
  assert.strictEqual(store.getSeries('legacy-459').episodes.length,0);
  assert.strictEqual(await js(`document.querySelectorAll('.content-parts [data-part-id]').length`),1);
  await js(`Array.from(document.querySelectorAll('.actions button')).find(x=>x.textContent.includes(window.i18n.t('contentLink'))).click()`);await tick();
  await js(`document.querySelector('#dialog-root input[type="url"]').value='https://manual.test/film.mp4';document.querySelector('#dialog-root .foot .primary').click()`);await tick();
  assert.ok(store.getSeries('legacy-459').mediaParts[0].sources.some(s=>s.url==='https://manual.test/film.mp4'));
  await capture('film');
  await openGroup();await groupAction('addContent');
  await js(`document.querySelector('#dialog-root select[aria-label="'+window.i18n.t('contentCategory')+'"]').value='movie';document.querySelector('#dialog-root input').value='new film';Array.from(document.querySelectorAll('#dialog-root button')).find(x=>x.textContent===window.i18n.t('search')).click()`);await tick();
  await js(`document.querySelector('#dialog-root .res .primary').click()`);await tick();
  assert.strictEqual(await js(`document.querySelector('.hero h1').textContent`),'Added film');
  assert.strictEqual(store.data.series.find(s=>s.anilistId===700).franchiseType,'movie');
  const destination=store.ensureFranchise({title:'Merge destination'});
  const destinationMember=store.addSeries({title:'Destination season'});store.setMembership(destinationMember.id,{franchiseId:destination.id});
  const duplicateUi=store.addSeries({title:'Saved duplicate',anilistId:21});store.setMembership(duplicateUi.id,{franchiseId:destination.id});
  store.save(true);await tick();await openGroup();await groupAction('mergeFranchises');
  await js(`document.querySelector('#dialog-root select').value=${JSON.stringify(destination.id)};Array.from(document.querySelectorAll('#dialog-root button')).find(x=>x.textContent===window.i18n.t('mergePreview')).click()`);await tick();
  assert.ok((await js(`document.querySelector('.merge-preview').textContent`)).includes('My display title'));
  assert.strictEqual(await js(`document.querySelector('#dialog-root .foot .primary').disabled`),true,'duplicate merge requires an explicit preservation choice');
  await js(`document.querySelector('.merge-preview input[type="checkbox"]').click()`);await tick();
  await js(`document.querySelector('#dialog-root .foot .primary').click()`);await tick();
  assert.strictEqual(await js(`document.querySelector('.hero h1').textContent`),'Merge destination');assert.strictEqual(store.getFranchise(groupId),undefined);
  assert.ok(store.getSeries('legacy-21') && store.getSeries(duplicateUi.id),'both duplicate records remain');
  assert.strictEqual(store.getSeries('legacy-21').franchiseId,null,'duplicate from the source group remains standalone');
  await groupAction('deleteFranchise');await js(`document.querySelector('#dialog-root .foot .danger').click()`);await tick();
  assert.strictEqual(store.getFranchise(destination.id),undefined);assert.ok(store.getSeries('legacy-167404'),'standalone Monsters survives group deletion');
  // A native keyboard event immediately after group deletion must reach search.
  await js(`(document.querySelector('.library-search input') || document.querySelector('input[placeholder="'+window.i18n.t('filterLibrary')+'"]').focus())`);
  win.webContents.sendInputEvent({type:'char',keyCode:'m'});await tick();
  assert.ok((await js(`document.querySelector('input[placeholder="'+window.i18n.t('filterLibrary')+'"]').value`)).includes('m'));
  assert.deepStrictEqual(errors,[]);
  report({ok:true,cases:['season deletion','last season deletion','standalone deletion','failed deletion and cancel','immediate keyboard input','AniList search','selected record navigation','IMDb global and sequel navigation','measured versus metadata duration','keyboard language preference and restoration','resolved language availability','manual classification versus observed tags','explicit fallback consent and Escape cancellation','repaired One Piece group title and seasons','saved Monsters standalone navigation','empty categories hidden','manual franchise title','franchise deletion warning and Escape cancellation','management menu survives background saves','manual season attachment and reclassification','manual film attachment and links','film sources and video preference without synthetic episodes','franchise merge preview with explicit duplicate preservation','complete group deletion and immediate keyboard search'],errors});
  console.log('Electron Windows: deletion/input/search/navigation/thumbnails; keyboard version selector, availability, explicit fallback approval and Escape cancellation verified.');
  clearTimeout(store._timer); clearTimeout(timeout); win.destroy(); app.exit(0);
}).catch(error=>{report({ok:false,error:error.stack});console.error(error);clearTimeout(timeout);if(win)win.destroy();app.exit(1);});
