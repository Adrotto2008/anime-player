import {DurableObject} from 'cloudflare:workers';
import {Actor,Member,Room,PartyEnv,json,deny,PartyError,randomToken,failure} from './types';
import Protocol from '../../src/watchparty-protocol';
type Connection={actor:Actor;session:string;window:number;count:number;lastSeen:number;playback?:any;localState?:{localPaused:boolean;buffering:boolean}};
export class RoomObject extends DurableObject<PartyEnv>{
  room:Room|null=null;
  tickets:Record<string,{actor:Actor;expires:number}>={};
  constructor(ctx:DurableObjectState,env:PartyEnv){
    super(ctx,env);
    ctx.blockConcurrencyWhile(async()=>{
      this.room=(await ctx.storage.get<Room>('room'))||null;
      this.tickets=(await ctx.storage.get<typeof this.tickets>('tickets'))||{};
      if(this.room){
        for(const m of Object.values(this.room.members)){if(m.connected)m.offlineUntil=Date.now()+this.grace();m.connected=false;}
        for(const ws of ctx.getWebSockets()){
          const c=ws.deserializeAttachment() as Connection;
          if(c&&this.room.members[c.actor.id]&&ws.readyState===1){this.room.members[c.actor.id].connected=true;delete this.room.members[c.actor.id].offlineUntil;
            if(c.localState)Object.assign(this.room.members[c.actor.id],c.localState);
            if(c.actor.id===this.room.hostId&&c.playback?.seq>this.room.playback?.seq)this.room.playback=c.playback;}
        }
      }
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('keepalive','alive'));
  }
  max(){return Math.max(2,Math.min(64,Number(this.env.ROOM_MAX_PARTICIPANTS)||16));}
  grace(){return Math.max(1000,Math.min(120000,Number(this.env.RECONNECT_GRACE_MS)||30000));}
  sockets(id?:string){return this.ctx.getWebSockets().filter(ws=>ws.readyState===1&&(!id||(ws.deserializeAttachment() as Connection)?.actor.id===id));}
  requireRoom(){if(!this.room)deny(404,'Stanza terminata o inesistente');return this.room!;}
  host(actor:Actor){const r=this.requireRoom();if(actor.id!==r.hostId||!r.members[actor.id]?.connected)deny(403,'Operazione riservata all’host');return r;}
  view(actorId?:string){const r=this.requireRoom();return {code:r.code,private:r.private,hostId:r.hostId,permissions:r.allowed,revision:r.revision,
    participants:Object.values(r.members).map(({until,offlineUntil,...m})=>m),playback:r.playback,
    pending:actorId===r.hostId?Object.values(r.pending).map(({until,...m})=>m):[],bans:actorId===r.hostId?r.bans:{}};}
  send(ws:WebSocket,data:unknown){try{ws.send(JSON.stringify({v:1,...data as object}));}catch{}}
  broadcast(event?:string,details?:unknown){if(!this.room)return;for(const ws of this.sockets()){const c=ws.deserializeAttachment() as Connection;this.send(ws,{type:'state',room:this.view(c.actor.id),event,details,serverTime:Date.now()});}}
  async persist(){if(this.room){this.room.revision++;await this.ctx.storage.put('room',this.room);await this.schedule();}}
  async schedule(){if(!this.room)return;const r=this.room;const deadlines=[...Object.values(r.members).map(m=>m.offlineUntil||m.until),...Object.values(r.pending).map(a=>a.until),...Object.values(r.invites).map(i=>i.expires),...Object.values(this.tickets).map(t=>t.expires)];
    deadlines.push(...Object.values(r.rejected||{}));if(deadlines.length)await this.ctx.storage.setAlarm(Math.max(Date.now()+500,Math.min(...deadlines)));}
  async create(actor:Actor,code:string,isPrivate:boolean){if(this.room)deny(409,'Codice già utilizzato');
    this.room={code,private:!!isPrivate,hostId:actor.id,members:{[actor.id]:{...actor,connected:false,offlineUntil:Date.now()+this.grace()}},pending:{},bans:{},allowed:Object.fromEntries(Protocol.PERMISSIONS.map(p=>[p,false])),invites:{},revision:0,playback:null,createdAt:Date.now()};
    await this.persist();return {code};}
  async ticket(actor:Actor,invite?:string){
    const r=this.requireRoom(),now=Date.now();
    if(r.bans[actor.id])deny(403,'Identità bannata da questa stanza');
    const existing=r.members[actor.id];
    const invitation=invite&&r.invites[invite];
    if(r.private&&!existing&&!(invitation&&invitation.userId===actor.id&&invitation.expires>now)){
      if((r.rejected?.[actor.id]||0)>now)deny(403,'Richiesta rifiutata dall’host');
      if(Object.keys(r.pending).length>=this.max()*2&&!r.pending[actor.id])deny(429,'Troppe richieste in attesa');
      r.pending[actor.id]={...actor,until:Math.min(actor.until,now+60000)};await this.persist();this.broadcast('approval-request');return {pending:true};
    }
    if(!existing&&Object.keys(r.members).length>=this.max())deny(409,'La stanza ha raggiunto il limite configurato');
    if(invitation)delete r.invites[invite!];
    r.members[actor.id]={...existing,...actor,connected:existing?.connected||false,...(!existing?{offlineUntil:now+this.grace()}:{})};delete r.pending[actor.id];
    // Bounded, one-use upgrade tickets. Reissuing invalidates earlier tickets for this actor.
    for(const [key,t]of Object.entries(this.tickets))if(t.actor.id===actor.id||t.expires<=now)delete this.tickets[key];
    const token=randomToken();this.tickets[token]={actor,expires:now+30000};
    await this.ctx.storage.put('tickets',this.tickets);await this.persist();return {ticket:token,participantId:actor.id};
  }
  async invite(actor:Actor,userId:string){const r=this.host(actor);if(Object.keys(r.invites).length>=128)deny(429,'Troppi inviti attivi');const token=randomToken(),expires=Date.now()+600000;r.invites[token]={userId,expires};await this.persist();return {id:token,code:r.code,from:actor.name,expires};}
  async fetch(request:Request){
    try{
      if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return json({error:'WebSocket richiesto'},426);
      const protocols=(request.headers.get('Sec-WebSocket-Protocol')||'').split(',').map(p=>p.trim());
      const ticket=protocols.find(p=>p.startsWith('ticket.'))?.slice(7),grant=ticket?this.tickets[ticket]:null;
      if(!grant||grant.expires<=Date.now())deny(401,'Ticket scaduto, revocato o già usato');
      const r=this.requireRoom(),actor=grant!.actor;
      if(r.bans[actor.id]||!r.members[actor.id]||actor.until<=Date.now())deny(403,'Accesso revocato');
      delete this.tickets[ticket!];await this.ctx.storage.put('tickets',this.tickets);
      for(const old of this.sockets(actor.id))old.close(4001,'Sessione sostituita');
      const pair=new WebSocketPair(),server=pair[1];
      server.serializeAttachment({actor,session:crypto.randomUUID(),window:Date.now(),count:0,lastSeen:Date.now()} satisfies Connection);
      this.ctx.acceptWebSocket(server,[actor.id]);r.members[actor.id].connected=true;delete r.members[actor.id].offlineUntil;
      if(!r.members[r.hostId])r.hostId=actor.id;
      await this.persist();this.broadcast('joined',{id:actor.id,name:actor.name});
      return new Response(null,{status:101,webSocket:pair[0],headers:{'Sec-WebSocket-Protocol':'watchparty.v1'}});
    }catch(error){const result=failure(error);return json({error:result.message},result.status);}
  }
  async webSocketMessage(ws:WebSocket,message:string|ArrayBuffer){
    const c=ws.deserializeAttachment() as Connection;
    try{
      const r=this.requireRoom();if(!c||!this.sockets(c.actor.id).includes(ws)||r.bans[c.actor.id]||!r.members[c.actor.id])deny(403,'Accesso revocato');
      const now=Date.now();if(c.actor.until<=now){ws.close(4004,'Credenziale scaduta');return;}
      if(typeof message!=='string'||message.length>16384)deny(413,'Messaggio troppo grande');
      if(now-c.window>=1000){c.window=now;c.count=0;}c.count++;c.lastSeen=now;ws.serializeAttachment(c);if(c.count>15)deny(429,'Troppi messaggi');
      const data=JSON.parse(String(message));if(data.v!==1||typeof data.type!=='string')deny(400,'Protocollo non valido');
      const id=typeof data.id==='string'?data.id.slice(0,80):undefined;
      const host=c.actor.id===r.hostId;
      if(data.type==='ping'){this.send(ws,{type:'pong',id,clientTime:data.clientTime,serverTime:now});}
      else if(data.type==='resync'){this.send(ws,{type:'state',room:this.view(c.actor.id),serverTime:now});}
      else if(data.type==='resync-all'){
        this.host(c.actor);if(!r.playback||data.epoch!==r.playback.epoch)deny(409,'Contenuto non corrente');
        this.broadcast('resync-all',{actorId:c.actor.id});
      }
      else if(data.type==='local-status'){
        const m=r.members[c.actor.id];c.localState={localPaused:!!data.localPaused,buffering:!!data.buffering};Object.assign(m,c.localState);this.broadcast();
      }
      else if(data.type==='snapshot'){
        if(!host)deny(403,'Snapshot riservato all’host');
        if(!r.playback||data.epoch!==r.playback.epoch||data.key!==r.playback.content.key)deny(409,'Contenuto non corrente');
        this.updatePlayback(data,now);c.playback=r.playback;this.broadcast();
      }
      else if(data.type==='command'){
        const action=data.action;
        if(!Protocol.PERMISSIONS.includes(action)||(!host&&!r.allowed[action]))deny(403,'Comando non consentito');
        if(action==='content'){
          const content=Protocol.content(data.content);r.playback={content,epoch:crypto.randomUUID(),seq:(r.playback?.seq||0)+1,position:0,duration:0,paused:false,speed:1,buffering:true,serverTime:now};
        }else{
          if(!r.playback||data.epoch!==r.playback.epoch)deny(409,'Contenuto non corrente');
          const current=r.playback;current.position+=current.paused||current.buffering?0:Math.max(0,(now-current.serverTime)/1000)*current.speed;current.serverTime=now;current.seq++;
          if(action==='playPause'){if(typeof data.paused!=='boolean')deny(400,'Pausa non valida');current.paused=data.paused;}
          else{const position=Number(data.position);if(!Number.isFinite(position)||position<0||position>86400||(current.duration>0&&position>current.duration+3))deny(400,'Posizione non valida');current.position=position;}
        }
        c.playback=host?r.playback:c.playback;await this.persist();this.broadcast('command',{action,actorId:c.actor.id});
      }
      else if(data.type==='permissions'){
        this.host(c.actor);for(const permission of Protocol.PERMISSIONS)if(typeof data.permissions?.[permission]!=='boolean')deny(400,'Permessi non validi');
        r.allowed=Object.fromEntries(Protocol.PERMISSIONS.map(permission=>[permission,data.permissions[permission]]));
        await this.persist();this.broadcast('permissions');
      }
      else if(data.type==='moderate'){
        this.host(c.actor);const target=String(data.target||'');if(target===r.hostId)deny(400,'L’host non può espellere se stesso');
        if(data.action==='unban'){delete r.bans[target];}
        else if(data.action==='approve'){const actor=r.pending[target];if(!actor||actor.until<=now)deny(404,'Richiesta scaduta');if(Object.keys(r.members).length>=this.max())deny(409,'Stanza piena');r.members[target]={...actor,until:now+300000,connected:false,offlineUntil:now+this.grace()};delete r.pending[target];}
        else if(data.action==='reject'){if(!r.pending[target])deny(404,'Richiesta assente');r.rejected??={};r.rejected[target]=now+60000;delete r.pending[target];}
        else if(['kick','ban'].includes(data.action)){
          const m=r.members[target];if(!m)deny(404,'Partecipante assente');if(data.action==='ban')r.bans[target]=m.name;
          this.remove(target,data.action);}
        else deny(400,'Moderazione non valida');
        await this.persist();this.broadcast('moderation');
      }
      else if(data.type==='leave'){this.remove(c.actor.id,'left');await this.clean();return;}
      else deny(400,'Messaggio non supportato');
      ws.serializeAttachment(c);if(id)this.send(ws,{type:'ack',id});
    }catch(error){const status=error instanceof PartyError?error.status:400;this.send(ws,{type:'error',id:(()=>{try{return JSON.parse(String(message)).id;}catch{return undefined;}})(),status,message:error instanceof PartyError?failure(error).message:'Messaggio non valido'});if(status===429||status===413)ws.close(4008,'Limite messaggi');}
  }
  updatePlayback(data:any,now:number){
    const r=this.requireRoom(),p=r.playback;const pos=Number(data.position),duration=Number(data.duration),speed=Number(data.speed);
    if(!Number.isFinite(pos)||pos<0||pos>86400||!Number.isFinite(duration)||duration<0||duration>86400||!Number.isFinite(speed)||speed<.1||speed>4)deny(400,'Stato riproduzione non valido');
    const sample=Number(data.sampleServerTime),age=Number.isFinite(sample)?Math.max(0,Math.min(10000,now-sample)):0;
    p.position=pos+(!data.paused&&!data.buffering?age/1000*speed:0);p.duration=duration;p.paused=!!data.paused;p.speed=speed;p.buffering=!!data.buffering;p.serverTime=now;p.seq++;
  }
  remove(id:string,reason:string){if(!this.room)return;for(const ws of this.sockets(id)){this.send(ws,{type:'removed',reason});ws.close(4003,reason);}delete this.room.members[id];delete this.room.pending[id];for(const [t,grant]of Object.entries(this.tickets))if(grant.actor.id===id)delete this.tickets[t];}
  async clean(){
    if(!this.room)return;const r=this.room,now=Date.now();
    for(const [id,m]of Object.entries(r.members)){
      if(m.connected&&m.until<=now){for(const ws of this.sockets(id))ws.close(4004,'Credenziale scaduta');m.connected=false;m.offlineUntil=now+this.grace();}
      if(!m.connected&&(m.offlineUntil||0)<=now)this.remove(id,'timeout');
    }
    for(const [id,a]of Object.entries(r.pending))if(a.until<=now)delete r.pending[id];
    for(const [id,until]of Object.entries(r.rejected||{}))if(until<=now)delete r.rejected![id];
    for(const [token,i]of Object.entries(r.invites))if(i.expires<=now)delete r.invites[token];
    for(const [t,g]of Object.entries(this.tickets))if(g.expires<=now)delete this.tickets[t];
    if(!Object.keys(r.members).length){this.room=null;this.tickets={};await this.ctx.storage.deleteAll();return;}
    if(!r.members[r.hostId]){
      const connected=Object.values(r.members).filter(m=>m.connected);
      if(connected.length){const index=crypto.getRandomValues(new Uint32Array(1))[0]%connected.length;r.hostId=connected[index].id;this.broadcast('host-changed',{name:connected[index].name});}
    }
    await this.ctx.storage.put('tickets',this.tickets);await this.persist();this.broadcast();
  }
  async webSocketClose(ws:WebSocket){await this.disconnected(ws);}
  async webSocketError(ws:WebSocket){await this.disconnected(ws);}
  async disconnected(ws:WebSocket){
    if(!this.room)return;const c=ws.deserializeAttachment() as Connection;if(!c)return;
    if(this.sockets(c.actor.id).some(other=>other!==ws))return;
    const m=this.room.members[c.actor.id];if(!m)return;
    if(c.actor.id===this.room.hostId&&c.playback?.seq>this.room.playback?.seq)this.room.playback=c.playback;
    m.connected=false;m.offlineUntil=m.offlineUntil||Date.now()+this.grace();await this.persist();this.broadcast('disconnected',{name:m.name});
  }
  async alarm(){await this.clean();}
}
