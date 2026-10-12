'use strict';
const https=require('https'),semver=require('semver');
const {load}=require('js-yaml');
const ROOT='https://github.com/Adrotto2008/anime-player/releases/download/';
const API='https://api.github.com/repos/Adrotto2008/anime-player/releases';
function request(url,redirects=0){
  return new Promise((resolve,reject)=>{
    const parsed=new URL(url);
    if(parsed.protocol!=='https:'||!['api.github.com','github.com','release-assets.githubusercontent.com'].includes(parsed.hostname)||redirects>5)return reject(Error('Origine release non consentita.'));
    const req=https.get(parsed,{headers:{'User-Agent':'AnimePlayer','Accept':'application/vnd.github+json'}},res=>{
      if(res.statusCode>=300&&res.statusCode<400&&res.headers.location){res.resume();request(new URL(res.headers.location,url).href,redirects+1).then(resolve,reject);return;}
      if(res.statusCode!==200){res.resume();reject(Error('Release non disponibile (HTTP '+res.statusCode+').'));return;}
      let body='';res.setEncoding('utf8');res.on('data',chunk=>{body+=chunk;if(body.length>4*1024*1024)res.destroy(Error('Risposta release troppo grande.'));});res.on('error',reject);res.on('end',()=>resolve(body));
    });req.setTimeout(15000,()=>req.destroy(Error('Connessione release scaduta.')));req.on('error',reject);
  });
}
function describe(raw,current,cap,platform=process.platform,arch=process.arch){
  const version=semver.valid(String(raw.tag_name||'').replace(/^v/,''));
  if(!version||raw.draft||raw.prerelease||semver.prerelease(version))return null;
  const relation=semver.compare(version,current),legacy=semver.lt(version,'0.5.47');
  const channel=platform==='win32'?'latest.yml':platform==='darwin'?'latest-mac.yml':'latest-linux.yml';
  // .47-.50 share the audited data schema. Future downgrades require a new audit.
  const downgradeSafe=semver.gte(version,'0.5.47')&&semver.lte(version,'0.5.50')&&semver.lte(current,'0.5.50');
  const assets=Array.isArray(raw.assets)?raw.assets:[];
  let reason=legacy?'Versione precedente all’updater: cambio in-app bloccato.':!cap.installable?cap.reason:arch!=='x64'?'Architettura non certificata per il cambio versione.':relation===0?'Versione già installata.':relation<0&&!downgradeSafe?'Compatibilità dei dati non certificata: downgrade bloccato.':!assets.some(a=>a.name===channel)?'Manifest di aggiornamento mancante.':null;
  const packageName=platform==='win32'?`AnimePlayer-Setup-${version}.exe`:platform==='linux'?`AnimePlayer-${version}-${arch}.AppImage`:`AnimePlayer-${version}-${arch}.zip`;
  if(!reason&&!assets.some(a=>a.name===packageName))reason='Pacchetto per questo sistema mancante.';
  if(platform!=='win32'&&relation<0)reason='Downgrade certificati soltanto per Windows NSIS x64.';
  return {version,tag:raw.tag_name,date:raw.published_at||'',notes:String(raw.body||'').slice(0,24000),current:relation===0,direction:relation<0?'downgrade':relation>0?'update':'current',installable:!reason,reason,legacy,channel,assets};
}
class ReleaseCatalog{
  constructor({current,cap,platform=process.platform,arch=process.arch,fetch=request}){Object.assign(this,{current,cap,platform,arch,fetch});}
  async page(page=1){
    if(!Number.isSafeInteger(page)||page<1||page>1000)throw Error('Pagina release non valida.');
    const raw=JSON.parse(await this.fetch(API+'?per_page=20&page='+page));if(!Array.isArray(raw))throw Error('Catalogo release non valido.');
    const releases=raw.map(r=>describe(r,this.current,this.cap,this.platform,this.arch)).filter(Boolean).sort((a,b)=>semver.rcompare(a.version,b.version)).map(({assets,channel,...r})=>r);
    return {page,hasMore:raw.length===20,releases};
  }
  async resolve(version){
    if(!semver.valid(version)||semver.prerelease(version))throw Error('Versione non valida.');
    const raw=JSON.parse(await this.fetch(API+'/tags/v'+version));
    const release=describe(raw,this.current,this.cap,this.platform,this.arch);
    if(!release||release.version!==version||release.tag!=='v'+version||!release.installable)throw Error(release?.reason||'Release non installabile.');
    const base=ROOT+encodeURIComponent(release.tag)+'/';
    const info=load(await this.fetch(base+release.channel),{schema:require('js-yaml').JSON_SCHEMA});
    if(info?.version!==version||!Array.isArray(info.files)||!info.files.length||info.packages)throw Error('Manifest della release non valido.');
    const files=info.files.filter(f=>this.platform==='win32'?f.url===`AnimePlayer-Setup-${version}.exe`:this.platform==='linux'?f.url===`AnimePlayer-${version}-${this.arch}.AppImage`:f.url===`AnimePlayer-${version}-${this.arch}.zip`);
    if(files.length!==1||info.files.length!==1)throw Error('Pacchetto compatibile mancante nel manifest.');
    for(const file of files){if(typeof file.sha512!=='string'||!Number.isSafeInteger(file.size)||file.size<=0)throw Error('Manifest incompleto.');const asset=release.assets.find(a=>a.name===file.url);if(!asset||asset.size!==file.size||asset.browser_download_url!==base+encodeURIComponent(file.url)||Buffer.from(file.sha512||'','base64').length!==64)throw Error('Pacchetto ufficiale o hash/dimensione non verificabili.');}
    return {release:{version,date:release.date,notes:release.notes,direction:release.direction},info:{...info,files},base};
  }
}
module.exports={ReleaseCatalog,describe,request};
