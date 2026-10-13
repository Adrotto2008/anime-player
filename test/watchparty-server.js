'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const {startWorker,socket,wait,delay}=require('./watchparty-fixture');
let f;const peers=[];
before(async()=>{f=await startWorker();}, {timeout:40000});
after(async()=>{for(const p of peers)p.ws.terminate();await f?.stop();});
async function create(auth,privateRoom=false){const r=await f.post('/api/v1/rooms',{private:privateRoom},auth);assert.equal(r.status,200);const p=await socket(f.base,r.code,r.ticket);peers.push(p);return p;}
async function join(host,auth,extra={}){const r=await f.post('/api/v1/rooms/'+host.room.code+'/ticket',extra,auth);assert.equal(r.status,200);const p=await socket(f.base,r.code,r.ticket);peers.push(p);return p;}
const content={key:'catalog:1:episode:1',kind:'catalog',title:'Synthetic episode',anilistId:1,number:1};
test('HTTP admission rate and streamed body bounds are enforced before authentication',async()=>{
  for(let i=0;i<13;i++){const result=await f.post('/api/v1/guests',{name:'Rate fixture'},undefined,'rate-fixture');assert.equal(result.status,i===12?429:200);}
  const bytes=Buffer.from('x'.repeat(17000));const stream=new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,8000));controller.enqueue(bytes.subarray(8000));controller.close();}});
  const response=await fetch(f.base+'/api/v1/guests',{method:'POST',body:stream,duplex:'half',headers:{'Content-Type':'application/json','CF-Connecting-IP':'stream-fixture'}});assert.equal(response.status,413);
});
test('room cap, expired signed identity, stale playback commands and inbox isolation',async()=>{
  const auth=await f.guest('Host'),host=await create(auth),members=[];
  for(let i=0;i<15;i++)members.push(await join(host,await f.guest('Guest '+i)));
  assert.equal((await f.post('/api/v1/rooms/'+host.room.code+'/ticket',{},await f.guest('Excess'))).status,409);
  await host.command({type:'command',action:'content',content});await wait(()=>host.room.playback);const old=host.room.playback.epoch;
  await host.command({type:'command',action:'content',content:{...content,key:'catalog:1:episode:2',number:2}});await wait(()=>host.room.playback.content.number===2);
  assert.equal((await host.command({type:'command',action:'seek',epoch:old,position:12})).status,409);
  const fs=require('fs'),path=require('path'),crypto=require('crypto'),config=JSON.parse(fs.readFileSync(path.join(f.dir,'wrangler.json'),'utf8'));
  const raw=JSON.stringify({id:'guest:'+crypto.randomUUID(),guest:true,name:'Expired',until:Date.now()-1}),payload=Buffer.from(raw).toString('base64url'),signature=crypto.createHmac('sha256',config.vars.PARTY_SIGNING_KEY).update(payload).digest('base64url');
  assert.equal((await f.post('/api/v1/rooms',{},'Guest '+payload+'.'+signature)).status,401);
  assert.equal((await f.post('/api/v1/inbox/list',{},auth)).status,403);
  for(const member of members)await member.leave();await host.leave();
});
test('real Worker: two guests, permissions, local pause, snapshots and room isolation',async()=>{
  const host=await create(await f.guest('Hòst')),member=await join(host,await f.guest('Guest'));
  await wait(()=>host.room.participants.length===2);assert.equal(member.room.hostId,host.room.hostId);
  assert.equal((await member.command({type:'command',action:'content',content})).status,403);
  await host.command({type:'command',action:'content',content});await wait(()=>member.room.playback?.content.key===content.key);
  const epoch=host.room.playback.epoch;
  assert.equal((await host.command({type:'permissions',permissions:{playPause:true,seek:null,content:false,skip:false}})).status,400);
  assert.equal((await member.command({type:'command',action:'playPause',epoch,paused:true})).status,403);
  await host.command({type:'snapshot',key:content.key,epoch,position:12,duration:100,speed:1,paused:false,buffering:false,sampleServerTime:Date.now()});
  await wait(()=>member.room.playback.position>=12);assert.equal((await member.command({type:'snapshot',key:content.key,epoch,position:30,duration:100,speed:1})).status,403);
  assert.equal((await member.command({type:'resync-all',epoch})).status,403);
  assert.equal((await host.command({type:'resync-all',epoch:'stale'})).status,409);
  const anchor=structuredClone(host.room.playback);
  await host.command({type:'resync-all',epoch});await wait(()=>member.messages.some(m=>m.event==='resync-all'));
  assert.deepEqual(host.room.playback,anchor,'Global resync preserves the authoritative playback anchor');
  await member.command({type:'local-status',localPaused:true});assert.equal(host.room.playback.paused,false);
  const permissions={playPause:true,seek:true,content:false,skip:false};await host.command({type:'permissions',permissions});
  assert.equal((await member.command({type:'resync-all',epoch})).status,403,'Shared seek permission cannot force all participants to resync');
  await member.command({type:'command',action:'seek',epoch,position:40});await wait(()=>host.room.playback.position>=40);
  assert.equal((await member.command({type:'moderate',action:'kick',target:host.room.hostId})).status,403);
  const separate=await create(await f.guest('Other'));assert.equal(separate.room.playback,null);await separate.leave();
  await member.leave();await host.leave();
});
test('private approval, ban/revoke, reconnect without duplicates and host election',async()=>{
  const hAuth=await f.guest('Host'),mAuth=await f.guest('Member');const host=await create(hAuth,true),code=host.room.code;
  const deniedAuth=await f.guest('Denied');assert.equal((await f.post('/api/v1/rooms/'+code+'/ticket',{},deniedAuth)).pending,true);await wait(()=>host.room.pending.some(p=>p.name==='Denied'));
  await host.command({type:'moderate',action:'reject',target:host.room.pending.find(p=>p.name==='Denied').id});assert.equal((await f.post('/api/v1/rooms/'+code+'/ticket',{},deniedAuth)).status,403);
  const pending=await f.post('/api/v1/rooms/'+code+'/ticket',{},mAuth);assert.equal(pending.pending,true);
  await wait(()=>host.room.pending.length===1);const id=host.room.pending[0].id;
  await host.command({type:'moderate',action:'approve',target:id});const member=await join(host,mAuth);
  member.ws.terminate();await wait(()=>host.room.participants.some(m=>m.id===id&&!m.connected));const reconnected=await join(host,mAuth);
  await wait(()=>host.room.participants.length===2&&host.room.participants.find(m=>m.id===id).connected);
  await host.command({type:'moderate',action:'ban',target:id});await wait(()=>reconnected.ws.readyState===3);
  assert.equal((await f.post('/api/v1/rooms/'+code+'/ticket',{},mAuth)).status,403);
  await host.command({type:'moderate',action:'unban',target:id});const p2=await f.post('/api/v1/rooms/'+code+'/ticket',{},mAuth);assert.equal(p2.pending,true);
  await wait(()=>host.room.pending.length);await host.command({type:'moderate',action:'approve',target:id});const final=await join(host,mAuth);
  host.ws.terminate();await wait(()=>final.room.hostId===id,10000);await final.leave();
  assert.equal((await f.post('/api/v1/rooms/'+code+'/ticket',{},mAuth)).status,404);
});
test('Supabase-authenticated friend invitation arrives in-app, private join needs no code entry',async()=>{
  const host=await create('Bearer a',true);const ticket=await f.post('/api/v1/inbox/ticket',{},'Bearer b');
  const box=await socket(f.base,'/api/v1/inbox/'+f.accounts.b+'/socket',ticket.ticket);peers.push(box);
  const response=await f.post('/api/v1/rooms/'+host.room.code+'/invite',{userId:f.accounts.b},'Bearer a');assert.equal(response.status,200);
  const invitation=await wait(()=>box.messages.flatMap(m=>m.invites||[])[0]);assert.equal(invitation.code,host.room.code);
  const member=await join(host,'Bearer b',{invite:invitation.id});await wait(()=>host.room.participants.length===2);
  assert.equal((await f.post('/api/v1/inbox/list',{},'Bearer b')).invites.length,0);
  assert.equal((await f.post('/api/v1/rooms/'+host.room.code+'/invite',{userId:f.accounts.c},'Bearer a')).status,403);
  assert.equal((await f.post('/api/v1/inbox/list',{},'Bearer invalid')).status,401);
  assert.ok(f.authCalls.some(c=>c.path==='/auth/v1/user'));await member.leave();await host.leave();box.ws.terminate();
});
test('invalid identity, ticket replay, malformed input, flooding and concurrent final leaves',async()=>{
  assert.equal((await f.post('/api/v1/rooms',{},'Guest forged.signature')).status,401);
  const auth=await f.guest('Secure'),grant=await f.post('/api/v1/rooms',{},auth);const host=await socket(f.base,grant.code,grant.ticket);peers.push(host);
  await assert.rejects(()=>socket(f.base,grant.code,grant.ticket));
  const second=await join(host,await f.guest('Second'));const code=grant.code;
  await Promise.all([host.leave(),second.leave()]);assert.equal((await f.post('/api/v1/rooms/'+code+'/ticket',{},auth)).status,404);
  const flooded=await create(await f.guest('Flood'));for(let i=0;i<20;i++)flooded.ws.send('not json');await wait(()=>flooded.ws.readyState===3);assert.ok(flooded.messages.some(m=>m.status===429));
});
