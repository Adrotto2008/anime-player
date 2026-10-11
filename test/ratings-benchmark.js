'use strict';
// Same Electron, CSS, fixture and timing boundaries for the baseline and new code.
const fs=require('fs'),path=require('path'),os=require('os');
const arg=name=>process.argv.find(x=>x.startsWith(`--${name}=`))?.slice(name.length+3);
if(!process.versions.electron){
  const {spawn}=require('child_process');const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(require('electron'),[__filename,...process.argv.slice(2)],{env,windowsHide:true,stdio:'inherit'});
  child.on('exit',code=>process.exit(code??1));
}else{
  const {app,BrowserWindow,ipcMain}=require('electron');
  const source=path.resolve(arg('source')||path.join(__dirname,'..')),output=arg('output');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'anime-ratings-bench-'));app.setPath('userData',temp);
  const rows=[];const record=value=>{rows.push(value);console.log(JSON.stringify(value));if(output)fs.writeFileSync(output,JSON.stringify({electron:process.versions.electron,node:process.versions.node,platform:process.platform,arch:process.arch,cpu:os.cpus()[0].model,source,rows},null,2));};
  app.whenReady().then(async()=>{
    // Only temporary copies expose test hooks; the production renderer has no hooks.
    fs.cpSync(path.join(source,'renderer'),path.join(temp,'renderer'),{recursive:true});
    fs.cpSync(path.join(source,'src'),path.join(temp,'src'),{recursive:true});
    const file=path.join(temp,'renderer/app.js');
    fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('/* ---------- avvio ---------- */','window.ratingsBench={state,ratingsChartView,render,go,loadSeriesRatings};\n/* ---------- avvio ---------- */'));
    for(const [ch,value] of Object.entries({'lib:get':{series:[],settings:{language:'en',onboardingComplete:true}},'presets:list':[],'app:version':'fixture','player:state':{playing:false},'auth:state':{connected:false}}))ipcMain.handle(ch,()=>value);
    ipcMain.handle('series:ratings',()=>new Promise(()=>{}));
    const win=new BrowserWindow({show:false,width:1180,height:760,webPreferences:{preload:path.join(source,'preload.js'),contextIsolation:true,sandbox:true,backgroundThrottling:false}});
    await win.loadFile(path.join(temp,'renderer/index.html'));
    await win.webContents.executeJavaScript(`document.querySelector('#dialog-root .icon-btn')?.click()`);
    for(const n of (arg('sizes')||'150,400,1200').split(',').map(Number)){
      console.log(`Benchmark ${n}: mapping, construction, then DOM/layout`);
      const fixture=`(()=>{const n=${n};const eps=Array.from({length:n},(_,i)=>({id:'local-'+i,number:i+1,title:'Episode title '+(i+1),sources:[],progress:{pos:0,duration:0,watched:false},rating:null}));const chart={imdbId:'tt12345',title:'Benchmark anime',maxEpisodes:n,seasons:[{season:1,episodes:eps.map(e=>({id:'tt'+(100000+e.number),number:e.number,title:e.title,rating:7.5}))}]};const s={id:'bench',title:chart.title,format:'TV',episodeCount:n,episodes:eps,imdbChart:chart,genres:[]};ratingsBench.state.lib={series:[s],settings:{language:'en',onboardingComplete:true}};ratingsBench.state.view={name:'ratings-chart',id:s.id};return s;})()`;
      await win.webContents.executeJavaScript(`window.fixture=${fixture}`);
      const mapping=await win.webContents.executeJavaScript(`(()=>{const start=performance.now();EpisodeRatings.apply(fixture,fixture.imdbChart);return performance.now()-start;})()`);
      record({n,stage:'mapping',ms:mapping});
      const construction=await win.webContents.executeJavaScript(`(()=>{const start=performance.now();window.chartNode=ratingsBench.ratingsChartView(fixture);return performance.now()-start;})()`);
      record({n,stage:'construction',ms:construction});
      const rendering=await win.webContents.executeJavaScript(`(()=>{const start=performance.now();document.querySelector('#main').replaceChildren(chartNode);const height=chartNode.offsetHeight;return {ms:performance.now()-start,nodes:chartNode.querySelectorAll('*').length,height};})()`);
      record({n,stage:'rendering',...rendering});
      const navigation=await win.webContents.executeJavaScript(`(()=>{ratingsBench.state.view={name:'home'};const start=performance.now();ratingsBench.render();document.querySelector('#main').offsetHeight;return performance.now()-start;})()`);
      record({n,stage:'home-navigation',ms:navigation});
    }
    win.destroy();app.exit(0);
  }).catch(error=>{console.error(error);app.exit(1);});
}
