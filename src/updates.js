'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),semver=require('semver');
const OFFICIAL={provider:'github',owner:'Adrotto2008',repo:'anime-player',private:false,releaseType:'release'};
const RELEASES='https://github.com/Adrotto2008/anime-player/releases/latest';
function capability({packaged,platform,env={},resourcesPath,execPath}){
  if(!packaged)return {format:'source',installable:false,reason:'Gli aggiornamenti si installano soltanto nella versione distribuita.'};
  if(platform==='win32'){
    if(env.PORTABLE_EXECUTABLE_FILE || env.PORTABLE_EXECUTABLE_DIR)return {format:'portable',installable:false,reason:'Portable: installa una volta la versione NSIS per ricevere gli aggiornamenti automatici. Il profilo resta nello stesso userData.'};
    if(!fs.existsSync(path.join(path.dirname(execPath),'Uninstall Anime Player.exe')))return {format:'unpacked',installable:false,reason:'Questa cartella non è una installazione NSIS. Usa l’installer ufficiale.'};
    return {format:'nsis',installable:true};
  }
  if(platform==='linux'){
    if(env.APPIMAGE)return {format:'appimage',installable:true};
    let type='';try{type=fs.readFileSync(path.join(resourcesPath,'package-type'),'utf8').trim();}catch{}
    if(type==='deb')return {format:'deb',installable:false,reason:'DEB: aggiorna con il gestore pacchetti (sudo apt install ./pacchetto.deb). Sono richiesti privilegi amministrativi.'};
    return {format:'linux-other',installable:false,reason:'Usa un’AppImage ufficiale o il gestore pacchetti della distribuzione.'};
  }
  if(platform==='darwin')return {format:'mac',installable:true,reason:'macOS richiede release firmate e notarizzate.'};
  return {format:'unsupported',installable:false,reason:'Installazione automatica non disponibile per questo formato.'};
}
function validateInfo(info,current){
  if(!semver.valid(info?.version)||!semver.gt(info.version,current)||semver.prerelease(info.version))throw Error('Metadati versione non validi.');
  if(!Array.isArray(info.files)||!info.files.length)throw Error('Pacchetto incompleto: file mancanti.');
  for(const file of info.files){
    if(typeof file.url!=='string'||!file.url||file.url.includes('\\')||file.url.includes('..')||!/^[-\w. ()+]+$/.test(file.url))throw Error('Origine del pacchetto non consentita.');
    if(typeof file.sha512!=='string'||Buffer.from(file.sha512,'base64').length!==64||!Number.isSafeInteger(file.size)||file.size<=0)throw Error('Pacchetto incompleto: hash o dimensione mancanti.');
  }
  return {version:info.version,date:typeof info.releaseDate==='string'?info.releaseDate:'',notes:(typeof info.releaseNotes==='string'?info.releaseNotes:Array.isArray(info.releaseNotes)?info.releaseNotes.map(x=>String(x.note||'')).join('\n'):'').slice(0,24000)};
}
// Copy durable profile files only; retain all backups, never traverse Chromium caches.
function backupProfile(profile,version){
  const destination=path.join(profile,'update-backups',version+'-'+Date.now()+'-'+crypto.randomUUID());
  fs.mkdirSync(destination,{recursive:true});const files=[];
  for(const name of fs.readdirSync(profile)){
    const source=path.join(profile,name),stat=fs.lstatSync(source);
    if(stat.isSymbolicLink())throw Error('Backup bloccato da un collegamento simbolico nel profilo.');
    if(!stat.isFile()||name.endsWith('.tmp'))continue;
    const target=path.join(destination,name);fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);
    const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
    if(hash(fs.readFileSync(source))!==hash(fs.readFileSync(target)))throw Error('Backup non verificato.');
    files.push({name,sha256:hash(fs.readFileSync(target))});
  }
  fs.writeFileSync(path.join(destination,'backup-manifest.json'),JSON.stringify({version,files},null,2),{flag:'wx'});
  return destination;
}
function verifyDownloaded(updater){
  const helper=updater?.downloadedUpdateHelper,info=helper?.downloadedFileInfo;
  if(!helper?.file||typeof info?.sha512!=='string')throw Error('Pacchetto verificato non disponibile.');
  const bytes=fs.readFileSync(helper.file);
  if(crypto.createHash('sha512').update(bytes).digest('base64')!==info.sha512)throw Error('Integrità del pacchetto scaricato non valida.');
}
class UpdateService{
  constructor({app,profile,cap,updater=null,notify=()=>{},isPlaying=()=>false,save=()=>{},backup=backupProfile,verify=verifyDownloaded}){
    this.app=app;this.profile=profile;this.cap=cap;this.updater=updater;this.notify=notify;this.isPlaying=isPlaying;this.save=save;this.backup=backup;this.verify=verify;
    this.file=path.join(profile,'updates.json');this.preferences={checkAtStartup:true,lastChecked:null};this.preferenceError=false;
    try{const raw=JSON.parse(fs.readFileSync(this.file,'utf8'));if(typeof raw.checkAtStartup!=='boolean'||!(raw.lastChecked===null||Number.isFinite(raw.lastChecked)))throw Error('Impostazioni aggiornamenti non valide.');this.preferences=raw;}catch(error){if(error.code!=='ENOENT')this.preferenceError=true;}
    this.state={status:'idle',currentVersion:app.getVersion(),...cap,release:null,progress:null,error:null,installOnQuit:false,releasesURL:RELEASES};
    if(this.preferenceError)this.state.error='Impostazioni aggiornamenti illeggibili: file conservato, controllo automatico disattivato.';
    if(updater){
      updater.autoDownload=false;updater.autoInstallOnAppQuit=false;updater.allowDowngrade=false;updater.allowPrerelease=false;updater.fullChangelog=false;updater.disableWebInstaller=true;updater.logger=null;
      updater.on('update-available',info=>{try{this.state.release=validateInfo(info,this.state.currentVersion);this.change({status:'available',error:null,progress:null});}catch{this.fail('Pacchetto non valido o incompleto: aggiornamento bloccato.');}});
      updater.on('update-not-available',()=>this.change({status:'current',release:null,progress:null,error:null}));
      updater.on('download-progress',p=>{if(this.state.status==='downloading')this.change({progress:Object.fromEntries(['percent','bytesPerSecond','total','transferred'].map(k=>[k,Math.max(0,Number(p[k])||0)]))});});
      updater.on('update-downloaded',info=>{try{const release=validateInfo(info,this.state.currentVersion);if(release.version!==this.state.release?.version||this.state.status!=='downloading')throw Error('Versione inattesa');this.change({status:'downloaded',error:null,progress:this.state.progress?{...this.state.progress,percent:100,transferred:this.state.progress.total,bytesPerSecond:0}:null});}catch{this.fail('Pacchetto scaricato non valido: installazione bloccata.');}});
      updater.on('error',error=>this.fail(this.errorMessage(error)));
      updater.on('update-cancelled',()=>this.change({status:'cancelled',progress:null,error:'Download interrotto. Puoi riprovare.'}));
    }
  }
  snapshot(){return {...this.state,preferences:{...this.preferences},busy:!!this.operation,playing:this.isPlaying()};}
  errorMessage(error){
    if(this.state.status==='downloading')return 'Download fallito. Controlla la connessione e riprova.';
    if(['ERR_UPDATER_CHANNEL_FILE_NOT_FOUND','ERR_UPDATER_NO_PUBLISHED_VERSIONS'].includes(error?.code))return 'La release ufficiale non contiene ancora i metadati di aggiornamento. Occorre pubblicare la prima release compatibile.';
    return 'Errore di connessione o release non valida. Riprova più tardi.';
  }
  change(patch){Object.assign(this.state,patch);this.notify(this.snapshot());}
  fail(error){this.change({status:'error',error,installOnQuit:false});}
  persist(){if(this.preferenceError)throw Error('File impostazioni illeggibile conservato: recuperalo prima di modificarlo.');fs.mkdirSync(this.profile,{recursive:true});fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.preferences,null,2),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);}
  configure(patch){if(!patch||Object.keys(patch).some(k=>k!=='checkAtStartup')||typeof patch.checkAtStartup!=='boolean')throw Error('Preferenza aggiornamenti non valida.');const previous={...this.preferences};this.preferences.checkAtStartup=patch.checkAtStartup;try{this.persist();}catch(e){this.preferences=previous;throw e;}this.change({});return this.snapshot();}
  async run(fn){if(this.operation||this.state.status==='installing')return this.snapshot();this.operation=true;try{await fn();}catch(error){if(!['cancelled','error'].includes(this.state.status))this.fail(this.errorMessage(error));}finally{this.operation=false;this.change({});}return this.snapshot();}
  check(origin='manual'){return this.run(async()=>{
    if(this.state.status==='downloaded')return;
    this.change({status:'checking',checkOrigin:origin==='startup'?'startup':'manual',error:null,release:null,progress:null});this.preferences.lastChecked=Date.now();if(!this.preferenceError)this.persist();
    if(!this.updater){this.change({status:'unsupported'});return;}
    await this.updater.checkForUpdates();
  });}
  download(){if(!this.cap.installable||!this.state.release||!['available','error','cancelled'].includes(this.state.status))throw Error('Download non disponibile.');return this.run(async()=>{
    // v6 trusts an in-memory cache entry on retries within the same process.
    // Recreate its helper after a failed integrity check so its own disk-cache
    // validator rehashes/cleans the pending download before fetching again.
    if(this.cacheInvalid){this.updater.downloadedUpdateHelper=null;this.cacheInvalid=false;}
    this.change({status:'downloading',progress:null,error:null});await this.updater.downloadUpdate();
  });}
  later(installOnQuit=true){if(this.state.status!=='downloaded'||typeof installOnQuit!=='boolean')throw Error('Aggiornamento non pronto.');this.change({installOnQuit});return this.snapshot();}
  deferSystemExit(){this.restart=false;this.change({installOnQuit:false,...(this.state.status==='installing'?{status:'downloaded'}:{})});}
  install(){
    if(this.operation||this.state.status!=='downloaded'||!this.cap.installable)throw Error('Aggiornamento non pronto.');
    if(this.isPlaying())throw Error('Interrompi la riproduzione prima di aggiornare e riavviare.');
    // Preflight preserves the running app if saving/backing up fails.
    try{this.verify(this.updater);}catch{this.cacheInvalid=true;this.fail('Integrità del pacchetto non valida: installazione bloccata. Puoi riprovare il download.');throw Error(this.state.error);}
    try{this.save();this.backup(this.profile,this.state.currentVersion);}catch{this.fail('Salvataggio o backup fallito: installazione bloccata. Puoi riprovare il download.');throw Error(this.state.error);}
    this.restart=true;this.change({status:'installing',installOnQuit:true});this.app.quit();return this.snapshot();
  }
  finishQuit(saveError){
    if(!this.state.installOnQuit||!['downloaded','installing'].includes(this.state.status))return false;
    try{if(saveError)throw saveError;this.verify(this.updater);this.backup(this.profile,this.state.currentVersion);this.updater.autoRunAppAfterInstall=!!this.restart;this.updater.quitAndInstall(true,!!this.restart);return this.state.status!=='error';}
    catch{this.fail('Integrità, salvataggio o backup fallito: installazione annullata.');return false;}
  }
  start(){if(this.preferences.checkAtStartup&&!this.preferenceError&&this.updater){this.timer=setTimeout(()=>this.check('startup'),10000);this.timer.unref?.();}}
}
function createUpdateService({app,profile,notify,isPlaying,save}){
  const cap=capability({packaged:app.isPackaged,platform:process.platform,env:process.env,resourcesPath:process.resourcesPath,execPath:process.execPath});
  // No renderer-supplied feed or environment token: fixed official public provider.
  const classes=app.isPackaged?require('electron-updater'):null;
  const Updater=classes&&(process.platform==='win32'?classes.NsisUpdater:process.platform==='darwin'?classes.MacUpdater:cap.format==='deb'?classes.DebUpdater:classes.AppImageUpdater);
  const updater=Updater?new Updater({...OFFICIAL}):null;
  return new UpdateService({app,profile,cap,updater,notify,isPlaying,save});
}
module.exports={OFFICIAL,RELEASES,capability,validateInfo,backupProfile,verifyDownloaded,UpdateService,createUpdateService};
