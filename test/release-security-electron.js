'use strict';
const {app,BrowserWindow}=require('electron'),fs=require('fs'),path=require('path'),os=require('os'),http=require('http'),vm=require('vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),arg=name=>process.argv.find(x=>x.startsWith('--'+name+'='))?.slice(name.length+3),result=arg('result'),dir=arg('profile');app.setPath('userData',dir);app.setPath('sessionData',dir);
let win,store,server;const cases=[];const timeout=setTimeout(()=>{fs.writeFileSync(result,JSON.stringify({ok:false,error:'Timeout',cases}));app.exit(2);},25000);
app.whenReady().then(async()=>{
 const req=require('module').createRequire(path.join(root,'main.js')),{Store}=req('./src/store');store=new Store(path.join(dir,'library.json'));store.setSettings({onboardingComplete:true});
 const stubApp={isPackaged:true,requestSingleInstanceLock:()=>true,whenReady:()=>({then:()=>{}}),on:()=>{},quit:()=>{},getVersion:()=> 'BENIGN_IPC_PROOF'};
 const electron={...require('electron'),app:stubApp,shell:{openExternal:()=>{throw Error('No real desktop links in tests');}}};
 const ctx={require:n=>n==='electron'?electron:req(n),__dirname:root,module:{exports:{}},process,console,setTimeout,clearTimeout};
 vm.runInNewContext(fs.readFileSync(path.join(root,'main.js'),'utf8')+'\nmodule.exports.probe=(s)=>{store=s;player={state:()=>({playing:false})};cloud={getSession:()=>({configured:false,connected:false})};register();createWindow();return win;}',ctx);
 win=ctx.module.exports.probe(store);win.setTitle('AP Phase7 isolated security regression');await new Promise(r=>win.webContents.once('did-finish-load',r));
 assert.equal(await win.webContents.executeJavaScript("window.animeApi.invoke('app:version')"),'BENIGN_IPC_PROOF');cases.push('production IPC permits trusted main renderer');
 assert.equal(await win.webContents.executeJavaScript("window.animeApi.invoke('fs:read','ignored').then(()=>false).catch(()=>true)"),true);cases.push('preload rejects unknown channel');
 server=http.createServer((_q,res)=>res.end('<html><body>AP isolated untrusted document</body></html>'));await new Promise(r=>server.listen(0,'127.0.0.1',r));const untrusted='http://127.0.0.1:'+server.address().port+'/untrusted';
 const local=win.webContents.getURL();await win.webContents.executeJavaScript('location.href='+JSON.stringify(untrusted));await new Promise(r=>setTimeout(r,150));assert.equal(win.webContents.getURL(),local);cases.push('production navigation guard blocks renderer remote navigation');
 await win.webContents.loadURL(untrusted);assert.equal(await win.webContents.executeJavaScript("window.animeApi.invoke('app:version').then(()=>false).catch(e=>e.message.includes('non autorizzato'))"),true);cases.push('production IPC rejects untrusted document even after main-programmatic load');
 fs.writeFileSync(result,JSON.stringify({ok:true,cases,electron:process.versions.electron,platform:process.platform,profile:'isolated synthetic only',privilegedAction:'app:version only'},null,2));
 clearTimeout(timeout);clearTimeout(store._timer);win.destroy();server.close();app.exit(0);
}).catch(error=>{fs.writeFileSync(result,JSON.stringify({ok:false,error:error.stack,cases},null,2));clearTimeout(timeout);clearTimeout(store?._timer);win?.destroy();server?.close();app.exit(1);});
