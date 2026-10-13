'use strict';
const fs=require('fs'),path=require('path'),http=require('http'),net=require('net'),crypto=require('crypto');
const {spawn,execFile}=require('child_process');
const WebSocket=require('ws');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const accounts={a:'11111111-1111-4111-8111-111111111111',b:'22222222-2222-4222-8222-222222222222',c:'33333333-3333-4333-8333-333333333333'};
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function wait(predicate,timeout=12000){const start=Date.now();while(true){const result=await predicate();if(result)return result;if(Date.now()-start>timeout)throw Error('Watch Party wait timed out');await delay(30);}}
async function startWorker({grace=1000,realAuth=false}={}){
  const root=path.resolve(__dirname,'..'),dir=path.join(root,'work','watchparty-0.5.55','test-'+crypto.randomUUID());fs.mkdirSync(dir,{recursive:true});
  const authCalls=[];
  const auth=http.createServer((req,res)=>{const token=(req.headers.authorization||'').replace('Bearer ',''),id=accounts[token];authCalls.push({path:req.url,token});res.setHeader('Content-Type','application/json');
    if(!id){res.writeHead(401);return res.end('{}');}
    if(req.url==='/auth/v1/user')return res.end(JSON.stringify({id}));
    if(req.url.startsWith('/rest/v1/profiles'))return res.end(JSON.stringify([{display_name:'Fixture '+token,avatar_url:null}]));
    if(req.url.startsWith('/rest/v1/friendships'))return res.end(JSON.stringify(token==='a'&&decodeURIComponent(req.url).includes(accounts.b)?[{user_id:accounts.a,friend_id:accounts.b}]:[]));
    res.writeHead(404);res.end('{}');
  });await new Promise(r=>auth.listen(0,'127.0.0.1',r));
  const number=await port(),base='http://127.0.0.1:'+number;
  const config={name:'watchparty-server',main:path.join(root,'watchparty-server','src','index.ts'),compatibility_date:'2026-10-06',migrations:[{tag:'v1',new_sqlite_classes:['MyDurableObject']},{tag:'v2-watchparty',new_sqlite_classes:['InviteInbox']}],durable_objects:{bindings:[{name:'MY_DURABLE_OBJECT',class_name:'MyDurableObject'},{name:'INVITE_INBOX',class_name:'InviteInbox'}]},vars:{PARTY_SIGNING_KEY:crypto.randomBytes(32).toString('hex'),SUPABASE_URL:'http://127.0.0.1:'+auth.address().port,SUPABASE_PUBLIC_KEY:'fixture-public',ROOM_MAX_PARTICIPANTS:'16',RECONNECT_GRACE_MS:String(grace)}};
  if(realAuth){const publicConfig=JSON.parse(fs.readFileSync(path.join(root,'.build-resources','inputs','supabase-public.json'),'utf8'));config.vars.SUPABASE_URL=publicConfig.url;config.vars.SUPABASE_PUBLIC_KEY=publicConfig.publishableKey;}
  const configFile=path.join(dir,'wrangler.json');fs.writeFileSync(configFile,JSON.stringify(config));
  const child=spawn(process.execPath,[path.join(root,'watchparty-server','node_modules','wrangler','bin','wrangler.js'),'dev','--local','--config',configFile,'--ip','127.0.0.1','--port',String(number),'--persist-to',path.join(dir,'state')],{cwd:root,windowsHide:true,env:{...process.env,WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',d=>log=(log+d).slice(-16000));child.stderr.on('data',d=>log=(log+d).slice(-16000));
  const stop=async()=>{if(child.exitCode==null){if(process.platform==='win32')await new Promise(r=>execFile('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>r()));else child.kill('SIGTERM');}await new Promise(r=>auth.close(r));};
  try{await wait(async()=>{try{return (await fetch(base+'/health')).ok;}catch{return false;}},30000);}catch(error){await stop();throw Error(error.message+'\n'+log);}
  let clientNumber=0;
  async function post(route,data={},authorization,ip){const response=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...(authorization?{Authorization:authorization}:{}),'CF-Connecting-IP':ip||'fixture-'+(++clientNumber)},body:JSON.stringify(data)});const payload=await response.json();return {status:response.status,...payload};}
  async function guest(name='Guest'){const result=await post('/api/v1/guests',{name});if(result.status!==200)throw Error(result.error);return 'Guest '+result.token;}
  return {base,dir,authCalls,post,guest,stop,accounts,log:()=>log};
}
async function socket(base,code,ticket){
  const route=code.includes('/')?code:'/api/v1/rooms/'+code+'/socket';const ws=new WebSocket(base.replace(/^http/,'ws')+route,['watchparty.v1','ticket.'+ticket]);
  const peer={ws,messages:[],room:null,send(data){ws.send(JSON.stringify({v:1,...data}));},async command(data){const id=crypto.randomUUID();peer.send({...data,id});return wait(()=>peer.messages.find(m=>m.id===id&&(m.type==='ack'||m.type==='error')));},async leave(){if(ws.readyState===1){peer.send({type:'leave'});await wait(()=>ws.readyState===3);}else ws.close();}};
  ws.on('message',bytes=>{const m=JSON.parse(bytes.toString());peer.messages.push(m);if(m.room)peer.room=m.room;});ws.on('error',()=>{});
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});await wait(()=>peer.messages.length);return peer;
}
module.exports={startWorker,socket,wait,delay};
