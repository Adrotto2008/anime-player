'use strict';
const WebSocket=require('ws'),{randomUUID}=require('crypto'),fs=require('fs'),path=require('path');
const Protocol=require('./watchparty-protocol');
const ENDPOINT='https://watchparty-server.adrianopalmeri02.workers.dev';
function preferences(previous,patch){
  if(!patch||typeof patch!=='object'||Array.isArray(patch))throw Error('Preferenze non valide');
  const next={sync:{...Protocol.DEFAULT_SYNC,...previous.sync},shareSource:previous.shareSource===true};
  if(typeof patch.shareSource==='boolean')next.shareSource=patch.shareSource;
  const ranges={deadband:[.02,.5],hardSeek:[.5,10],maxRateDelta:[.005,.1],rateWindow:[2,30],seekCooldownMs:[1000,30000],durationTolerance:[.001,.02]};
  if(patch.sync)for(const [key,range]of Object.entries(ranges)){if(patch.sync[key]!==undefined){const value=Number(patch.sync[key]);if(!Number.isFinite(value)||value<range[0]||value>range[1])throw Error('Soglia sincronizzazione non valida');next.sync[key]=value;}}
  return next;
}
class WatchPartyService{
  constructor({player,store,cloud,notify=()=>{},userDataPath,baseUrl=ENDPOINT,fetchImpl=fetch,Socket=WebSocket}){
    this.player=player;this.store=store;this.cloud=cloud;this.notify=notify;this.baseUrl=baseUrl;this.fetch=fetchImpl;this.Socket=Socket;
    this.file=userDataPath?path.join(userDataPath,'watchparty.json'):null;this.preferences={sync:{...Protocol.DEFAULT_SYNC},shareSource:false};
    if(this.file)try{this.preferences=preferences(this.preferences,JSON.parse(fs.readFileSync(this.file,'utf8')));}catch{}
    this.epoch=0;this.socketEpoch=0;this.inboxEpoch=0;this.requests=new Map();this.invites=new Map();this.connection='idle';this.room=null;this.code=null;this.telemetry={state:'idle',rtt:null,drift:null};this.accountId=cloud.user?.id||null;
    this.playback=new (require('./watchparty-playback').PartyPlayback)(this);
    player.onPartyEvent=(type,data)=>this.playback.event(type,data);
    player.allowPartyAutoplay=()=>!this.room||this.isHost();
    player.allowPartyAutomaticSkip=()=>!this.room||this.isHost();
  }
  isHost(){return !!this.room&&this.room.hostId===this.participantId;}
  snapshot(){return {connection:this.connection,room:this.room,code:this.code,participantId:this.participantId||null,authenticated:!!this.cloud.user,
    invites:[...this.invites.values()].filter(v=>v.expires>Date.now()).map(({uiId,from,expires})=>({id:uiId,from,expires})),telemetry:{...this.telemetry},preferences:this.preferences,error:this.error||null,needsSource:this.playback.needsSource||false};}
  publish(){this.notify('watchparty:state',this.snapshot());}
  osd(message){this.player.cur?.session.send(['show-text','Watch Party · '+String(message).replace(/[\r\n]/g,' ').slice(0,180),2200]);}
  async authorization(name){
    const registered=await this.cloud.watchPartyCredentials();if(registered)return 'Bearer '+registered.accessToken;
    if(this.cloud.user)throw Error('Accesso account temporaneamente non disponibile');
    if(!this.guest||this.guest.expires<Date.now()+300000){const previous=this.guest?.expires>Date.now()?'Guest '+this.guest.token:undefined;this.guest=await this.http('/api/v1/guests',{name:name||this.guestName||'Ospite'},previous);}
    this.guestName=name||this.guestName||'Ospite';return 'Guest '+this.guest.token;
  }
  async http(route,data={},authorization){
    const response=await this.fetch(this.baseUrl+route,{method:'POST',headers:{'Content-Type':'application/json',...(authorization?{Authorization:authorization}:{})},body:JSON.stringify(data),signal:AbortSignal.timeout(10000)});
    const result=await response.json();if(!response.ok){const error=Error(result.error||'Watch Party non disponibile');error.status=response.status;throw error;}return result;
  }
  async begin(kind,input={}){
    if(this.joinBusy)throw Error('Connessione già in corso');this.joinBusy=true;
    try{await this.leave();const epoch=this.epoch;const auth=await this.authorization(String(input.name||'').slice(0,48));
      const code=kind==='join'?Protocol.code(input.code):null;const grant=await this.http(code?'/api/v1/rooms/'+code+'/ticket':'/api/v1/rooms',{private:!!input.private,invite:input.invite},auth);
      if(epoch!==this.epoch)throw Error('Connessione annullata');this.code=grant.code;this.error=null;await this.connect(grant,epoch);return this.snapshot();
    }finally{this.joinBusy=false;}
  }
  create(input){return this.begin('create',input);}
  join(input){return this.begin('join',input);}
  async connect(grant,epoch){
    if(epoch!==this.epoch)return;
    if(grant.pending){this.connection='approval';this.publish();this.reconnectTimer=setTimeout(()=>this.reconnect(epoch),3000);return;}
    const seq=++this.socketEpoch;this.participantId=grant.participantId;this.connection='connecting';this.publish();
    const ws=new this.Socket(this.baseUrl.replace(/^http/,'ws')+'/api/v1/rooms/'+this.code+'/socket',['watchparty.v1','ticket.'+grant.ticket],{maxPayload:1048576,handshakeTimeout:10000});this.socket=ws;
    await new Promise((resolve,reject)=>{
      let ready=false;const timer=setTimeout(()=>{if(!ready){ws.terminate();reject(Error('Timeout Watch Party'));}},10000);
      ws.on('message',bytes=>{if(epoch!==this.epoch||seq!==this.socketEpoch)return;try{const message=JSON.parse(bytes.toString());if(message.v!==1)return;
        if(message.type==='state'){
          const previous=this.room;this.room=message.room;this.connection='connected';this.retry=0;this.error=null;
          if(this.clockOffset==null)this.clockOffset=(message.serverTime||Date.now())-Date.now();
          if(!ready){ready=true;clearTimeout(timer);resolve();this.startTimers(epoch);}
          this.playback.accept(previous,message).catch(()=>{this.playback.needsSource=true;this.publish();});
          const labels={joined:'È entrato '+(message.details?.name||'un partecipante'),disconnected:'Connessione interrotta: '+(message.details?.name||'partecipante'),'host-changed':'Nuovo host: '+(message.details?.name||''),permissions:'Permessi aggiornati',moderation:'Partecipanti aggiornati'};
          if(labels[message.event])this.osd(labels[message.event]);this.publish();
        }else if(message.type==='pong'){
          const now=Date.now(),rtt=now-message.clientTime;if(rtt>=0&&rtt<10000){this.samples=(this.samples||[]).concat({rtt,offset:message.serverTime-(message.clientTime+now)/2}).slice(-8);const best=[...this.samples].sort((a,b)=>a.rtt-b.rtt)[0];this.clockOffset=best.offset;this.telemetry.rtt=rtt;}
        }else if(message.type==='removed'){this.error=message.reason==='ban'?'Sei stato bannato da questa stanza':'Sei uscito dalla stanza';this.leave().then(()=>this.publish());}
        else if(message.type==='ack'||message.type==='error'){
          const pending=this.requests.get(message.id);if(pending){clearTimeout(pending.timer);this.requests.delete(message.id);message.type==='ack'?pending.resolve():pending.reject(Error(message.message||'Comando rifiutato'));}
        }
      }catch{ws.close(4002,'Protocollo non valido');}});
      ws.on('error',()=>{if(!ready){clearTimeout(timer);reject(Error('Connessione Watch Party non disponibile'));}});
      ws.on('close',(code)=>{clearTimeout(timer);if(epoch!==this.epoch||seq!==this.socketEpoch)return;this.stopTimers();this.rejectRequests();
        if(!ready)reject(Error('Connessione Watch Party interrotta'));
        if(code===4003||code===4008){this.code=null;this.room=null;this.connection='idle';this.playback.reset();this.publish();return;}
        this.connection='reconnecting';this.osd('Connessione persa');this.publish();this.scheduleReconnect(epoch);
      });
    });
  }
  startTimers(epoch){this.stopTimers();this.pingTimer=setInterval(()=>this.send({type:'ping',clientTime:Date.now()}),10000);this.send({type:'ping',clientTime:Date.now()});
    this.tickTimer=setInterval(()=>this.playback.tick().catch(()=>{}),500);this.tickTimer.unref?.();this.refreshTimer=setTimeout(()=>this.reconnect(epoch),240000);}
  stopTimers(){clearInterval(this.pingTimer);clearInterval(this.tickTimer);clearTimeout(this.refreshTimer);}
  scheduleReconnect(epoch){clearTimeout(this.reconnectTimer);const wait=Math.min(5000,300*2**Math.min(5,this.retry||0))+Math.random()*200;this.retry=(this.retry||0)+1;this.reconnectTimer=setTimeout(()=>this.reconnect(epoch),wait);}
  async reconnect(epoch){
    if(epoch!==this.epoch||!this.code)return;
    try{const auth=await this.authorization();const grant=await this.http('/api/v1/rooms/'+this.code+'/ticket',{},auth);if(epoch!==this.epoch)return;const old=this.socket;await this.connect(grant,epoch);if(old&&old!==this.socket)old.close(1000,'Credenziale rinnovata');this.osd('Connessione ripristinata');}
    catch(error){if(epoch!==this.epoch)return;this.error=error.message;
      if([403,404].includes(error.status)){await this.leave();this.publish();}else{this.connection='reconnecting';this.publish();this.scheduleReconnect(epoch);}}
  }
  send(data){if(this.socket?.readyState===1){this.socket.send(JSON.stringify({v:1,...data}));return true;}return false;}
  rpc(data){if(this.connection!=='connected')return Promise.reject(Error('Watch Party non connesso'));const id=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.requests.delete(id);reject(Error('Comando non confermato'));},8000);this.requests.set(id,{resolve,reject,timer});if(!this.send({...data,id})){clearTimeout(timer);this.requests.delete(id);reject(Error('Connessione persa'));}});}
  rejectRequests(){for(const p of this.requests.values()){clearTimeout(p.timer);p.reject(Error('Connessione persa'));}this.requests.clear();}
  command(action,data={}){if(!Protocol.PERMISSIONS.includes(action))throw Error('Comando non valido');return this.rpc({type:'command',action,epoch:this.room?.playback?.epoch,...data});}
  permissions(permissions){return this.rpc({type:'permissions',permissions});}
  moderate(action,target){return this.rpc({type:'moderate',action,target});}
  resyncAll(){if(!this.isHost())throw Error('Solo l’host può risincronizzare tutti');if(!this.room.playback)throw Error('Nessun contenuto condiviso');return this.rpc({type:'resync-all',epoch:this.room.playback.epoch});}
  async leave(){
    ++this.epoch;++this.socketEpoch;clearTimeout(this.reconnectTimer);this.stopTimers();this.rejectRequests();const ws=this.socket;this.socket=null;this.room=null;this.code=null;this.participantId=null;this.connection='idle';this.playback.reset();
    if(ws&&ws.readyState===1){ws.send(JSON.stringify({v:1,type:'leave'}));ws.close(1000,'Uscita');}else ws?.terminate();this.publish();
  }
  configure(patch){
    this.preferences=preferences(this.preferences,patch);
    if(this.file){fs.mkdirSync(path.dirname(this.file),{recursive:true});const tmp=this.file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(this.preferences));fs.renameSync(tmp,this.file);}this.publish();return this.snapshot();
  }
  async invite(userId){if(!this.code)throw Error('Entra prima in una stanza');const epoch=this.epoch,auth=await this.authorization();if(epoch!==this.epoch)throw Error('Stanza cambiata');return this.http('/api/v1/rooms/'+this.code+'/invite',{userId},auth);}
  receiveInvites(items){const next=new Map();for(const item of items||[]){if(typeof item.id!=='string'||item.expires<=Date.now())continue;const old=this.invites.get(item.id);next.set(item.id,{...item,uiId:old?.uiId||randomUUID()});}const added=[...next.keys()].some(k=>!this.invites.has(k));this.invites=next;if(added)this.osd('Hai ricevuto un invito');this.publish();}
  async acceptInvite(uiId){const invite=[...this.invites.values()].find(i=>i.uiId===uiId&&i.expires>Date.now());if(!invite)throw Error('Invito scaduto');await this.join({code:invite.code,invite:invite.id});this.invites.delete(invite.id);this.publish();return this.snapshot();}
  async dismissInvite(uiId){const found=[...this.invites.values()].find(i=>i.uiId===uiId);if(found){await this.http('/api/v1/inbox/dismiss',{id:found.id},await this.authorization());this.invites.delete(found.id);this.publish();}}
  accountChanged(state){const id=state.user?.id||null;if(id!==this.accountId){this.accountId=id;this.guest=null;this.leave();this.closeInbox();}if(id&&!this.inboxSocket&&!this.inboxConnecting)this.openInbox();}
  async openInbox(){
    if(this.stopped||!this.cloud.user||this.inboxConnecting)return;this.inboxConnecting=true;const epoch=this.inboxEpoch;
    try{const auth=await this.authorization(),grant=await this.http('/api/v1/inbox/ticket',{},auth);if(epoch!==this.inboxEpoch)return;
      const old=this.inboxSocket,ws=new this.Socket(this.baseUrl.replace(/^http/,'ws')+'/api/v1/inbox/'+grant.userId+'/socket',['watchparty.v1','ticket.'+grant.ticket],{handshakeTimeout:10000,maxPayload:1048576});this.inboxSocket=ws;old?.close();
      ws.on('message',bytes=>{if(epoch!==this.inboxEpoch||ws!==this.inboxSocket)return;try{const m=JSON.parse(bytes.toString());if(m.type==='invites')this.receiveInvites(m.invites);}catch{}});
      ws.on('error',()=>{});ws.on('close',()=>{if(ws!==this.inboxSocket||epoch!==this.inboxEpoch)return;this.inboxSocket=null;clearTimeout(this.inboxRefresh);this.inboxRefresh=setTimeout(()=>this.openInbox(),5000);});
      clearTimeout(this.inboxRefresh);this.inboxRefresh=setTimeout(()=>this.openInbox(),240000);
    }catch{if(epoch===this.inboxEpoch&&!this.stopped)this.inboxRefresh=setTimeout(()=>this.openInbox(),10000);}finally{this.inboxConnecting=false;if(epoch!==this.inboxEpoch&&this.cloud.user&&!this.stopped)this.openInbox();}
  }
  closeInbox(){++this.inboxEpoch;clearTimeout(this.inboxRefresh);this.inboxSocket?.close();this.inboxSocket=null;this.invites.clear();this.publish();}
  start(){this.stopped=false;this.accountChanged(this.cloud.status());}
  async stop(){this.stopped=true;this.closeInbox();await this.leave();}
}
module.exports={WatchPartyService,ENDPOINT};
