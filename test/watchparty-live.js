'use strict';
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const {socket,wait,delay}=require('./watchparty-fixture'),{ENDPOINT}=require('../src/watchparty');
const peers=[],cases=[],out=path.join(__dirname,'..','outputs','watchparty-0.5.55','worker-live.json');
async function post(route,data,auth){const r=await fetch(ENDPOINT+route,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:auth}:{})},body:JSON.stringify(data),signal:AbortSignal.timeout(10000)});return {status:r.status,...await r.json()};}
(async()=>{try{
  const health=await (await fetch(ENDPOINT+'/health')).json();assert.deepEqual([health.ok,health.protocol,health.maxParticipants,health.accounts,health.guests],[true,1,16,true,true]);
  const a=await post('/api/v1/guests',{name:'Verification host'}),b=await post('/api/v1/guests',{name:'Verification member'});assert.equal(a.status,200);assert.equal(b.status,200);const authA='Guest '+a.token,authB='Guest '+b.token;
  const room=await post('/api/v1/rooms',{},authA),host=await socket(ENDPOINT,room.code,room.ticket);peers.push(host);
  const grant=await post('/api/v1/rooms/'+room.code+'/ticket',{},authB),member=await socket(ENDPOINT,room.code,grant.ticket);peers.push(member);await wait(()=>host.room.participants.length===2);cases.push('Deployed endpoint, two real WebSocket upgrades and room isolation grants');
  await host.command({type:'command',action:'content',content:{key:'verification:055',kind:'custom',title:'Synthetic verification'}});await wait(()=>host.room.playback);const epoch=host.room.playback.epoch;
  await host.command({type:'snapshot',key:'verification:055',epoch,position:12,duration:100,speed:1,paused:true,buffering:false});await wait(()=>member.room.playback?.position===12);
  assert.equal((await member.command({type:'command',action:'playPause',paused:false,epoch})).status,403);cases.push('Host playback snapshot and denied guest shared command');
  await delay(20000);await member.command({type:'resync'});assert.equal(member.room.playback.position,12);assert.equal(member.room.participants.length,2);cases.push('State and sockets survive 20 seconds idle; hibernation API configured (runtime eviction not asserted)');
  const previousHost=host.room.hostId,disconnectedAt=Date.now();host.ws.terminate();await wait(()=>member.room.participants.some(p=>p.id===previousHost&&!p.connected),10000);await delay(1000);assert.equal(member.room.hostId,previousHost);
  await wait(()=>member.room.hostId!==previousHost,40000);const electionMs=Date.now()-disconnectedAt;assert.ok(electionMs>=29500);cases.push({case:'Production 30-second reconnect reservation and host election',electionMs});
  await member.leave();assert.equal((await post('/api/v1/rooms/'+room.code+'/ticket',{},authB)).status,404);cases.push('Final departure deletes deployed room');
  fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify({ok:true,endpoint:ENDPOINT,health,cases,completedAt:new Date().toISOString()},null,2));console.log('WORKER_LIVE_PASS');
 }catch(e){fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify({ok:false,cases,error:e.stack},null,2));console.error(e);process.exitCode=1;}finally{for(const p of peers)p.ws.terminate();}})();
