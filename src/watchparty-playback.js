'use strict';
const fs=require('fs'),path=require('path'),{createHash}=require('crypto'),{fileURLToPath}=require('url');
const Protocol=require('./watchparty-protocol'),Language=require('./source-language');
function localPath(value){if(typeof value!=='string')return null;try{if(value.startsWith('file:'))return fileURLToPath(value);if(!/^[a-z]+:\/\//i.test(value)&&path.isAbsolute(value))return value;}catch{}return null;}
async function fileHash(file,signal){const hash=createHash('sha256');for await(const chunk of fs.createReadStream(file,{signal}))hash.update(chunk);return hash.digest('hex');}
class PartyPlayback{
  constructor(service){this.s=service;this.generation=0;this.detached=false;this.ignoreUntil=0;this.lastSeek=0;this.localContent=null;this.candidates=[];}
  reset(){++this.generation;this.controller?.abort();this.loadingKey=null;this.remoteKey=null;this.localContent=null;this.detached=false;this.needsSource=false;this.candidates=[];
    if(this.changedSpeed&&this.s.player.cur)this.s.player.cur.session.send(['set_property','speed',this.baseSpeed||1]);this.changedSpeed=false;this.described=null;this.describing=null;this.lastSeek=0;this.lastSnapshot=0;}
  async describe(cur){
    if(cur.partyContent)return Protocol.content(cur.partyContent);
    const source=cur.source||{},series=cur.series,ep=cur.ep;
    if(series){const number=Number(ep?.number??series.mediaParts?.findIndex(p=>p.id===ep?.id)+1)||1;const id=series.anilistId?'anilist:'+series.anilistId:series.malId?'mal:'+series.malId:'title:'+createHash('sha256').update(series.title).digest('hex');return Protocol.content({key:`catalog:${id}:${ep?.kind==='part'?'part':'episode'}:${number}`,kind:'catalog',title:series.title,anilistId:Number(series.anilistId)||undefined,malId:Number(series.malId)||undefined,number,unitKind:ep?.kind||'episode',format:series.format,year:Number(series.year)||undefined,episodeCount:Number(series.episodeCount)||undefined,provider:source.provider,providerTitleUrl:source.providerTitleUrl,
      sourceUrl:this.s.preferences.shareSource?Protocol.publicUrl(source.url):null});}
    const file=localPath(cur.url);
    if(file){const hash=await fileHash(file,this.controller?.signal);return Protocol.content({key:'local:'+hash,kind:'local',title:path.basename(file),localHash:hash});}
    const safe=Protocol.publicUrl(cur.url);return Protocol.content({key:'custom:'+createHash('sha256').update(safe||String(cur.title||'custom')).digest('hex'),kind:'custom',title:cur.title||'Video',sourceUrl:this.s.preferences.shareSource?safe:null});
  }
  async event(type,data){
    const s=this.s;if(type==='status'){this.showStatus();return;}if(!s.room||s.connection!=='connected')return;
    if(type==='resync'||type==='resync-all'){try{await (type==='resync'?this.resync():s.resyncAll());}catch(error){s.osd(error.message);}return;}
    if(type==='pause'&&this.expectedPause!==undefined&&data===this.expectedPause){this.expectedPause=undefined;return;}
    if(type==='seeked'&&Date.now()<(this.suppressSeekUntil||0))return;
    if(type==='error'&&!s.isHost()&&!this.detached){if(this.candidates.length)this.nextSource().catch(()=>{});else{this.needsSource=true;this.loadingKey=null;s.telemetry.state='source';s.publish();}return;}
    if(type==='launch'||type==='loaded'){
      const cur=s.player.cur;if(!cur)return;
      if(type==='loaded'&&cur.partyContent?.key===s.room.playback?.content.key)this.needsSource=false;
      if(s.isHost()||s.room.permissions.content){
        if(cur===this.describing||cur===this.described)return;this.describing=cur;const generation=this.generation;
        try{const content=await this.describe(cur);if(generation!==this.generation||s.player.cur!==cur||!s.room)return;this.described=cur;this.localContent=content;this.describing=null;
          if(s.room.playback?.content.key!==content.key){if(s.isHost()||s.room.permissions.content)await s.command('content',{content});}
        }catch{this.describing=null;s.error='Identità del contenuto non disponibile';s.publish();}
      }else if(cur.partyContent){this.localContent=cur.partyContent;if(type==='loaded'&&cur.session?.loaded)await this.apply();}
      else{this.detached=true;s.telemetry.state='source';s.osd('Sorgente locale non associata al contenuto condiviso');s.publish();}
    }
    if(Date.now()<this.ignoreUntil||this.loadingKey)return;
    if(s.isHost()){if(type==='exit'&&s.room.playback)s.command('playPause',{paused:true}).catch(()=>{});if(['pause','seeked','speed','buffering','loaded'].includes(type))this.snapshot(true);return;}
    if(type==='pause'){
      if(s.room.permissions.playPause&&!this.detached)s.command('playPause',{paused:!!data}).catch(()=>{});
      else if(data){this.detached=true;s.telemetry.state='local-pause';s.send({type:'local-status',localPaused:true});s.osd('Pausa individuale · premi Risincronizza');s.publish();}
    }else if(type==='seeked'){
      const action=data?.kind==='skip'?'skip':'seek';if(s.room.permissions[action]&&!this.detached)s.command(action,{position:s.player.cur?.pos||0}).catch(()=>{});
      else{this.detached=true;s.telemetry.state='detached';s.osd('Fuori sincronizzazione · premi Risincronizza');s.publish();}
    }else if(type==='exit'&&!this.loadingKey){this.detached=true;s.telemetry.state='stopped';s.publish();}
  }
  async accept(previous,message){
    const s=this.s,remote=s.room?.playback;if(!remote)return;
    if(message.event==='resync-all'){await this.resync();return;}
    const becameHost=previous&&previous.hostId!==s.room.hostId&&s.isHost();
    if(s.isHost()){
      if(becameHost){this.detached=false;this.localContent=s.player.cur?.partyContent||this.localContent;if(this.localContent?.key!==remote.content.key)await this.load(remote.content);await this.apply(true);}
      else if(message.event==='command'&&message.details?.actorId!==s.participantId){if(message.details?.action==='content'&&this.localContent?.key!==remote.content.key)await this.load(remote.content);await this.apply(true);}
      else if(!this.localContent&&s.player.cur)await this.event('launch');
      return;
    }
    if(remote.content.key!==this.remoteKey){this.remoteKey=remote.content.key;this.detached=false;await this.load(remote.content);}
    else if(s.connection==='connected'&&!this.detached)await this.apply();
  }
  target(){const remote=this.s.room?.playback;return remote?Math.max(0,remote.position+(!remote.paused&&!remote.buffering?Math.max(0,(Date.now()+(this.s.clockOffset||0)-remote.serverTime)/1000)*(remote.speed||1):0)):0;}
  async load(content){
    const s=this.s,generation=++this.generation;this.controller?.abort();this.controller=new AbortController();this.loadingKey=content.key;this.needsSource=false;this.detached=false;this.localContent=content;this.candidates=[];this.ignoreUntil=Date.now()+1500;s.telemetry.state='loading';s.publish();
    try{
      const series=s.store.data.series.find(item=>content.anilistId&&String(item.anilistId)===String(content.anilistId)||!content.anilistId&&content.malId&&String(item.malId)===String(content.malId));
      this.mode=Language.preference(series?.videoPreference)?.mode||'auto';
      const ep=series&&(content.unitKind==='part'?series.mediaParts:series.episodes)?.find(item=>Number(item.number||((series.mediaParts||[]).indexOf(item)+1))===content.number);
      if(content.kind==='local')throw Error('Seleziona il file equivalente');
      if(content.sourceUrl)this.candidates.push({url:content.sourceUrl,provider:'manual'});
      if(ep?.sources?.length){const mode=Language.preference(series.videoPreference)?.mode||s.store.data.settings.defaultVideoPreference||'auto';const sources=ep.sources.filter(source=>Language.eligible(source,mode));
        if(!this.candidates.length){await s.player.play(series.id,ep.id,{resumePos:this.target(),expectedDuration:s.room.playback.duration||undefined,partyContent:content});if(generation!==this.generation)return;this.loadingKey=null;this.needsSource=!s.player.cur;return;}
        this.candidates.push(...sources);
      }
      if(!this.candidates.length&&content.kind==='catalog'){
        const {AnimeUnityClient,AnimeWorldClient}=require('./source-engine');
        for(const client of [new AnimeUnityClient(),new AnimeWorldClient()]){
          const found=await client.findSources({titles:[content.title],episodeNumbers:[content.number],anilistId:content.anilistId,malId:content.malId,format:content.format,year:content.year,episodeCount:content.episodeCount});if(generation!==this.generation)return;const eligible=found.filter(source=>Language.eligible(source,this.mode));this.candidates.push(...eligible);if(eligible.length)break;
        }
      }
      if(generation!==this.generation)return;await this.nextSource(generation);
    }catch{if(generation===this.generation){this.loadingKey=null;this.needsSource=true;s.telemetry.state='source';s.osd('Seleziona una sorgente equivalente');s.publish();}}
  }
  async nextSource(generation=this.generation){
    if(this.sourceBusy===generation)return;this.sourceBusy=generation;const s=this.s;
    try{while(this.candidates.length&&generation===this.generation){let source=this.candidates.shift();try{
          if(['animeunity','animeworld'].includes(source.provider)&&source.engine){const {AnimeUnityClient,AnimeWorldClient}=require('./source-engine');const client=source.provider==='animeunity'?new AnimeUnityClient():new AnimeWorldClient();source=await client.renewSource(source,{...this.localContent,title:this.localContent.title},{number:this.localContent.number},{signal:this.controller.signal});}
          if(generation!==this.generation)return;await s.player.playPartySource(source,this.localContent,{start:this.target(),expectedDuration:s.room?.playback?.duration||undefined,signal:this.controller.signal,effectiveMode:this.mode});
          if(generation!==this.generation)return;this.loadingKey=null;this.needsSource=false;return;
        }catch{}}
      if(generation===this.generation){this.loadingKey=null;this.needsSource=true;s.telemetry.state='source';s.publish();}
    }finally{if(this.sourceBusy===generation)this.sourceBusy=null;}
  }
  async chooseSource(url){
    const content=this.s.room?.playback?.content;if(!content)throw Error('Nessun contenuto condiviso');
    if(typeof url!=='string'||url.length>8000)throw Error('Sorgente non valida');const file=localPath(url);
    if(content.localHash){if(!file||await fileHash(file)!==content.localHash)throw Error('Il file non corrisponde a quello condiviso dall’host');}
    ++this.generation;this.controller?.abort();this.controller=new AbortController();this.localContent=content;this.loadingKey=content.key;this.detached=false;this.needsSource=false;this.ignoreUntil=Date.now()+1500;
    try{await this.s.player.playPartySource({url,provider:'manual'},content,{start:this.target(),expectedDuration:this.s.room.playback.duration||undefined,effectiveMode:this.mode});this.loadingKey=null;this.s.publish();}
    catch(error){this.loadingKey=null;this.needsSource=true;this.s.publish();throw error;}
  }
  snapshot(force=false){
    const s=this.s,cur=s.player.cur,remote=s.room?.playback,now=Date.now();
    if(!s.isHost()||this.detached||this.loadingKey||this.applying||this.resyncBusy||s.connection!=='connected'||!remote||!cur||this.localContent?.key!==remote.content.key)return;
    if(now-(this.lastSnapshot||0)<(force?150:2000))return;this.lastSnapshot=now;
    s.send({type:'snapshot',epoch:remote.epoch,key:remote.content.key,position:cur.pos||0,duration:cur.dur||0,paused:!!cur.paused,speed:cur.speed||1,buffering:!cur.session.loaded||!!cur.buffering,sampleServerTime:now+(s.clockOffset||0)});
  }
  async apply(force=false){
    const s=this.s,cur=s.player.cur,remote=s.room?.playback;if(!cur||!remote||this.detached||this.loadingKey)return;
    if(this.applying){if(force){await this.applyPending;return this.apply(true);}return;}
    if(s.isHost()&&!force)return;this.applying=true;let release;this.applyPending=new Promise(resolve=>{release=resolve;});
    try{
      const local={key:cur.partyContent?.key||this.localContent?.key,position:cur.pos||0,duration:cur.dur||0,localPaused:this.detached,buffering:!cur.session.loaded||!!cur.buffering};
      if(remote.buffering&&!local.buffering){if(!cur.paused){this.expectedPause=true;await cur.session.request(['set_property','pause',true]);}s.telemetry.state='host-buffering';return;}
      const result=Protocol.correction({remote,local,serverNow:Date.now()+(s.clockOffset||0),now:Date.now(),lastSeek:this.lastSeek,config:s.preferences.sync});s.telemetry.drift=Number.isFinite(result.drift)?result.drift:null;
      if(result.reason==='version'){s.telemetry.state='version';this.needsSource=true;this.detached=true;s.osd('Montaggio o durata differenti');s.publish();return;}
      if(result.kind==='wait'){s.telemetry.state=result.reason;return;}
      if(force&&result.kind==='rate'&&Math.abs(result.drift)>s.preferences.sync.deadband){result.kind='seek';result.speed=remote.speed||1;}
      const pause=!!(remote.paused||remote.buffering);
      if(cur.paused!==pause){this.expectedPause=pause;await cur.session.request(['set_property','pause',pause]);}
      if(['seek','seek-pause'].includes(result.kind)){this.suppressSeekUntil=Date.now()+1500;await cur.session.request(['seek',result.target,'absolute+exact']);this.lastSeek=Date.now();}
      if(Math.abs((cur.speed||1)-result.speed)>.002){this.baseSpeed=remote.speed||1;await cur.session.request(['set_property','speed',result.speed]);this.changedSpeed=true;}
      s.telemetry.state=Math.abs(result.drift||0)<.5?'synced':'correcting';
    }finally{this.applying=false;release();}
  }
  async tick(){const s=this.s;if(s.connection!=='connected')return;
    if(s.isHost()){if(s.player.cur&&s.player.cur!==this.described)await this.event('launch');this.snapshot();s.telemetry.state=this.detached?'local-pause':s.player.cur?.buffering?'buffering':'host';}
    else if(!this.detached)await this.apply();
    const buffer=!!s.player.cur?.buffering;if(buffer!==this.lastBuffer){this.lastBuffer=buffer;s.send({type:'local-status',buffering:buffer,localPaused:this.detached});}
    s.publish();
  }
  async resync(){
    if(this.resyncPending)return this.resyncPending;
    if(this.s.connection!=='connected'||!this.s.room?.playback)throw Error('Nessun contenuto Watch Party connesso');
    const epoch=this.s.epoch;this.resyncBusy=true;
    this.resyncPending=(async()=>{this.detached=false;this.s.send({type:'local-status',localPaused:false});const content=this.s.room.playback.content;this.remoteKey=content.key;
      if(!this.s.player.cur||this.needsSource||(this.s.player.cur.partyContent?.key||this.localContent?.key)!==content.key)await this.load(content);
      if(this.s.epoch!==epoch||this.s.room?.playback?.content.key!==content.key||this.s.connection!=='connected')return;this.lastSeek=0;await this.apply(true);this.s.osd('Risincronizzazione');this.s.publish();
    })();
    try{return await this.resyncPending;}finally{this.resyncPending=null;this.resyncBusy=false;}
  }
  async pauseLocal(){if(!this.s.player.cur)return;this.detached=true;this.expectedPause=true;await this.s.player.cur.session.request(['set_property','pause',true]);this.s.telemetry.state='local-pause';this.s.send({type:'local-status',localPaused:true});this.s.publish();}
  showStatus(){const t=this.s.telemetry;this.s.osd(`RTT ${t.rtt==null?'—':Math.round(t.rtt)+' ms'} · Δ ${t.drift==null?'—':Math.round(t.drift*1000)+' ms'} · ${t.state}${this.s.player.cur?.buffering?' · buffering':''}`);}
}
module.exports={PartyPlayback,fileHash,localPath};
