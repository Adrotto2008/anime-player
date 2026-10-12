'use strict';
// Explicit live opt-in. Uses a fresh profile and public providers; never starts
// CloudService or reads an installed library. Bounded views, not full films.
const fs=require('fs'),path=require('path'),assert=require('assert'),{spawnSync}=require('child_process');
const {Store}=require('../src/store'),{PlayerManager}=require('../src/player');
const {AnimeUnityClient,AnimeWorldClient}=require('../src/source-engine');
const {discoverSeriesSources}=require('../src/source-discovery');
const {redact}=require('../src/source-state');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const output=path.resolve(process.argv[2]),profile=path.resolve(process.argv[3]);
assert.ok(output&&profile);fs.mkdirSync(output,{recursive:true});fs.mkdirSync(profile,{recursive:true});
const executable=process.env.ANIME_PLAYER_TEST_MPV;
assert.ok(executable&&fs.existsSync(executable),'Explicit mpv executable required');
async function waitFor(fn,ms=60000){const until=Date.now()+ms;while(Date.now()<until){if(fn())return;await sleep(100);}throw Error('Timed out waiting for observed playback');}
const report={version:require('../package.json').version,observedAt:new Date().toISOString(),cases:[],
  scope:'public provider discovery and bounded real mpv video through application PlayerManager; isolated empty library; audio output not certified'};
const titles=[{title:'Re:Zero kara Hajimeru Isekai Seikatsu - Memory Snow',altTitle:'Re:Zero -Starting Life in Another World- Memory Snow',
  format:'OVA',year:2018,episodeCount:1,malId:36286},
  {title:'Re:Zero kara Hajimeru Isekai Seikatsu - Hyouketsu no Kizuna',altTitle:'Re:Zero -Starting Life in Another World- The Frozen Bond',
    format:'MOVIE',year:2019,episodeCount:1,malId:38414}];
async function capture(player,name){
  const cur=player.cur,s=cur.session;
  await waitFor(()=>player.cur===cur&&cur.pos>cur.start+1&&cur.dur>0);
  const vo=await s.request(['get_property','vo-configured']),params=await s.request(['get_property','video-out-params']);
  assert.equal(vo,true);assert.ok(params.w>0&&params.h>0);
  const visible=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
    path.join(__dirname,'inspect-player-window.ps1'),'-PlayerProcessId',String(s.proc.pid)],{encoding:'utf8',windowsHide:true});
  assert.equal(visible.status,0);const window=JSON.parse(visible.stdout);assert.equal(window.visible,true);assert.equal(window.hasWindow,true);
  const image=path.join(output,name+'.png');await s.request(['screenshot-to-file',image,'window']);assert.ok(fs.statSync(image).size>1000);
  return{provider:cur.source.provider,type:cur.source.engine?.type,sourceId:cur.source.id,position:cur.pos,duration:cur.dur,
    dimensions:{width:params.w,height:params.h},window,screenshot:path.basename(image)};
}
(async()=>{
  for(let i=0;i<titles.length;i++){
    const events=[],store=new Store(path.join(profile,'library-'+i+'.json'));
    const record={title:titles[i].title,phases:[],events};let player;
    try{
      const series=store.addSeries(titles[i]);
      const discovery=await discoverSeriesSources(series,[series.title,series.altTitle],{
        store,animeUnity:new AnimeUnityClient(),animeWorld:new AnimeWorldClient()});
      record.discovery={...discovery,providers:Object.fromEntries(Object.entries(discovery.providers).map(([id,value])=>
        [id,{status:value.status,linksResolved:value.linksResolved,candidates:value.candidates,errors:value.errors}]))};
      const unit=series.mediaParts[0];assert.ok(unit&&unit.sources.length,'Film source missing');
      record.sources=unit.sources.map(s=>({id:s.id,provider:s.provider,type:s.engine?.type,providerEpisodeId:s.providerEpisodeId}));
      store.setSettings({mpvPath:executable,defaultPreset:'off',autoplayNext:false,
        extraArgs:'--no-config --cookies=no --ytdl=no --audio=no --mute=yes --cache=no --demuxer-max-bytes=1MiB --geometry=640x400+40+40'});
      const renew=async(s,series,unit,o)=>{
        if(record.failedSourceIdentity===s.id)throw Error('Controlled test: upstream renewal unavailable for failed source');
        return (s.provider==='animeunity'?new AnimeUnityClient():new AnimeWorldClient()).renewSource(s,series,unit,o);
      };
      player=new PlayerManager({store,paths:{userData:profile,shaderDir:path.join(__dirname,'..','shaders')},
        resolveAutomaticSource:renew,notify:(channel,payload)=>{if(['player:error','player:recovering','player:source-failed'].includes(channel))events.push({channel,
          payload:JSON.parse(redact(JSON.stringify(payload)))});}});
      record.stallTimeoutMs=player.stallTimeoutMs;
      assert.equal(record.stallTimeoutMs,5000);
      const checkStall=player._checkStall.bind(player);
      player._checkStall=(cur,now=Date.now())=>{
        const requestedBefore=cur.session.requestedReason;
        checkStall(cur,now);
        if(!requestedBefore&&cur.session.requestedReason==='source-stalled')
          record.watchdog={idleMs:now-cur.lastAdvanceAt,seeking:!!cur.seeking,position:cur.pos};
      };
      await player.play(series.id,unit.id,{resumePos:40});record.phases.push({phase:'initial',...await capture(player,'film-'+i+'-initial')});
      // First demonstrate actual stop/reopen resuming a later checkpoint.
      player.seekAbsolute(120);await waitFor(()=>player.cur?.pos>=120);await sleep(1200);
      await player.stop();const saved=store.getEpisode(series.id,unit.id).progress.pos;assert.ok(saved>=120);
      await player.play(series.id,unit.id);const resumed=await capture(player,'film-'+i+'-resume');
      assert.ok(resumed.position>=saved-3);record.phases.push({phase:'checkpoint-resume',saved,...resumed});
      // Inject a real local proxy outage, then force a cache miss by seeking.
      // Renewal is deliberately denied so the alternate stable source must run.
      const failed=player.cur,checkpoint=failed.pos;record.failedSourceIdentity=failed.source.id;
      await failed.proxy.close();
      if(!process.argv.includes('--natural-outage'))failed.session.seekAbsolute(180);
      await waitFor(()=>player.cur && player.cur!==failed,90000);
      const fallback=await capture(player,'film-'+i+'-fallback');
      assert.notEqual(fallback.sourceId,failed.source.id);assert.ok(fallback.position>=checkpoint-3);
      const requested=events.filter(e=>e.channel==='player:recovering'&&e.payload.phase==='fallback').at(-1)?.payload.position;
      assert.equal(player.cur.start,requested);
      record.phases.push({phase:'controlled-proxy-outage-fallback',checkpoint,requested,
        forcedSeek:!process.argv.includes('--natural-outage'),...fallback});
      assert.equal(store.getEpisode(series.id,unit.id).progress.watched,false);
      record.status='passed';
    }catch(e){record.status='failed';record.error=redact(e.message);process.exitCode=1;}
    finally{if(player)await player.stop().catch(e=>record.cleanupError=redact(e.message));clearTimeout(store._timer);
      record.diagnostics=player?.diagnostics.read();report.cases.push(record);
      fs.writeFileSync(path.join(output,'re-zero-live.json'),JSON.stringify(report,null,2));
      console.log(JSON.stringify({title:record.title,status:record.status,phases:record.phases.map(p=>({phase:p.phase,provider:p.provider,type:p.type,position:p.position})),error:record.error}));}
  }
})().catch(e=>{console.error(redact(e.message));process.exitCode=1;});
