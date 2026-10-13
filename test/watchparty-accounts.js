'use strict';
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const {Store}=require('../src/store'),{startWorker,wait,delay}=require('./watchparty-fixture'),{launch}=require('./watchparty-process');
const live=process.env.ANIME_PLAYER_ACCOUNT_LIVE==='1';
const root=path.resolve(__dirname,'..'),dir=process.env.ANIME_PLAYER_ACCOUNT_FIXTURE_DIR?path.resolve(process.env.ANIME_PLAYER_ACCOUNT_FIXTURE_DIR):path.join(root,'work','watchparty-0.5.55','accounts-'+Date.now()),out=path.join(root,'outputs','watchparty-0.5.55',live?'accounts-live.json':'accounts.json');
if(!dir.startsWith(path.join(root,'work')+path.sep))throw Error('Account fixtures must stay inside work/');
const peers=[];let f;
async function ui(peer,code){return peer.rpc('ui',{code});}
async function click(peer,text){return ui(peer,`(()=>{document.querySelector('#dialog-root .icon-btn')?.click();const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)throw Error('Button missing');b.click();})()`);}
(async()=>{try{
  if(!live)f=await startWorker({realAuth:true,grace:30000});fs.mkdirSync(dir,{recursive:true});
  for(let i=0;i<2;i++){const profile=path.join(dir,'account-'+(i+1)),store=new Store(path.join(profile,'library.json'));store.setSettings({language:'it',onboardingComplete:true});store.save(true);clearTimeout(store._timer);fs.copyFileSync(path.join(root,'.build-resources','inputs','supabase-public.json'),path.join(profile,'supabase-config.json'));peers.push(launch(profile,f?.base,{accounts:true,title:'Watch Party · Account di prova '+(i+1)}));}
  await Promise.all(peers.map(p=>p.ready));console.log('LOGIN_READY: Accedi ai due account di prova nelle due finestre. Libreria e cronologia non vengono sincronizzate.');
  const readAccounts=()=>Promise.all(peers.map(p=>p.rpc('account').catch(()=>({id:null,friends:[]}))));
  let accounts;await wait(async()=>{accounts=await readAccounts();if(!accounts.every(a=>a.id))await delay(5000);return accounts.every(a=>a.id);},1800000);
  assert.notEqual(accounts[0].id,accounts[1].id,'Servono due account distinti');
  if(!accounts[0].friends.some(friend=>friend.id===accounts[1].id)){console.log('FRIENDSHIP_REQUIRED: I due account devono essere amici. Puoi usare la pagina Social in queste finestre.');await wait(async()=>{await delay(5000);accounts=await readAccounts();return accounts.every(a=>a.id)&&accounts[0].friends.some(friend=>friend.id===accounts[1].id);},1800000);}
  await Promise.all(peers.map(p=>p.rpc('leave')));
  await click(peers[0],'Watch Party');await ui(peers[0],"document.querySelector('[data-party=private]').checked=true");await click(peers[0],'Crea stanza');await wait(async()=> (await peers[0].rpc('info')).party.connection==='connected');
  await click(peers[0],'Mostra amici');await delay(1000);await ui(peers[0],`document.querySelector('[data-party-friend="${accounts[1].id}"] button').click()`);
  await wait(async()=> (await peers[1].rpc('info')).party.invites.length>0);await click(peers[1],'Watch Party');await click(peers[1],'Accetta');await wait(async()=> (await peers[0].rpc('info')).party.room.participants.length===2);
  const room=(await peers[0].rpc('info')).party.room;assert.ok(room.participants.every(p=>!p.guest));assert.ok(room.private);
  await peers[0].rpc('leave');await peers[1].rpc('leave');
  fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify({ok:true,backend:live?require('../src/watchparty').ENDPOINT:f.base,completedAt:new Date().toISOString(),cases:['Two distinct real Supabase accounts authenticated in production CloudService','Existing RLS friendship and friend list','Private host room, invitation via production UI and real Supabase verification','Recipient in-app invitation and join without entering a room code','Two registered participants; clean leave'],librarySync:'Disabled in interactive fixture; no synthetic library/history upload'},null,2));console.log('ACCOUNTS_PASS');
 }catch(e){fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify({ok:false,error:e.message},null,2));console.error(e);process.exitCode=1;}finally{for(const p of peers)try{await p.rpc('quit');}catch{}await delay(2000);await f?.stop();}})();
