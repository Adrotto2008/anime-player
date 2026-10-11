'use strict';
const {app}=require('electron');const fs=require('fs'),path=require('path');
const {Store}=require('../src/store');const {PlayerManager}=require('../src/player');const {installShutdown}=require('../src/shutdown');
const dir=process.argv.find(s=>s.startsWith('--fixture=')).slice(10),mpvPath=process.argv.find(s=>s.startsWith('--mpv=')).slice(6);
app.setPath('userData',path.join(dir,'electron-user-data'));
let store,player;installShutdown(app,()=>({store,player}));
const report=value=>fs.writeFileSync(path.join(dir,'electron-result.json'),JSON.stringify(value));
const timer=setTimeout(()=>{report({ok:false,error:'Electron playback timeout'});app.quit();},12000);
app.whenReady().then(async()=>{
  store=new Store(path.join(dir,'electron-library.json'));const s=store.addSeries({title:'Synthetic Electron exit'});store.addSources(s.id,[{number:1,url:path.join(dir,'synthetic.wav')}]);
  store.setSettings({mpvPath,defaultPreset:'off',autoplayNext:false,extraArgs:'--no-config --vo=null --ao=null'});
  player=new PlayerManager({store,paths:{userData:dir,shaderDir:path.join(__dirname,'..','shaders')},notify:()=>{}});
  await player.play(s.id,s.episodes[0].id);
  const poll=setInterval(()=>{if(player.cur?.pos>1.2){clearInterval(poll);clearTimeout(timer);report({ok:true,position:player.cur.pos});app.quit();}},25);
}).catch(error=>{clearTimeout(timer);report({ok:false,error:error.message});app.quit();});
