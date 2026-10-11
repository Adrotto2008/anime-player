'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),os=require('os');
const {app,BrowserWindow,ipcMain}=require('electron');const {Store}=require('../src/store');const {createRatingsService}=require('../src/ratings-service');
const resultFile=process.argv.find(x=>x.startsWith('--result='))?.slice(9),source=path.join(__dirname,'..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'anime-imdb-dom-'));app.setPath('userData',temp);let win,store,service;const cases=[],errors=[];
const report=value=>fs.writeFileSync(resultFile,JSON.stringify(value,null,2));const timeout=setTimeout(()=>{report({ok:false,error:'IMDb DOM timeout',cases,errors});app.exit(1);},30000);
const tick=()=>new Promise(r=>setTimeout(r,60));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
app.whenReady().then(async()=>{
  store=new Store(path.join(temp,'library.json'));store.setSettings({language:'en',onboardingComplete:true});
  const series=store.addSeries({title:'One Piece',year:null,format:'TV',episodeCount:2});store.ensureEpisode(series,1);store.ensureEpisode(series,2);
  let gate=deferred(),requests=0;const client={load:async(_options,{onProgress})=>{requests++;onProgress({phase:'loading',fetched:250,total:1200});return gate.promise;}};
  service=createRatingsService({store,client,notify:p=>{if(p.status && p.status!=='loading')win.webContents.send('lib:changed',store.snapshot());win.webContents.send('series:ratingsProgress',p);}});
  for(const [ch,fn] of Object.entries({'lib:get':()=>store.snapshot(),'presets:list':()=>[],'app:version':()=> 'fixture','player:state':()=>({playing:false}),'auth:state':()=>({connected:true}),'profile:mine':()=>null,'series:ratings':(id,options)=>service.load(id,options),'series:imdbSelect':(id,imdbId)=>service.select(id,imdbId)}))ipcMain.handle(ch,(_e,...args)=>fn(...args));
  fs.cpSync(path.join(source,'renderer'),path.join(temp,'renderer'),{recursive:true});fs.cpSync(path.join(source,'src'),path.join(temp,'src'),{recursive:true});
  const file=path.join(temp,'renderer/app.js');fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('/* ---------- avvio ---------- */','window.ratingsTest={state,go,render,loadSeriesRatings,ratingsChartView};\n/* ---------- avvio ---------- */'));
  win=new BrowserWindow({show:false,width:1180,height:760,webPreferences:{preload:path.join(source,'preload.js'),sandbox:true,contextIsolation:true,backgroundThrottling:false}});
  win.webContents.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message);});
  await win.loadFile(path.join(temp,'renderer/index.html'));await tick();const js=code=>win.webContents.executeJavaScript(code);
  const capture=async name=>{await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');fs.writeFileSync(path.join(path.dirname(resultFile),name),(await win.webContents.capturePage()).toPNG());};
  await js(`ratingsTest.go({name:'ratings-chart',id:${JSON.stringify(series.id)}})`);await tick();
  assert.equal(await js(`document.querySelector('.ratings-status').dataset.status`),'loading');assert.equal(await js(`document.querySelector('.ratings-status button').disabled`),true);assert.match(await js(`document.querySelector('.ratings-status').textContent`),/250.*1200/);
  for(let i=0;i<4;i++){await js(`ratingsTest.go({name:'home'});ratingsTest.go({name:'ratings-chart',id:${JSON.stringify(series.id)}})`);}
  assert.equal(requests,1);cases.push('navigation/open-close while loading deduplicates requests and shows progress');
  await js(`ratingsTest.go({name:'home'})`);gate.resolve({status:'ambiguous',candidates:[{id:'tt0388629',title:'One Piece',year:1999,type:'tvSeries',cast:'Mayumi Tanaka'},{id:'tt11737520',title:'One Piece',year:2023,type:'tvSeries',cast:'Iñaki Godoy'}]});await tick();
  assert.equal(await js(`ratingsTest.state.view.name`),'home');await js(`ratingsTest.go({name:'ratings-chart',id:${JSON.stringify(series.id)}})`);await tick();assert.equal(requests,1);
  assert.equal(await js(`document.querySelectorAll('.imdb-choice').length`),2);assert.match(await js(`document.querySelector('.imdb-choices').textContent`),/1999.*2023/s);cases.push('ambiguity ends loading; choices show IDs/year/type/cast after navigation');
  await capture('phase-2c-choice.png');
  const chart={imdbId:'tt0388629',title:'One Piece',complete:true,totalEpisodes:3,fetchedEpisodes:3,seasons:[{season:0,episodes:[{id:'tt10',number:1,title:'Special',rating:7}]},{season:1,episodes:[{id:'tt11',number:1,title:'First',rating:8},{id:'tt12',number:2,title:'Unrated',rating:null}]}]};
  gate=deferred();await js(`document.querySelector('.imdb-choice').click()`);await tick();assert.equal(series.imdbId,'tt0388629');gate.resolve({status:'ready',chart,complete:true});await tick();
  assert.equal(await js(`document.querySelector('.ratings-status').dataset.status`),'ready');assert.match(await js(`document.querySelector('.ratings-matrix thead').textContent`),/S0/);assert.equal(await js(`document.querySelector('.ratings-cell.unrated').textContent`),'—');assert.match(await js(`document.querySelector('.ratings-status').textContent`),/3 episodes shown.*2 with a rating.*7.50/);cases.push('manual ID persisted; season 0, unrated cells and statistics remain accurate');
  const saved=JSON.stringify(series.imdbChart);gate=deferred();await js(`document.querySelector('.ratings-status button').click()`);await tick();
  await js(`ratingsTest.go({name:'home'})`);gate.resolve({status:'error',issue:'timeout'});await tick();assert.equal(JSON.stringify(series.imdbChart),saved);
  await js(`ratingsTest.go({name:'ratings-chart',id:${JSON.stringify(series.id)}})`);await tick();assert.equal(await js(`document.querySelector('.ratings-status').dataset.status`),'error');assert.match(await js(`document.querySelector('.ratings-status').textContent`),/last available chart/);assert.equal(await js(`document.querySelector('.ratings-status button').disabled`),false);cases.push('failed refresh during navigation retains chart and permits explicit retry');
  gate=deferred();await js(`document.querySelector('.ratings-status button').click()`);await tick();gate.resolve({status:'empty'});await tick();assert.equal(await js(`document.querySelector('.ratings-status').dataset.status`),'empty');cases.push('empty result is a terminal state');
  // A changed account with the same UUID cannot accept the old renderer result.
  gate=deferred();await js(`document.querySelector('.ratings-status button').click()`);await tick();store.switchFile(path.join(temp,'other.json'));store.addSeries({...series,episodes:structuredClone(series.episodes)});service.syncScope();win.webContents.send('lib:changed',store.snapshot());gate.resolve({status:'error',issue:'old-account'});await tick();assert.equal(await js(`ratingsTest.state.ratingLoads[${JSON.stringify(series.id)}]`),undefined);cases.push('account reset rejects a late same-UUID result');
  // Check cache reuse with a snapshot arriving once, then ordinary navigation.
  const perf=await js(`(()=>{let applications=0,preparations=0;const apply=EpisodeRatings.apply,prepare=EpisodeRatings.prepare;EpisodeRatings.apply=(...args)=>{applications++;return apply(...args);};EpisodeRatings.prepare=(...args)=>{preparations++;return prepare(...args);};const s=ratingsTest.state.lib.series[0];ratingsTest.state.lib=structuredClone(ratingsTest.state.lib);const before=applications;for(let i=0;i<5;i++)ratingsTest.ratingsChartView(ratingsTest.state.lib.series[0]);return {before,applications,preparations};})()`);
  assert.equal(perf.applications,perf.before);assert.equal(perf.preparations,1);cases.push('mapping/index cache reused across repeated renders');
  const timings=[];
  for(const n of [150,400,1200]){
    const timing=await js(`(()=>{const n=${n},eps=Array.from({length:n},(_,i)=>({id:'ep'+i,number:i+1,title:'Episode '+(i+1),sources:[],progress:{pos:0,duration:0,watched:false}}));const chart={imdbId:'tt12345',title:'Performance fixture',complete:true,totalEpisodes:n,seasons:[{season:1,episodes:eps.map(e=>({id:'tt'+(10000+e.number),number:e.number,title:e.title,rating:7.5}))}]};const s={id:'performance',title:chart.title,format:'TV',episodeCount:n,episodes:eps,imdbChart:chart,genres:[]};let start=performance.now();ratingsTest.state.lib={series:[s],settings:{language:'en',onboardingComplete:true}};const snapshotMs=performance.now()-start;start=performance.now();const node=ratingsTest.ratingsChartView(s);const buildMs=performance.now()-start;start=performance.now();document.querySelector('#main').replaceChildren(node);node.offsetHeight;const domMs=performance.now()-start;return {n,snapshotMs,buildMs,domMs};})()`);
    assert.ok(timing.buildMs+timing.domMs<1000,JSON.stringify(timing));timings.push(timing);
  }
  cases.push('150/400/1200 charts construct and layout within the one-second regression budget');
  // UI screenshots use synthetic content only, available for visual inspection.
  await js(`ratingsTest.state.view={name:'ratings-chart',id:'performance'};ratingsTest.render()`);await tick();
  const screenshot=path.join(path.dirname(resultFile),'phase-2c-chart.png');await capture('phase-2c-chart.png');
  assert.deepEqual(errors,[]);report({ok:true,cases,timings,screenshot});clearTimeout(timeout);service.dispose();clearTimeout(store._timer);win.destroy();app.exit(0);
}).catch(error=>{report({ok:false,error:error.stack,cases,errors});clearTimeout(timeout);service?.dispose();if(store)clearTimeout(store._timer);app.exit(1);});
