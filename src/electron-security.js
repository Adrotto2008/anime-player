'use strict';
const {pathToFileURL}=require('url');
function isAppURL(raw,entry){try{const url=new URL(raw);url.hash='';url.search='';return url.href===pathToFileURL(entry).href;}catch{return false;}}
function requireTrustedSender(event,win,entry){
  if(!win || win.isDestroyed() || event?.sender!==win.webContents || event.senderFrame!==win.webContents.mainFrame || !isAppURL(event.senderFrame?.url,entry))throw Error('IPC non autorizzato: mittente non attendibile.');
}
function installWindowSecurity(win,entry,openExternal){
  const contents=win.webContents;
  const prevent=(event,url)=>{if(!isAppURL(typeof url==='string'?url:event.url,entry))event.preventDefault();};
  contents.on('will-navigate',prevent);contents.on('will-frame-navigate',prevent);contents.on('will-redirect',prevent);
  contents.on('will-attach-webview',event=>event.preventDefault());
  contents.setWindowOpenHandler(({url})=>{
    try{const parsed=new URL(url);if(['https:','http:'].includes(parsed.protocol)&&!parsed.username&&!parsed.password)Promise.resolve(openExternal(parsed.href)).catch(()=>console.warn('Apertura link esterno fallita.'));}catch{/* malformed URLs are denied */}
    return {action:'deny'};
  });
  contents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  contents.session.setPermissionCheckHandler(()=>false);
}
module.exports={isAppURL,requireTrustedSender,installWindowSecurity};
