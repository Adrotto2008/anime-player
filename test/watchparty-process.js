'use strict';
const path=require('path'),{spawn}=require('child_process');
function launch(profile,base,{accounts=false,title}={}){
  const root=path.resolve(__dirname,'..'),env={...process.env,ANIME_PLAYER_TEST_PROFILE:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.ANIME_PLAYER_PARTY_TEST_URL;if(base)env.ANIME_PLAYER_PARTY_TEST_URL=base;
  if(accounts){env.ANIME_PLAYER_TEST_ACCOUNTS='1';env.ANIME_PLAYER_TEST_WINDOW_TITLE=title;}
  const child=spawn(require('electron'),[path.join(__dirname,'watchparty-child.js')],{cwd:root,env,stdio:['ignore','pipe','pipe','ipc'],windowsHide:false});
  let log='',next=0;const requests=new Map();
  child.stderr.on('data',d=>log=(log+d).slice(-16000));child.stdout.on('data',d=>log=(log+d).slice(-16000));
  const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Electron not ready\n'+log)),30000);child.on('message',m=>{if(m.ready){clearTimeout(timer);resolve();}if(m.fatal){clearTimeout(timer);reject(Error(m.fatal));}if(m.id){const p=requests.get(m.id);if(p){clearTimeout(p.timer);requests.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve(m.value);}}});child.on('exit',()=>{clearTimeout(timer);for(const p of requests.values()){clearTimeout(p.timer);p.reject(Error('Electron exited\n'+log));}requests.clear();});});
  return {child,ready,log:()=>log,rpc(action,data={}){const id=++next;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{requests.delete(id);reject(Error('E2E RPC timeout: '+action+'\n'+log));},15000);requests.set(id,{resolve,reject,timer});child.send({id,action,...data});});}};
}
module.exports={launch};
