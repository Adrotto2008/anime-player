'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {Store}=require('../src/store'),{CloudService,createSessionStorage}=require('../src/cloud');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test('real SDK late uncancellable login cannot overwrite the current SDK session or encrypted storage',async t=>{
 const {cloud}=await fixture(t),first=deferred(),arrived=deferred(),originalFetch=global.fetch;
 const url='http://127.0.0.1:18999';
 cloud.config={configured:true,url,key:'synthetic-public-key'};
 cloud.safeStorage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};
 cloud._clientFactory=()=>cloud._createClient();cloud.sync=async()=>{};cloud.ensureProfile=async()=>{};
 const session=id=>{const payload=Buffer.from(JSON.stringify({sub:id,exp:Math.floor(Date.now()/1000)+3600,iat:Math.floor(Date.now()/1000)})).toString('base64url');return {access_token:'eyJhbGciOiJIUzI1NiJ9.'+payload+'.synthetic',refresh_token:'synthetic-'+id,token_type:'bearer',expires_in:3600,user:{id,email:id+'@example.invalid'}};};
 global.fetch=async(request,init)=>{assert.ok(String(request).startsWith(url+'/auth/v1/token'));const email=JSON.parse(init.body).email;if(email==='A'){arrived.resolve();await first.promise;}return new Response(JSON.stringify(session(email)),{status:200,headers:{'Content-Type':'application/json'}});};
 t.after(()=>{global.fetch=originalFetch;cloud.client?.auth.stopAutoRefresh();});
 const a=cloud.signIn('A','synthetic'),rejected=assert.rejects(a,/superata/);await arrived.promise;await cloud.signIn('B','synthetic');
 const bytes=fs.readFileSync(cloud.sessionFile);first.resolve();await rejected;
 assert.equal(cloud.user.id,'B');assert.equal((await cloud.client.auth.getSession()).data.session.user.id,'B');assert.deepEqual(fs.readFileSync(cloud.sessionFile),bytes);
});
function fake(){const listeners=[];return {listeners,auth:{onAuthStateChange:fn=>{listeners.push(fn);return {data:{subscription:{unsubscribe(){}}}};},stopAutoRefresh:async()=>{},getSession:async()=>({data:{session:null}}),signInWithPassword:async({email})=>({data:{user:{id:email},session:{user:{id:email},access_token:'synthetic-session-'+email}}})},from(){const q={};for(const key of ['select','eq','upsert','insert','update','maybeSingle','single','abortSignal'])q[key]=()=>q;q.then=(a,b)=>Promise.resolve({data:null,error:null}).then(a,b);return q;},removeAllChannels:async()=>{}};}
async function fixture(t,options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anime-logout-safety-')),store=new Store(path.join(dir,'library.json'));store.addSeries({title:'Pending A work',format:'TV'});store.save(true,true);
 const clients=[],factory=()=>{const client=fake();clients.push(client);return client;},old=factory();
 const cloud=new CloudService({store,userDataPath:dir,safeStorage:{},env:{},client:old,clientFactory:factory,logoutTimeoutMs:30,remoteSignOut:async()=>({error:null}),...options});
 cloud._scheduleSync=()=>{};cloud._session={user:{id:'A'},access_token:'synthetic-session-A'};cloud.user={id:'A'};await cloud._activateLibrary('A');
 t.after(()=>{cloud.stop();clearTimeout(store._timer);fs.rmSync(dir,{recursive:true,force:true});});return {dir,store,cloud,old,clients};
}
test('logout immediately invalidates a stalled non-cancellable private read and preserves the A outbox',async t=>{
 const gate=deferred(),{cloud,old,store,dir}=await fixture(t);const original=old.from;
 old.from=table=>{if(table!=='user_library_snapshots')return original();const q={select(){return this;},eq(){return this;},maybeSingle(){return this;},then:(a,b)=>gate.promise.then(a,b)};return q;};
 cloud.state.history.push({id:'pending-history',seriesId:store.data.series[0].id,episodeId:'synthetic',synced:false});cloud.state.favorites.push(store.data.series[0].id);store.save(true,true);
 const context=cloud._context('A'),read=cloud._syncPrivateLibrary('A',context),logout=cloud.signOut();assert.equal(cloud.user,null);assert.equal(cloud._current(context),false);assert.equal(context.signal.aborted,true);assert.throws(()=>cloud._requireUser(),/Accedi/);
 const result=await logout;assert.equal(result.remote,'confirmed');assert.equal(cloud.activeLibraryUserId,null);
 const account=new Store(path.join(dir,'library-A.json'));assert.equal(account.data.series.length,1);assert.equal(account.data.cloudDirty,true);const outbox=JSON.parse(fs.readFileSync(path.join(dir,'supabase-sync-A.json')));assert.equal(outbox.history[0].synced,false);assert.equal(outbox.favorites.length,1);
 const before=store.snapshot();gate.resolve({data:{snapshot:{library:{series:[],futureRoot:1}},revision:99}});await read;assert.deepEqual(store.snapshot(),before);assert.equal(cloud.state.history.length,0);
});
test('cancellable sync receives abortSignal and is aborted at logout',async t=>{
 const {cloud,old}=await fixture(t);let signal;const gate=deferred();old.from=()=>{const q={select(){return this;},eq(){return this;},maybeSingle(){return this;},abortSignal(value){signal=value;value.addEventListener('abort',()=>gate.resolve({error:Error('Synthetic aborted')}));return this;},then:(a,b)=>gate.promise.then(a,b)};return q;};
 const read=cloud._syncPrivateLibrary('A');assert.ok(signal);await cloud.signOut();assert.equal(signal.aborted,true);await read;
});
for(const outcome of ['timeout','error','reject'])test('remote logout '+outcome+' stays bounded and never claims revocation',async t=>{
 const remote=deferred();let signal;const {cloud}=await fixture(t,{remoteSignOut:(_session,value)=>{signal=value;return outcome==='error'?Promise.resolve({error:Error('Synthetic auth error')}):outcome==='reject'?Promise.reject(Error('Synthetic rejected auth')):remote.promise;}});
 const result=await cloud.signOut();assert.equal(result.local,true);assert.equal(result.remote,outcome==='timeout'?'timeout':'error');assert.equal(cloud.user,null);if(outcome==='timeout')assert.equal(signal.aborted,true);
 remote.resolve({error:null});await Promise.resolve();assert.equal(cloud.logoutStatus.remote,result.remote);
});
test('A to B to A rejects old A results and an old sync finally cannot clear the newer sync slot',async t=>{
 const {cloud,store}=await fixture(t);const oldGate=deferred(),newGate=deferred();const original=cloud._syncForUser.bind(cloud);let count=0;cloud._syncForUser=()=>++count===1?oldGate.promise:newGate.promise;
 const oldContext=cloud._context('A'),oldSync=cloud.sync();await cloud.signOut();await cloud.signIn('B','synthetic');assert.equal(cloud.user.id,'B');
 // The background B sync is held. Its slot must survive the old A finally.
 const newerSlot=cloud.syncing;oldGate.resolve();await oldSync;assert.equal(cloud.syncing,newerSlot);newGate.resolve();await newerSlot;
 cloud._syncForUser=original;cloud.sync=async()=>{};await cloud.signOut();await cloud.signIn('A','synthetic');assert.equal(cloud.user.id,'A');assert.equal(cloud._current(oldContext),false);assert.equal(store.data.series[0].title,'Pending A work');
});
test('an old client auth callback and storage continuation cannot reattach A or erase the new session',async t=>{
 const {cloud,old,dir}=await fixture(t);cloud._subscribeAuth();await cloud.signOut();cloud.sync=async()=>{};await cloud.signIn('B','synthetic');old.listeners[0]('SIGNED_IN',{user:{id:'A'}});assert.equal(cloud.user.id,'B');
 const file=path.join(dir,'storage-fixture.json'),safeStorage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};let generation=0;
 const oldStorage=createSessionStorage({safeStorage,file,isCurrent:()=>generation===0}),newStorage=createSessionStorage({safeStorage,file,isCurrent:()=>generation===1});await oldStorage.setItem('unused','A');generation=1;await newStorage.setItem('unused','B');await oldStorage.removeItem('unused');await oldStorage.setItem('unused','late A');assert.equal(await newStorage.getItem('unused'),'B');
});
test('logout refuses a failed account flush and keeps pending data associated with A',async t=>{
 const {cloud,store}=await fixture(t);store.save=()=>{throw Error('Synthetic disk failure');};assert.throws(()=>cloud.signOut(),/disk failure/);assert.equal(cloud.user.id,'A');assert.equal(cloud.activeLibraryUserId,'A');
});
test('out-of-order sign-in replies are rejected after logout and B sign-in',async t=>{
 const {cloud}=await fixture(t),late=deferred(),factory=cloud._clientFactory;let once=true;cloud._clientFactory=()=>{const next=factory();if(once){once=false;next.auth.signInWithPassword=()=>late.promise;}return next;};const first=cloud.signIn('A','synthetic');const rejected=assert.rejects(first,/superata/);await cloud.signOut();cloud.sync=async()=>{};await cloud.signIn('B','synthetic');late.resolve({data:{user:{id:'A'}}});await rejected;assert.equal(cloud.user.id,'B');
});
test('the real Supabase SDK revokes only the departing session using a stateless isolated endpoint',async t=>{
 const http=require('http'),seen=[];const server=http.createServer((req,res)=>{seen.push({path:req.url,token:req.headers.authorization});res.writeHead(204);res.end();});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const {cloud}=await fixture(t,{remoteSignOut:null,logoutTimeoutMs:1500});cloud.config={configured:true,url:'http://127.0.0.1:'+server.address().port,key:'synthetic-public-key'};
 const result=await cloud.signOut();assert.equal(result.remote,'confirmed');assert.equal(seen.length,1);assert.equal(seen[0].path,'/auth/v1/logout?scope=local');assert.equal(seen[0].token,'Bearer synthetic-session-A');
});
test('real SDK auth HTTP failure is reported as unconfirmed, without restoring the local account',async t=>{
 const http=require('http'),server=http.createServer((_req,res)=>{res.writeHead(403,{'Content-Type':'application/json'});res.end(JSON.stringify({msg:'Synthetic rejected revocation'}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const {cloud}=await fixture(t,{remoteSignOut:null,logoutTimeoutMs:1500});cloud.config={configured:true,url:'http://127.0.0.1:'+server.address().port,key:'synthetic-public-key'};
 const result=await cloud.signOut();assert.equal(result.remote,'error');assert.equal(cloud.user,null);
});
test('profile and multi-step room operations reject old A responses before any B request',async t=>{
 const {cloud,old}=await fixture(t),gate=deferred();let calls=0;old.from=()=>{calls++;const q={select(){return this;},eq(){return this;},insert(){return this;},single(){return this;},maybeSingle(){return this;},abortSignal(){return this;},then:(a,b)=>gate.promise.then(a,b)};return q;};
 const request=cloud.createWatchRoom(),rejected=assert.rejects(request,/Contesto account scaduto/);await cloud.signOut();cloud.sync=async()=>{};await cloud.signIn('B','synthetic');gate.resolve({data:{id:'old-room'}});await rejected;assert.equal(calls,1);assert.equal(cloud.user.id,'B');
});
test('an incompatible anonymous target blocks operations after local logout and preserves both files',async t=>{
 const {cloud,store,dir}=await fixture(t),file=path.join(dir,'library.json'),raw=JSON.stringify({series:[],futureRoot:1});fs.writeFileSync(file,raw);const accountFile=store.file;
 await assert.rejects(cloud.signOut(),/operazioni bloccate/);assert.equal(cloud.user,null);assert.equal(store.file,accountFile);assert.equal(store.accountTransitioning,true);assert.equal(fs.readFileSync(file,'utf8'),raw);assert.throws(()=>cloud._requireClient(),/Contesto account bloccato/);assert.equal(new Store(accountFile).data.series.length,1);
});
test('late remote logout cannot overwrite a newer B login, including the same-account A to B to A generation',async t=>{
 const gate=deferred(),{cloud}=await fixture(t,{remoteSignOut:()=>gate.promise,logoutTimeoutMs:1000});const oldGeneration=cloud.status().authGeneration,logout=cloud.signOut();cloud.sync=async()=>{};await cloud.signIn('B','synthetic');await cloud.signIn('A','synthetic');assert.equal(cloud.user.id,'A');gate.resolve({error:null});const result=await logout;assert.notEqual(result.authGeneration,cloud.status().authGeneration);assert.ok(cloud.status().authGeneration>oldGeneration);assert.equal(cloud.logoutStatus,null);assert.equal(cloud.user.id,'A');
});
test('late sign-up cannot create a profile in the B context',async t=>{
 const gate=deferred(),{cloud}=await fixture(t),factory=cloud._clientFactory;let once=true;cloud._clientFactory=()=>{const next=factory();if(once){once=false;next.auth.signUp=()=>gate.promise;}return next;};const request=cloud.signUp('synthetic','synthetic'),rejected=assert.rejects(request,/registrazione superata/);await cloud.signOut();cloud.sync=async()=>{};await cloud.signIn('B','synthetic');gate.resolve({data:{user:{id:'A'},session:{user:{id:'A'}}}});await rejected;assert.equal(cloud.user.id,'B');
});
test('B can log out while the preceding A revocation is still pending',async t=>{
 const first=deferred(),second=deferred();let calls=0;const {cloud}=await fixture(t,{remoteSignOut:()=>++calls===1?first.promise:second.promise,logoutTimeoutMs:1000});
 const logoutA=cloud.signOut();cloud.sync=async()=>{};await cloud.signIn('B','synthetic');const logoutB=cloud.signOut();assert.notEqual(logoutA,logoutB);assert.equal(cloud.user,null);second.resolve({error:null});const b=await logoutB;first.resolve({error:null});const a=await logoutA;assert.notEqual(a.authGeneration,b.authGeneration);assert.equal(cloud.activeLibraryUserId,null);assert.equal(cloud.status().logout.remote,'confirmed');
});
