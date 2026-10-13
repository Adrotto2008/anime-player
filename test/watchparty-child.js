'use strict';
const {app}=require('electron'),fs=require('fs');
if(process.env.ANIME_PLAYER_TEST_ACCOUNTS==='1'){
  // These interactive fixtures exercise production Auth and Party IPC while
  // preventing synthetic library/history data from reaching real accounts.
  const {CloudService}=require('../src/cloud');
  CloudService.prototype.sync=async function(){this.activeLibraryUserId=this.user?.id||null;};
  CloudService.prototype._activateLibrary=async function(id){this.activeLibraryUserId=id;};
  CloudService.prototype.ensureProfile=async function(id){const {error}=await this.client.from('profiles').select('id').eq('id',id).maybeSingle();if(error)throw error;};
  const config=JSON.parse(fs.readFileSync(require('path').join(__dirname,'..','.build-resources','inputs','supabase-public.json'),'utf8'));process.env.SUPABASE_URL=config.url;process.env.SUPABASE_PUBLISHABLE_KEY=config.publishableKey;
}
const main=require('../main');
let statusCount=0;
const shortcutCounts={resync:0,all:0};
app.getVersion=()=>require('../package.json').version;
const wait=async fn=>{for(let i=0;i<600;i++){if(fn())return;await new Promise(r=>setTimeout(r,25));}throw Error('Application startup timed out');};
app.whenReady().then(async()=>{
  await wait(()=>main.getServices().win&&!main.getServices().win.webContents.isLoading());
  const {win}=main.getServices();
  const player=main.getServices().player,observe=player.onPartyEvent;player.onPartyEvent=(type,data)=>{if(type==='status')statusCount++;if(type==='resync')shortcutCounts.resync++;if(type==='resync-all')shortcutCounts.all++;return observe(type,data);};
  for(let i=0;i<200;i++){if(await win.webContents.executeJavaScript("!!document.querySelector('#main .page')"))break;await new Promise(r=>setTimeout(r,25));}
  if(process.env.ANIME_PLAYER_TEST_ACCOUNTS!=='1')await win.webContents.executeJavaScript("document.querySelector('#dialog-root .icon-btn')?.click()");
  else {win.setTitle(process.env.ANIME_PLAYER_TEST_WINDOW_TITLE||'Watch Party · account di prova');win.hide();win.show();win.focus();}
  process.send?.({ready:true});
}).catch(error=>{process.send?.({fatal:error.message});app.exit(1);});
process.on('message',async message=>{
  try{const {win,player,party,store,cloud}=main.getServices();let value;
    if(message.action==='info'){const cur=player.cur;value={statusCount,shortcutCounts,party:party.snapshot(),player:cur?{position:cur.pos,duration:cur.dur,paused:cur.paused,speed:cur.speed,buffering:cur.buffering,loaded:cur.session.loaded,mpvPid:cur.session.proc?.pid,episode:cur.ep?.number,preset:cur.presetId,shortcutKeys:cur.shortcutKeys}:null};}
    else if(message.action==='ui')value=await win.webContents.executeJavaScript(message.code);
    else if(message.action==='account')value={id:cloud.user?.id||null,friends:cloud.user?await cloud.listFriends():[]};
    else if(message.action==='play'){const series=store.data.series[0],episode=series.episodes.find(e=>e.number===message.number);value=await win.webContents.executeJavaScript(`animeApi.invoke('player:play',${JSON.stringify(series.id)},${JSON.stringify(episode.id)})`);value=!!value;}
    else if(message.action==='mpv')value=await player.cur.session.request(message.command);
    else if(message.action==='resync'){await party.playback.resync();value=true;}
    else if(message.action==='pauseLocal'){await party.playback.pauseLocal();value=true;}
    else if(message.action==='capture'){const image=await require('./capture-surface').captureSurface(win);fs.writeFileSync(message.file,image.toPNG());value=true;}
    else if(message.action==='network'){party.socket.terminate();value=true;}
    else if(message.action==='offline'){party.fetch=async()=>{throw Error('Synthetic network interruption');};party.socket.terminate();value=true;}
    else if(message.action==='drift'){clearInterval(party.tickTimer);await player.cur.session.request(['set_property','speed',.8]);setTimeout(()=>{party.tickTimer=setInterval(()=>party.playback.tick().catch(()=>{}),500);},4000);value=true;}
    else if(message.action==='leave'){await party.leave();value=true;}
    else if(message.action==='quit'){app.quit();value=true;}
    else throw Error('Unknown test action');
    process.send?.({id:message.id,value});
  }catch(error){process.send?.({id:message.id,error:error.message});}
});
