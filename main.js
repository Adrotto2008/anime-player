const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store, validateLibraryData } = require('./src/store');
const { PlayerManager } = require('./src/player');
const { CloudService } = require('./src/cloud');
const A4K = require('./src/anime4k');
const meta = require('./src/metadata');
const { expandPattern, expandList, parseM3U, isValidSource, detectEpisodeNumber } = require('./src/patterns');
const { AnimeWorldClient, AnimeUnityClient } = require('./src/source-engine');
const { checkSources } = require('./src/source-check');
const { createMpvManager } = require('./src/mpv-manager');
const { createSeriesAdder } = require('./src/series-addition');
const { createRatingsService } = require('./src/ratings-service');
const { createAdditionOperationService } = require('./src/addition-operations');
const { createWorkQueue } = require('./src/work-queue');
const { createOrganizationService } = require('./src/organization-service');
const ElectronSecurity=require('./src/electron-security');
const rendererEntry=path.join(__dirname,'renderer','index.html');
const { discoverSeriesSources: discoverSources, createSourceDiscoveryQueue } = require('./src/source-discovery');

// Source checkouts use a disposable local profile, never the installed app's profile.
if(!app.isPackaged){
  const requested=process.env.ANIME_PLAYER_TEST_PROFILE&&path.resolve(process.env.ANIME_PLAYER_TEST_PROFILE);
  const testRoot=path.resolve(__dirname,'work')+path.sep;
  if(requested&&!requested.startsWith(testRoot))throw Error('Il profilo di test deve essere dentro work/');
  const profile=requested||path.resolve(__dirname,'.isolated-user-data');
  fs.mkdirSync(profile,{recursive:true});
  app.setPath('userData',profile);
  fs.mkdirSync(path.join(profile,'session'),{recursive:true});
  app.setPath('sessionData',path.join(profile,'session'));
}
if (!app.requestSingleInstanceLock()) { app.quit(); }

let win; let store; let player; let cloud; let party; let updates;
const PASSWORD_RESET_SCHEME='animeplayer';
let queuedRecoveryLinks=[];
let recoveryNotice=null;
let recoveryNoticeSequence=0;
let recoveryInFlight=false;
function isPasswordRecoveryUrl(value){
  try{const url=new URL(String(value));return url.protocol===`${PASSWORD_RESET_SCHEME}:`&&url.hostname==='auth'&&url.pathname==='/reset-password'&&!url.username&&!url.password;}
  catch{return false;}
}
function queuePasswordRecoveryUrl(value){
  if(!isPasswordRecoveryUrl(value))return;
  queuedRecoveryLinks.push(String(value));
  processPasswordRecoveryLinks();
}
async function processPasswordRecoveryLinks(){
  if(!cloud?._started||recoveryInFlight||!queuedRecoveryLinks.length)return;
  recoveryInFlight=true;
  const url=queuedRecoveryLinks.shift();
  try{await cloud.completePasswordRecoveryLink(url);recoveryNotice={id:++recoveryNoticeSequence,ok:true};}
  catch(error){recoveryNotice={id:++recoveryNoticeSequence,ok:false,message:error.message||'Link di recupero non valido.'};}
  finally{recoveryInFlight=false;if(win&&!win.isDestroyed())win.webContents.send('auth:recovery',recoveryNotice);if(queuedRecoveryLinks.length)processPasswordRecoveryLinks();}
}
app.on('open-url',(event,url)=>{event.preventDefault();queuePasswordRecoveryUrl(url);});
const startupRecoveryUrl=process.argv.find(isPasswordRecoveryUrl);
if(startupRecoveryUrl)queuePasswordRecoveryUrl(startupRecoveryUrl);
const animeWorld = new AnimeWorldClient();
const animeUnity = new AnimeUnityClient();
let mpvManager; let ratings; let mpvDevice; let mpvStartup;
function completeMpv(result,directory=store.data.settings.mpvInstallDirectory){
  if(!mpvDevice.data||mpvDevice.data.path!==result.path||mpvDevice.data.installDirectory!==directory||mpvDevice.data.version!==result.version)mpvDevice.complete(result,directory);mpvStartup={...result,complete:true};
  if(store.data.settings.mpvPath!==result.path||store.data.settings.mpvInstallDirectory!==directory||!store.data.settings.onboardingComplete){store.setSettings({mpvPath:result.path,mpvInstallDirectory:directory,onboardingComplete:true});store.save(true,true);}
}

const shaderDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'shaders') : path.join(__dirname, 'shaders'));
const send = (ch, payload) => {
  if(ch==='lib:changed' && ratings?.syncScope())payload=store.snapshot();
  if(ch==='sync:state')party?.accountChanged(payload);
  if (win && !win.isDestroyed()) win.webContents.send(ch, payload);
};

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 760, minWidth: 720, minHeight: 480, backgroundColor: '#17141f', title: 'Anime Player',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  Menu.setApplicationMenu(null);
  // Windows session end can kill a detached NSIS installer midway through an
  // upgrade. Only ordinary user exits may arm installation on quit.
  win.on('query-session-end',()=>updates?.deferSystemExit());
  win.on('session-end',()=>updates?.deferSystemExit());
  // Diagnosi: errori della pagina e del preload nel terminale; F12 o Ctrl+Maiusc+I aprono la console
  win.webContents.on('preload-error', (_e, file, err) => console.error('[preload-error]', file, err && err.message));
  win.webContents.on('console-message', (e, level, message, line, source) => {
    const msg = message !== undefined ? message : e.message;
    if ((level !== undefined ? level : e.level) >= 2 || e.level === 'error' || e.level === 'warning') console.error('[pagina]', msg, '—', (source || e.sourceId || '') + ':' + (line || e.lineNumber || ''));
  });
  win.webContents.on('before-input-event', (ev, input) => {
    if(win.shortcutCaptureActive)return;
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) { win.webContents.toggleDevTools(); ev.preventDefault(); }
  });
  ElectronSecurity.installWindowSecurity(win,rendererEntry,url=>shell.openExternal(url));
  win.loadFile(rendererEntry);
}

function register() {
  const lib = () => store.snapshot();
  const h = (ch, fn) => ipcMain.handle(ch, async (event, ...a) => {
    ElectronSecurity.requireTrustedSender(event,win,rendererEntry);
    if(store?.accountTransitioning && !['lib:get','auth:state','player:state','player:stop','app:version'].includes(ch))throw Error('Cambio account in corso: attendi prima di modificare la libreria.');
    return fn(...a);
  });

  h('lib:get', () => lib());
  const organization=createOrganizationService({store});
  h('organization:context',()=>organization.context());
  h('organization:move',command=>organization.move(command));
  h('organization:section',command=>organization.section(command));
  h('app:version', () => app.getVersion());
  h('updates:promptShown',()=>updates.markPrompt());
  h('updates:ready',()=>{updates.start();return updates.snapshot();});
  h('updates:list',page=>updates.list(page));
  h('updates:select',version=>updates.select(version));
  h('mpv:startup',()=>mpvStartup);
  h('updates:state',()=>updates?.snapshot() || null);
  h('updates:check',()=>updates.check());
  h('updates:download',()=>updates.download());
  h('updates:later',installOnQuit=>updates.later(installOnQuit));
  h('updates:install',()=>updates.install());
  h('updates:configure',patch=>updates.configure(patch));
  h('updates:releases',()=>shell.openExternal(require('./src/updates').RELEASES));
  h('settings:shortcutCapture',active=>{if(win)win.shortcutCaptureActive=active===true;});
  h('auth:state', () => cloud.getSession());
  h('auth:signUp', (email, password) => cloud.signUp(email, password));
  h('auth:signIn', (email, password) => cloud.signIn(email, password));
  h('auth:sendPasswordRecovery', email => cloud.sendPasswordRecovery(email));
  h('auth:updatePassword', password => cloud.updatePassword(password));
  h('auth:takeRecoveryNotice', () => {const notice=recoveryNotice;recoveryNotice=null;return notice;});
  h('auth:signOut', () => cloud.signOut());
  h('profile:get', (userId) => cloud.getProfile(userId));
  h('profile:mine', () => cloud.getMyProfile());
  h('profile:update', (patch) => cloud.updateProfile(patch));
  h('favorites:list', () => cloud.listFavorites());
  h('favorites:set', (seriesId, favorite) => cloud.setFavorite(seriesId, favorite));
  h('friends:search', (query) => cloud.searchUsers(query));
  h('friends:requests', () => cloud.listFriendRequests());
  h('friends:request', (receiverId) => cloud.sendFriendRequest(receiverId));
  h('friends:respond', (requestId, status) => cloud.respondFriendRequest(requestId, status));
  h('friends:list', () => cloud.listFriends());
  h('friends:remove', (friendId) => cloud.removeFriend(friendId));
  h('watchparty:state',()=>party.snapshot());
  h('watchparty:create',input=>party.create(input));
  h('watchparty:join',input=>party.join(input));
  h('watchparty:leave',()=>party.leave());
  h('watchparty:command',(action,data={})=>party.command(action,{paused:data.paused,position:data.position}));
  h('watchparty:permissions',permissions=>party.permissions(permissions));
  h('watchparty:moderate',(action,target)=>party.moderate(action,target));
  h('watchparty:invite',userId=>party.invite(userId));
  h('watchparty:acceptInvite',id=>party.acceptInvite(id));
  h('watchparty:dismissInvite',id=>party.dismissInvite(id));
  h('watchparty:resync',()=>party.playback.resync());
  h('watchparty:pauseLocal',()=>party.playback.pauseLocal());
  h('watchparty:configure',patch=>party.configure(patch));
  h('watchparty:copyCode',()=>{if(party.code)require('electron').clipboard.writeText(party.code);return true;});
  h('watchparty:source',async input=>{
    if(input?.mode==='file'){const result=await dialog.showOpenDialog(win,{title:'Sorgente Watch Party',properties:['openFile'],filters:[{name:'Video',extensions:['mp4','mkv','webm','mov','avi']}]});if(result.canceled)return false;return party.playback.chooseSource(result.filePaths[0]);}
    return party.playback.chooseSource(String(input?.url||''));
  });
  h('sync:run', () => cloud.sync());
  h('library:export', async () => {
    const r = await dialog.showSaveDialog(win, {
      title: 'Esporta libreria',
      defaultPath: 'anime-player-library.json',
      filters: [{ name: 'Libreria Anime Player', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    try {
      fs.writeFileSync(r.filePath, JSON.stringify(lib(), null, 2), 'utf8');
      return { canceled: false, filePath: r.filePath };
    } catch (e) {
      throw new Error(`Esportazione fallita: ${e.message}`);
    }
  });
  h('library:import', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Importa libreria',
      properties: ['openFile'],
      filters: [{ name: 'Libreria Anime Player', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    try {
      const imported = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
      const checked = validateLibraryData(imported);
      await player.stop();
      const importedLib = store.importData(checked);
      return { canceled: false, filePath: r.filePaths[0], lib: importedLib };
    } catch (e) {
      throw new Error(`Importazione fallita: ${e.message}`);
    }
  });
  h('presets:list', () => A4K.listPresets());
  h('player:state', () => player.state());
  h('settings:set', async (patch) => {
    const scope=store.scope;
    const next = { ...store.data.settings, ...(patch || {}) };
    if (!A4K.PRESETS[next.defaultPreset]) throw new Error('Preset Anime4K non valido.');
    if (!['default', 'compact'].includes(next.theme)) throw new Error('Tema non valido.');
    if (!['en', 'it'].includes(next.language)) throw new Error('Lingua non valida.');
    if (!['translated','original'].includes(next.descriptionMode)) throw new Error('Modalità descrizione non valida.');
    if (patch && Object.hasOwn(patch, 'mpvPath') && next.mpvPath) {
      const result = await mpvManager.validate(next.mpvPath);
      if (!result.ok) throw new Error(result.error || 'Il file selezionato non è un eseguibile mpv compatibile.');
      if(scope!==store.scope)throw Error('Account cambiato: riprova.');
      completeMpv(result);
    }
    if(patch?.onboardingComplete===true&&(!next.mpvPath||!mpvStartup?.ok||mpvStartup.path!==next.mpvPath))throw Error('Configura e verifica mpv prima di completare.');
    if(patch && Object.hasOwn(patch,'shortcuts')){
      const shortcuts=require('./src/playback-shortcuts').validate(patch.shortcuts);
      await player.applyShortcuts(shortcuts);patch={...patch,shortcuts};
    }
    if(scope!==store.scope)throw Error('Account cambiato: riprova / Account changed: retry');
    store.setSettings(patch || {});
    if(patch?.mpvPath)store.save(true,true);
    return lib();
  });
  h('settings:shortcuts',async raw=>{
    const scope=store.scope;
    const shortcuts=require('./src/playback-shortcuts').validate(raw);
    const status=await player.applyShortcuts(shortcuts);
    if(scope!==store.scope)throw Error('Account cambiato: riprova / Account changed: retry');
    store.setSettings({shortcuts});return {lib:lib(),...status};
  });
  h('mpv:detect', async () => {
    const result = await mpvManager.find(store.data.settings.mpvPath);
    if (result.ok) completeMpv(result);
    return { ...result, lib: lib() };
  });
  h('mpv:openGuide', async () => { await shell.openExternal(mpvManager.installGuide); return true; });
  h('mpv:install', async () => {
    const currentDirectory = store.data.settings.mpvInstallDirectory || mpvManager.installDirectory;
    const r = await dialog.showOpenDialog(win, {
      title: 'Scegli dove installare mpv',
      buttonLabel: 'Installa mpv qui',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: currentDirectory || app.getPath('userData'),
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, status: 'cancelled', cancelled: true, lib: lib() };
    const result = await mpvManager.install(r.filePaths[0]);
    if (result.ok) completeMpv(result,result.installDirectory);
    return { ...result, lib: lib() };
  });
  h('mpv:browse', async () => {
    const executableName = process.platform === 'win32' ? 'mpv.exe' : 'mpv';
    const r = await dialog.showOpenDialog(win, { title: `Scegli ${executableName}`, properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: 'mpv', extensions: ['exe'] }] : [] });
    if (r.canceled || !r.filePaths[0]) return lib();
    const result = await mpvManager.validate(r.filePaths[0]);
    if (!result.ok) throw new Error(result.error || 'Il file selezionato non è un eseguibile mpv compatibile.');
    completeMpv(result);
    return lib();
  });

  h('series:search', (text) => meta.searchAnime(text));

  const discoverSeriesSources = (series, titles = [series.title], options = {}) => discoverSources(series, titles, { store, animeUnity, animeWorld, ...options });

  const sourceQueue = createSourceDiscoveryQueue({ store, metadata: meta, discover: discoverSeriesSources,
    onComplete: (id, sourceDiscovery) => send('series:sourcesDiscovered', { id, sourceDiscovery, lib: lib() }),
  });
  const workQueue=createWorkQueue({concurrency:2});
  const addSeries=createSeriesAdder({store,metadata:meta,sourceQueue,loadRatings:(id,options)=>ratings.load(id,options),workQueue});
  h('series:create',addSeries);
  const additions=createAdditionOperationService({store,addSeries,notify:event=>send('addition:progress',event)});
  app.on('before-quit',()=>additions.cancelAll());
  h('series:addStart', async payload=>{const task=additions.start(payload);const result=await task.core;return{taskId:task.taskId,...result};});
  h('series:addTasks',()=>additions.list());
  h('series:addCancel',id=>additions.cancel(id));
  h('series:addRetry',id=>{if(!additions.retry(id))throw new Error('Operazione non ripetibile.');return additions.list();});
  const franchiseService=require('./src/franchise-service').createFranchiseService({store,metadata:meta,sourceQueue,player,addSeries,loadRatings:id=>ratings.load(id),cancelAddition:id=>additions.cancelForSeries(id)});
  h('franchise:create',(sid)=>{const record=store.getSeries(sid);if(!record)throw new Error('Opera non trovata.');const group=store.ensureFranchise({title:record.title,cover:record.cover,banner:record.banner,rootAniListId:record.anilistId});store.setMembership(sid,{franchiseId:group.id});return{lib:lib(),id:group.id};});
  h('franchise:update',(id,patch)=>{store.updateFranchise(id,patch);return lib();});
  h('franchise:member',(sid,patch)=>{store.setMembership(sid,patch);return lib();});
  h('franchise:reorder',(id,ids)=>{store.reorderFranchise(id,ids);return lib();});
  h('franchise:mergePreview',(source,target)=>store.previewFranchiseMerge(source,target));
  h('franchise:merge',(source,target,options)=>{store.mergeFranchises(source,target,options);return lib();});
  h('franchise:delete',async id=>{for(const series of store.franchiseMembers(id))additions.cancelForSeries(series.id);return franchiseService.delete(id);});
  h('franchise:discover',id=>franchiseService.scan(id));
  h('franchise:accept',(id,anilistId,category)=>franchiseService.accept(id,anilistId,category));
  h('franchise:reject',(id,anilistId)=>franchiseService.reject(id,anilistId));
  h('franchise:linkPreview',(id,linkId)=>franchiseService.previewLink(id,linkId));
  h('franchise:linkCreate',token=>franchiseService.createLinked(token));
  h('franchise:linkDecide',(id,linkId,patch)=>franchiseService.decideLink(id,linkId,patch));
  h('franchise:linkManual',(id,targetId,type)=>franchiseService.manualLink(id,targetId,type));
  const addContentLink=(id,{url,partNumber=1,mode='unknown',layout='single'}={})=>{
    const series=store.getSeries(id);if(!series || !require('./src/franchise-model').singleWork(series))throw new Error('Contenuto singolo non trovato.');
    const value=String(url||'').trim();if(!isValidSource(value))throw new Error('Link non valido.');
    if(!['unknown','it','ja-sub-it'].includes(mode))throw new Error('Lingua non valida.');
    if(!['single','multipart'].includes(layout))throw new Error('Struttura dei file non valida.');
    const number=layout==='single'?1:Number(partNumber);
    store.addContentSources(id,[{number,url:value,contentPartKey:layout==='single'?'single':`manual:${number}`,contentLayout:layout==='single'?'single':'manual',
      title:layout==='multipart'?`Part ${number}`:'',language:require('./src/source-language').manualClassification(mode)}]);return lib();
  };
  h('content:addLink',addContentLink);

  h('movie:addLink', (id, url) => {
    return addContentLink(id,{url});
  });
  h('movie:play', async (id, index = 0) => {
    const request = player.beginRequest(id, store.getSeries(id)?.mediaParts?.[0]?.id);
    const series = store.getSeries(id); const source = series?.movieSources?.[index];
    const part=series?.mediaParts?.find(p=>source && p.sources.some(s=>s.url===source.url)) || series?.mediaParts?.[0];
    if (!series || !part) throw new Error('Link del film non trovato.');
    request.episodeId = part.id;
    return preparePlay(request, async () => player.play(id,part.id,{...request,
      ...(source ? {sourceId:part.sources.find(s=>s.url===source.url)?.id} : {})}));
  });

  h('series:discoverSources', async (id) => {
    const series = store.getSeries(id);
    if (!series) throw new Error('Serie non trovata.');
    const sourceDiscovery = await sourceQueue.enqueue(id, [series.title, series.altTitle].filter(Boolean), { notify: false, priority:'interactive' });
    return { lib: lib(), sourceDiscovery };
  });

  h('series:update', (id, patch) => { store.updateSeries(id, patch); return lib(); });
  h('series:videoPreference', async (id, mode) => { await player.changeVideoPreference(id,mode); return lib(); });
  h('episodes:sourceLanguage', (sid,eid,url,mode) => { store.setSourceLanguage(sid,eid,url,mode); return lib(); });
  h('series:delete', async (id) => { additions.cancelForSeries(id); sourceQueue.cancel([id]); await player.stopIfSeries(id); store.deleteSeries(id); return lib(); });

  const syncSeriesRatings = async (id) => {
    const s = store.getSeries(id);
    if (!s) return lib();
    const scope=store.scope;
    let fields = {};
    let kitsuEpisodes = [];
    let kitsuId = s.kitsuId;
    if (s.anilistId) {
      try {
        const m = await meta.getAnime(s.anilistId, { language: store.data.settings.language });
        const { streamingEpisodes, ...f } = m;
        fields = f;
        const { kitsuId: kid, episodes } = await meta.fetchEpisodes({
          anilistId: s.anilistId, kitsuId: s.kitsuId, title: m.altTitle || m.title, streamingEpisodes, episodeCount: m.episodeCount,
        });
        kitsuId = kid;
        kitsuEpisodes = episodes;
      } catch (err) {
        console.warn('AniList/Kitsu error:', err.message);
      }
    }
    fields.kitsuId = kitsuId;

    if(scope!==store.scope || !store.getSeries(id))return lib();
    store.refreshSeriesMetadata(id, fields, kitsuEpisodes);
    await ratings.load(id,{refresh:true});
    return lib();
  };

  h('series:refresh', (id) => syncSeriesRatings(id));
  h('series:ratings', (id,options) => ratings.load(id,{refresh:options?.refresh===true}));
  h('series:imdbSelect', (id,imdbId) => ratings.select(id,imdbId));
  h('episodes:rate', (sid, eid, rating) => { store.rateEpisode(sid, eid, rating); return lib(); });
  h('episodes:skipTimes', async (sid, eid) => {
    const scope=store.scope;
    const s = store.getSeries(sid); const ep = store.getEpisode(sid, eid);
    if (!s || !ep) throw new Error('Episodio non trovato');
    if (ep.kind === 'part') return {skipTimes:ep.skipTimes || [],lib:lib()};
    if (!s.malId || !s.anilistId) return { skipTimes: ep.skipTimes || [], lib: lib() };
    try {
      const skipTimes = await meta.fetchAniSkipTimes(s.malId, ep.number, ep.duration);
      if(scope===store.scope)store.setUnitSkipTimes(sid, eid, skipTimes);
    } catch (err) {
      console.warn('AniSkip error:', err.message);
    }
    return { skipTimes: store.getEpisode(sid, eid)?.skipTimes || [], lib: lib() };
  });

  const checkItems = (items) => {
    const bad = items.find((i) => !isValidSource(i.url));
    if (bad) throw new Error(`Link non valido: ${bad.url}`);
    if (!items.length) throw new Error('Nessun link da aggiungere.');
    return items;
  };
  h('patterns:detect', (url, hint) => detectEpisodeNumber(url, hint));
  h('episodes:addPattern', (sid, { pattern, from, to }) => { store.addSources(sid, checkItems(expandPattern(pattern.trim(), from, to))); return lib(); });
  h('episodes:addList', (sid, { text, start }) => { store.addSources(sid, checkItems(expandList(text, start))); return lib(); });
  h('episodes:addM3U', async (sid, { start }) => {
    const r = await dialog.showOpenDialog(win, { title: 'Scegli una playlist', properties: ['openFile'], filters: [{ name: 'Playlist', extensions: ['m3u', 'm3u8'] }] });
    if (r.canceled || !r.filePaths[0]) return lib();
    store.addSources(sid, checkItems(parseM3U(fs.readFileSync(r.filePaths[0], 'utf8'), start)));
    return lib();
  });
  h('episodes:setSources', (sid, eid, urls) => { const items = urls.filter(Boolean).map((url) => ({ url })); items.forEach((i) => { if (!isValidSource(i.url)) throw new Error(`Link non valido: ${i.url}`); }); store.setSources(sid, eid, items.map((i) => i.url)); return lib(); });
  h('episodes:checkSources', (urls) => checkSources(urls));
  h('episodes:delete', async (sid, eid) => { additions.cancelForSeries(sid);await player.stopIfUnit(sid,eid); store.deleteEpisode(sid, eid); return lib(); });
  h('episodes:mark', (sid, eid, watched) => { store.markWatched(sid, eid, watched); return lib(); });

  const ensureMpv = async (request) => {
    const current = store.data.settings.mpvPath;
    if (current) {
      const result = await mpvManager.validate(current);
      if (!player.isRequestActive(request)) return;
      if (result.ok) return result.path;
    }
    const result = await mpvManager.find(current);
    if (!player.isRequestActive(request)) return;
    if (result.ok) { store.setSettings({ mpvPath: result.path }); return result.path; }
    throw new Error(`MPV_NOT_CONFIGURED: ${result.error || 'mpv non trovato.'}`);
  };
  const preparePlay = async (request, launch) => {
    if(!player.isRequestActive(request))return lib();
    try {
      await ensureMpv(request);
      if (player.isRequestActive(request)) await launch();
    } catch (error) { if (player.isRequestActive(request)) throw error; }
    return lib();
  };
  h('player:play', async (sid, eid) => {
    const request=player.beginRequest(sid,eid);
    const s = store.getSeries(sid); const ep = store.getEpisode(sid, eid);
    if (!s || !ep) throw new Error('Episodio non trovato');
    return preparePlay(request, async () => {
      if (ep.kind !== 'part' && s.malId && (!Array.isArray(ep.skipTimes) || !ep.skipTimes.length)) {
        try {
          const skipTimes=await meta.fetchAniSkipTimes(s.malId, ep.number, ep.duration);
          if(player.isRequestActive(request))store.setUnitSkipTimes(sid,eid,skipTimes);
        } catch (err) { if(player.isRequestActive(request))console.warn('AniSkip error:', require('./src/source-state').redact(err.message)); }
      }
      if(player.isRequestActive(request))await player.play(sid, eid, request);
    });
  });
  h('player:playUrl', async (url, preset) => {
    const request=player.beginRequest();
    if (!isValidSource(String(url).trim())) throw new Error('Link non valido.');
    return preparePlay(request, () => player.playUrl(String(url).trim(), preset, request));
  });
  h('player:stop', () => player.stop());
  h('player:diagnostics', () => player.diagnostics.read());
  h('player:languageFallback', (token,mode) => player.acceptLanguageFallback(token,mode));
  h('player:preset', (id) => player.setPreset(id));
  h('player:seekRelative', (seconds) => player.seekRelative(seconds));
  h('player:seekAbsolute', (seconds) => player.seekAbsolute(seconds));
  h('player:skipIntro', (expected) => player.skipCurrentSegment('intro',expected));
  h('player:skipEnding', (expected) => player.skipCurrentSegment('ending',expected));
  h('player:skipSegment', (end) => player.skipSegment(end));
  h('stats:get', () => store.statistics());
}

async function refreshAiringStatuses() {
  for (const series of [...store.data.series]) {
    if (!series.anilistId) continue;
    try {
      const m = await meta.getAnime(series.anilistId, { language: store.data.settings.language });
      store.updateSeries(series.id, {
        status: m.status,
        nextAiringAt: m.nextAiringAt,
        nextEpisode: m.nextEpisode,
        malId: m.malId,
        description: m.description || series.description,
      });
    } catch (err) {
      console.warn('Aggiornamento stato anime fallito:', series.title, err.message);
    }
  }
  send('lib:changed', store.snapshot());
}

app.whenReady().then(async () => {
  const userDataPath = app.getPath('userData');
  try{store = new Store(path.join(userDataPath, 'library.json'));}
  catch(error){dialog.showErrorBox('Libreria non aperta',`${error.message}\n\nNessun reset automatico. Conserva il file e ripristina soltanto un backup verificato.`);app.quit();return;}
  ratings = createRatingsService({store,notify:payload=>{
    if(!payload.reset && payload.status!=='loading')send('lib:changed',store.snapshot());
    send('series:ratingsProgress',payload);
  }});
  mpvManager = createMpvManager({ userDataPath, installDirectory: store.data.settings.mpvInstallDirectory || '' });
  player = new PlayerManager({ store, paths: { shaderDir: shaderDir(), userData: userDataPath }, notify: send,
    resolveAutomaticSource: async (source, series, episode,options) => {
      // Separate sessions keep refresh diagnostics/cookies independent of background discovery.
      const client = source.provider === 'animeunity' ? new AnimeUnityClient() : new AnimeWorldClient();
      return client.renewSource(source,series,episode,options);
    },
  });
  cloud = new CloudService({ store, userDataPath, safeStorage: require('electron').safeStorage, notify: send,
    beforeLibrarySwitch: async () => {await party?.leave();await player.stop({reason:'account-change'});}, env: app.isPackaged ? process.env : {}, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
  let partyEndpoint;
  if(!app.isPackaged&&process.env.ANIME_PLAYER_TEST_PROFILE&&process.env.ANIME_PLAYER_PARTY_TEST_URL){const url=new URL(process.env.ANIME_PLAYER_PARTY_TEST_URL);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/')throw Error('Endpoint di test non valido');partyEndpoint=url.origin;}
  party=new (require('./src/watchparty').WatchPartyService)({player,store,cloud,notify:send,userDataPath,baseUrl:partyEndpoint});
  player.onWatchSession = (session) => cloud.recordWatchSession(session);
  updates=require('./src/updates').createUpdateService({app,profile:userDataPath,notify:state=>send('updates:state',state),
    isPlaying:()=>!!(player.cur || player.activeRequest || player.pendingLanguageFallback),save:()=>store.save(true,true,{cloud:true})});
  register();
  mpvDevice=new (require('./src/mpv-device').MpvDevice)(userDataPath);
  mpvStartup=await mpvDevice.inspect(mpvManager,store.data.settings);
  if(mpvStartup.ok)completeMpv(mpvStartup,mpvDevice.data.installDirectory);
  createWindow();
  app.setAsDefaultProtocolClient(PASSWORD_RESET_SCHEME);
  cloud.start().then(()=>{party.start();return processPasswordRecoveryLinks();}).catch((err) => console.warn('Avvio Supabase fallito:', err.message));
  setTimeout(() => refreshAiringStatuses().catch((err) => console.warn('Aggiornamento programmazione fallito:', err.message)), 1200);
});

app.on('second-instance', (_event, commandLine) => {
  const url=commandLine.find(isPasswordRecoveryUrl);if(url)queuePasswordRecoveryUrl(url);
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});
require('./src/shutdown').installShutdown(app,()=>({cloud,store,player,updates,party}));
app.on('window-all-closed', () => app.quit());
if(typeof module!=='undefined')module.exports={getServices:()=>({win,player,party,store,cloud})};
