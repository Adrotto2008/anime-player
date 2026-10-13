(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.WatchPartyProtocol=api;})(globalThis,function(){
  'use strict';
  const VERSION=1;
  const PERMISSIONS=['playPause','seek','content','skip'];
  const DEFAULT_SYNC={deadband:.08,hardSeek:1.25,maxRateDelta:.04,rateWindow:8,seekCooldownMs:5000,durationTolerance:.01};
  function publicUrl(value){
    try{const u=new URL(String(value));if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.href.length>2000)return null;
      if(!/^[a-z0-9.-]+$/i.test(u.hostname)||!u.hostname.includes('.')||/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)||/\.(local|localhost|internal|lan|home|invalid|test)$/i.test(u.hostname))return null;return u.href;
    }catch{return null;}
  }
  function content(value){
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Contenuto non valido');
    const out={key:String(value.key||''),title:String(value.title||'').slice(0,160),kind:value.kind==='local'?'local':value.kind==='catalog'?'catalog':'custom'};
    if(!/^[a-zA-Z0-9:._-]{1,180}$/.test(out.key)||!out.title)throw Error('Identità contenuto non valida');
    for(const id of ['anilistId','malId','number','year','episodeCount'])if(Number.isSafeInteger(value[id])&&value[id]>=0)out[id]=value[id];
    if(value.format)out.format=String(value.format).slice(0,20);
    if(value.unitKind)out.unitKind=String(value.unitKind).slice(0,20);
    if(value.localHash&&/^[a-f0-9]{64}$/.test(value.localHash))out.localHash=value.localHash;
    const u=publicUrl(value.sourceUrl);if(u)out.sourceUrl=u;
    const page=publicUrl(value.providerTitleUrl);if(page)out.providerTitleUrl=page;
    if(['animeworld','animeunity'].includes(value.provider))out.provider=value.provider;
    return out;
  }
  function code(value){const s=String(value||'').trim().toUpperCase();if(!/^[A-HJ-NP-Z2-9]{8}$/.test(s))throw Error('Codice stanza non valido');return s;}
  function correction({remote,local,serverNow,now,lastSeek=0,config={}}){
    const cfg={...DEFAULT_SYNC,...config};
    if(!remote||!local||local.localPaused||local.buffering||remote.buffering)return {kind:'wait',reason:local?.localPaused?'local-pause':'buffering',speed:1};
    if(remote.content?.key!==local.key)return {kind:'wait',reason:'content',speed:1};
    if(remote.duration>0&&local.duration>0&&Math.abs(remote.duration-local.duration)>Math.max(3,remote.duration*cfg.durationTolerance))return {kind:'wait',reason:'version',speed:1};
    const base=Math.max(.1,Math.min(4,remote.speed||1));
    const target=Math.max(0,remote.position+(remote.paused?0:Math.max(0,(serverNow-remote.serverTime)/1000)*base));
    const drift=target-local.position;
    if(remote.paused)return {kind:Math.abs(drift)>cfg.deadband?'seek-pause':'pause',target,drift,speed:base};
    if(Math.abs(drift)>=cfg.hardSeek&&now-lastSeek>=cfg.seekCooldownMs)return {kind:'seek',target,drift,speed:base};
    const adjustment=Math.abs(drift)<=cfg.deadband?0:Math.max(-cfg.maxRateDelta,Math.min(cfg.maxRateDelta,drift/cfg.rateWindow));
    return {kind:'rate',target,drift,speed:base*(1+adjustment)};
  }
  return {VERSION,PERMISSIONS,DEFAULT_SYNC,publicUrl,content,code,correction};
});
