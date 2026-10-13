// Supabase integration. The main process owns credentials, auth tokens and sync.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');
const { PRESETS } = require('./anime4k');
const { detectSeasonFromTitle } = require('./metadata');
const { detectEpisodeNumber, expandPattern } = require('./patterns');
const Language = require('./source-language');
const Franchise = require('./franchise-model');
const Identity = require('./content-identity');
const Links = require('./franchise-links');
const Organization = require('./organization');
const Descriptions=require('./descriptions');
const {validateRoot,validateCloudEnvelope}=require('./library-schema');

function newest(values) {
  return values.filter(Boolean).sort((a,b)=>(Number(b.updatedAt)||0)-(Number(a.updatedAt)||0) || JSON.stringify(b).localeCompare(JSON.stringify(a)))[0];
}
function mergeParts(first=[],second=[]) {
  const parts=new Map(first.map(p=>[p.id,{...p,sources:Identity.mergeSources(p.id,p.sources)}]));
  for (const part of second) {
    const old=parts.get(part.id); if (!old) {parts.set(part.id,{...part,sources:Identity.mergeSources(part.id,part.sources)});continue;}
    const winner=newest([old,part]);
    parts.set(part.id,{...winner,id:old.id,kind:'part',
      ...Identity.mergePersonalRating(part,old),
      automaticSources:[...new Map([...(old.automaticSources || []),...(part.automaticSources || [])].map(s=>[s.id,s])).values()],
      sources:Identity.mergeSources(part.id,old.sources,part.sources),
      progress:newest([old.progress,part.progress]),updatedAt:Math.max(old.updatedAt||0,part.updatedAt||0)});
  }
  return [...parts.values()].sort((a,b)=>a.number-b.number || a.id.localeCompare(b.id));
}

const PROJECT_REF = 'gbdcdserzrujiuacefca'; // anime-player; deliberately excludes the old haxball2 project.
const CLOUD_SETTINGS = ['theme', 'language', 'descriptionMode', 'defaultPreset', 'autoplayNext', 'skipOpening', 'skipEnding', 'alang', 'slang'];
const DEVICE_SETTINGS = ['mpvPath', 'mpvInstallDirectory', 'onboardingComplete'];
const uuid = () => crypto.randomUUID();
const nowIso = (value = Date.now()) => new Date(value).toISOString();
const EMPTY_LIBRARY = () => ({ settings: {}, series: [], deletedSeries: [], deletedEpisodes: [], updatedAt: 0, cloudDirty: false });
const EMPTY_SYNC_STATE = () => ({ mappings: {}, favorites: [], removedFavorites: [], history: [], settingsUpdatedAt: 0, libraryRevision: 0 });

function mergeLibrarySnapshots(localInput, remoteInput) {
  const local = localInput || EMPTY_LIBRARY();
  const remote = remoteInput || EMPTY_LIBRARY();
  validateRoot(local);validateRoot(remote);
  const deletedSeries = new Map();
  const deletedEpisodes = new Map();
  const deletedFranchises = new Map();
  for (const item of [...(remote.deletedFranchises || []),...(local.deletedFranchises || [])]) deletedFranchises.set(item.id,Math.max(deletedFranchises.get(item.id)||0,item.deletedAt||0));
  const franchises=new Map();
  for (const group of [...(remote.franchises || []),...(local.franchises || [])]) {
    const old=franchises.get(group.id);
    if (!old) {franchises.set(group.id,{...group});continue;}
    const custom={};
    for (const field of ['title','cover','banner']) {const value=newest([old.custom?.[field],group.custom?.[field]]);if(value)custom[field]=value;}
    const combined={...newest([old,group]),custom,
      mergedFranchiseMetadata:[...new Map([...(old.mergedFranchiseMetadata||[]),...(group.mergedFranchiseMetadata||[])].map(g=>[g.id,g])).values()],
      suggestions:[...new Map([...(old.suggestions||[]),...(group.suggestions||[])].map(s=>[String(s.anilistId),s])).values()],
      excludedAniListIds:[...new Set([...(old.excludedAniListIds||[]),...(group.excludedAniListIds||[])])]};
    for (const [field,value] of Object.entries(custom)) combined[field]=value.value;
    combined.suggestions=combined.suggestions.filter(s=>!combined.excludedAniListIds.includes(String(s.anilistId)));
    franchises.set(group.id,combined);
  }
  for (const item of [...(remote.deletedSeries || []), ...(local.deletedSeries || [])]) {
    deletedSeries.set(item.id, Math.max(deletedSeries.get(item.id) || 0, Number(item.deletedAt) || 0));
  }
  for (const item of [...(remote.deletedEpisodes || []), ...(local.deletedEpisodes || [])]) {
    const key = `${item.seriesId}:${item.id}`;
    if(!deletedEpisodes.has(key) || Number(item.deletedAt)>=Number(deletedEpisodes.get(key).deletedAt))deletedEpisodes.set(key,{...item});
  }
  const series = new Map();
  for (const item of [...(remote.series || []), ...(local.series || [])]) {
    const current = series.get(item.id);
    if (!current) { series.set(item.id, { ...item, episodes: [...(item.episodes || [])] }); continue; }
    const winner = (Number(item.updatedAt || item.addedAt) || 0) > (Number(current.updatedAt || current.addedAt) || 0) ? item : current;
    const episodes = new Map((current.episodes || []).map((episode) => [episode.id, episode]));
    for (const episode of item.episodes || []) {
      const old = episodes.get(episode.id);
      if (!old) { episodes.set(episode.id, episode); continue; }
      const oldProgressAt = Number(old.progress?.updatedAt) || 0;
      const newProgressAt = Number(episode.progress?.updatedAt) || 0;
      const winner = (Number(episode.updatedAt || newProgressAt) || 0) > (Number(old.updatedAt || oldProgressAt) || 0) ? episode : old;
      const sources = Identity.mergeSources(episode.id,old.sources,episode.sources);
      const measured = [old,episode].filter(ep=>ep.durationSource==='mpv' && Number(ep.duration)>0)
        .sort((a,b)=>(Number(b.updatedAt)||0)-(Number(a.updatedAt)||0))[0];
      const latestProgress=newProgressAt > oldProgressAt ? episode.progress : old.progress;
      episodes.set(episode.id, {
        ...winner,
        ...Identity.mergePersonalRating(episode,old),
        automaticSources:[...new Map([...(old.automaticSources || []),...(episode.automaticSources || [])].map(s=>[s.id,s])).values()],
        ...(measured ? {duration:measured.duration,durationSource:'mpv'} : {}),
        id: old.id || episode.id,
        sources,
        progress: {...latestProgress,duration:Number(latestProgress?.duration)>0 ? latestProgress.duration : Number(old.progress?.duration) || Number(episode.progress?.duration) || 0},
        updatedAt: Math.max(Number(old.updatedAt) || 0, Number(episode.updatedAt) || 0, oldProgressAt, newProgressAt),
      });
    }
    const sourcePattern = item.sourcePattern || current.sourcePattern;
    const older = winner === item ? current : item;
    const memberships=[item,current].map(s=>Franchise.membership(s.franchiseMembership)).filter(Boolean);
    const manual=memberships.filter(m=>m.manual);
    const member=newest(manual.length?manual:memberships);
    // A newer explicit detach must not resurrect the old group through fallback.
    const franchise = Object.fromEntries(['franchiseId', 'franchiseTitle', 'franchiseOrder', 'franchiseType', 'franchiseSeasonNumber']
      .map((key) => [key, winner.franchiseId === null ? null : winner[key] != null ? winner[key] : older[key]])
      .filter(([, value]) => winner.franchiseId === null || value != null));
    const movieSources = new Map([...(current.movieSources || []), ...(item.movieSources || [])].filter((source) => source?.url).map((source) => [source.url, source]));
    const patternOwner = item.sourcePattern ? item : current;
    series.set(item.id, { ...winner, ...franchise, ...(member ? {franchiseMembership:member} : {}),
      ...mergeDescriptions(winner,older,current,item),
      ...Identity.mergePersonalRating(item,current),
      ...(item.mediaParts || current.mediaParts ? {mediaParts:mergeParts(current.mediaParts,item.mediaParts)} : {}),
      videoPreference:Language.mergePreference(item.videoPreference, current.videoPreference),
      sourcePatternLanguage:Language.classification(patternOwner.sourcePatternLanguage), cover:winner.cover || older.cover || null, banner:winner.banner || older.banner || null,
      titleAliases:[...new Set([...(current.titleAliases||[]),...(item.titleAliases||[])])],
      movieSources: [...movieSources.values()], ...(sourcePattern ? { sourcePattern: { ...sourcePattern } } : {}), episodes: [...episodes.values()] });
  }
  const resultSeries = [];
  for (const item of series.values()) {
    if (deletedSeries.has(item.id)) continue;
    item.episodes = (item.episodes || []).filter((episode) => {
      const deletedAt = deletedEpisodes.get(`${item.id}:${episode.id}`)?.deletedAt || 0;
      if (deletedAt) return false; // UUID deletion requires an explicit restore, never a metadata timestamp.
      return true;
    });
    if(item.mediaParts) {
      item.mediaParts=item.mediaParts.filter(part=>{
        return !deletedEpisodes.has(`${item.id}:${part.id}`);
      });
      const converted=new Set(item.mediaParts.map(part=>part.id));
      item.mediaParts=item.mediaParts.map(part=>{
        const legacy=item.episodes.find(episode=>episode.id===part.id);
        return legacy ? mergeParts([part],[{...legacy,key:part.key,layout:part.layout,number:part.number,kind:'part'}])[0] : part;
      });
      item.episodes=item.episodes.filter(episode=>!converted.has(episode.id));
    }
    resultSeries.push(item);
  }
  const localSettingsAt = Number(local.settingsUpdatedAt) || 0;
  const remoteSettingsAt = Number(remote.settingsUpdatedAt) || 0;
  const settings = { ...(local.settings || {}), ...(remote.settings || {}), ...(localSettingsAt >= remoteSettingsAt ? local.settings || {} : {}) };
  return Franchise.migrate({
    settings, series: resultSeries,
    franchiseLinks:Links.mergeLinks(local.franchiseLinks,remote.franchiseLinks),
    organization:Organization.merge(local.organization,remote.organization),
    settingsUpdatedAt:Math.max(localSettingsAt,remoteSettingsAt),
    franchises:[...franchises.values()].filter(g=>!deletedFranchises.has(g.id) || deletedFranchises.get(g.id)<(Number(g.updatedAt)||0)),
    deletedFranchises:[...deletedFranchises].map(([id,deletedAt])=>({id,deletedAt})),
    deletedSeries: [...deletedSeries].map(([id, deletedAt]) => ({ id, deletedAt })),
    deletedEpisodes: [...deletedEpisodes.values()],
    updatedAt: Math.max(Number(local.updatedAt) || 0, Number(remote.updatedAt) || 0), cloudDirty: true,
  });
}
function validCloudSetting(key, value) {
  if (key === 'theme') return ['default', 'compact'].includes(value);
  if (key === 'language') return ['en', 'it'].includes(value);
  if (key === 'descriptionMode')return ['translated','original'].includes(value);
  if (key === 'defaultPreset') return Object.hasOwn(PRESETS, value);
  if (['autoplayNext', 'skipOpening', 'skipEnding'].includes(key)) return typeof value === 'boolean';
  if (['alang', 'slang'].includes(key)) return typeof value === 'string' && value.length <= 256;
  return false;
}

function mergeDescriptions(winner,older,...records){
  const original=String(winner.descriptionOriginal ?? winner.description ?? older.descriptionOriginal ?? older.description ?? '');
  const translations={};
  for(const record of records)for(const [language,entry] of Object.entries(Descriptions.descriptionFields(record).descriptionTranslations)){
    if(!entry || typeof entry!=='object')continue;
    const previous=translations[language];if(!previous||entry.updatedAt>previous.updatedAt)translations[language]=entry;
  }
  const source=winner.descriptionOriginal!=null||winner.description!=null?winner:older;
  return{description:original,descriptionOriginal:original,
    descriptionLanguage:source.descriptionLanguage||'unknown',descriptionSource:source.descriptionSource||'legacy',descriptionTranslations:translations};
}

function compressLibraryForCloud(input) {
  validateRoot(input || EMPTY_LIBRARY());
  const library = JSON.parse(JSON.stringify(input || EMPTY_LIBRARY()));
  library.series = (library.series || []).map((series) => {
    const episodes = series.episodes || [];
    const groups = new Map();
    for (const episode of episodes) for (const source of episode.sources || []) {
      if (source.provider === 'animeworld' || source.provider === 'animeunity') continue;
      const detected = detectEpisodeNumber(source.url, episode.number);
      const candidate = detected && detected.candidates.find((item) => item.number === episode.number);
      if (!candidate) continue;
      const key = candidate.pattern.replace(/\{ep:\d+\}/g, '{ep}');
      const group = groups.get(key) || {patterns:new Set(),samples:[]};
      group.patterns.add(candidate.pattern); group.samples.push({number:episode.number,source});
      groups.set(key,group);
    }
    // Match each observed template against the real URLs. E100..E938 match
    // both {ep} and {ep:3}; E001 proves the minimum width for the whole group.
    const ranked = [...groups.values()].flatMap(group => [...group.patterns].map(pattern => ({pattern,urls:new Map(group.samples
      .filter(({number,source}) => expandPattern(pattern,number,number)[0]?.url === source.url).map(({number,source})=>[number,source]))})))
      .sort((a, b) => b.urls.size - a.urls.size);
    const best = ranked[0];
    let sourcePattern = null; let sourcePatternLanguage = null;
    if (best && best.urls.size) {
      const languages = [...best.urls.values()].map(source => Language.classification(source.language));
      if (languages.every(language => language?.origin === 'manual' && JSON.stringify(language) === JSON.stringify(languages[0]))) sourcePatternLanguage = languages[0];
      // A classified version can end before the series (e.g. DUB E938 vs SUB E1180).
      // Keep the legacy full-season expansion for unclassified manual templates.
      const range = (sourcePatternLanguage ? [...best.urls.keys()] : episodes.map(episode=>episode.number)).filter(Number.isInteger).sort((a, b) => a - b);
      if (range.length) sourcePattern = { pattern: best.pattern, from: range[0], to: range[range.length - 1] };
    }
    const cleanSeries = { ...series };
    if (series.mediaParts) cleanSeries.mediaParts=series.mediaParts.map(part=>({...part,sources:(part.sources||[]).filter(s=>!s.provider),automaticSources:Identity.automaticSources(part)}));
    delete cleanSeries.sourcePattern;
    delete cleanSeries.sourcePatternLanguage;
    if (sourcePattern) {
      cleanSeries.sourcePattern = sourcePattern;
      if (sourcePatternLanguage) cleanSeries.sourcePatternLanguage = sourcePatternLanguage;
    }
    cleanSeries.episodes = episodes.map(({ sources, ...episode }) => ({ ...episode,automaticSources:Identity.automaticSources({...episode,sources}),
      // Keep every manual link (including opaque URLs, IDs and custom headers).
      // Patterns remain a backwards-compatible hint for old snapshots only.
      manualSources:(sources || []).filter(source=>!source.provider).map(source=>({...source,id:Identity.sourceId(episode.id,source)})) }));
    return cleanSeries;
  });
  return library;
}

function expandLibraryFromCloud(input) {
  validateRoot(input || EMPTY_LIBRARY());
  const library = JSON.parse(JSON.stringify(input || EMPTY_LIBRARY()));
  library.series = (library.series || []).map((series) => {
    const sourcePattern = series.sourcePattern || (series.episodes || []).find((episode) => episode.sourcePattern)?.sourcePattern;
    const next = { ...series };
    delete next.sourcePattern;
    next.episodes = (series.episodes || []).map((episode) => {
      let sources = Array.isArray(episode.manualSources) ? episode.manualSources : Array.isArray(episode.sources) ? episode.sources : [];
      if (!Array.isArray(episode.manualSources) && sourcePattern && Number.isInteger(episode.number) && episode.number >= sourcePattern.from && episode.number <= sourcePattern.to) {
        try {
          const link = expandPattern(sourcePattern.pattern, episode.number, episode.number)[0]?.url;
          if (link) {
            const language = Language.classification(series.sourcePatternLanguage);
            sources = [{ url: link, ...(language?.origin === 'manual' ? {language} : {}) }];
          }
        } catch { /* pattern cloud non valido: conserva eventuali sorgenti locali */ }
      }
      const {manualSources,...fields}=episode;
      return { ...fields, sources };
    });
    return next;
  });
  return library;
}

function readConfig(env = process.env, configFile = null, bundledConfigFile = null) {
  let local = {};
  for (const file of [bundledConfigFile, configFile].filter(Boolean)) {
    try { local = JSON.parse(fs.readFileSync(file, 'utf8')); break; } catch (error) {
      if (error.code !== 'ENOENT') return { configured: false, error: 'La configurazione Supabase dell’app non è valida.' };
    }
  }
  const url = String(env.SUPABASE_URL || local.url || '').trim();
  const key = String(env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || local.publishableKey || '').trim();
  if (!url || !key) return { configured: false, error: 'Questa build non contiene la configurazione Supabase.' };
  let parsed;
  try { parsed = new URL(url); } catch { return { configured: false, error: 'SUPABASE_URL non è un URL valido.' }; }
  if (parsed.hostname !== `${PROJECT_REF}.supabase.co`) {
    return { configured: false, error: `Configurazione rifiutata: l’app è vincolata al progetto anime-player (${PROJECT_REF}).` };
  }
  let legacyRole = null;
  try { legacyRole = JSON.parse(Buffer.from(key.split('.')[1] || '', 'base64url').toString('utf8')).role; } catch { /* publishable keys are not JWTs */ }
  if (key.startsWith('sb_secret_') || /service[_-]?role/i.test(key) || (!key.startsWith('sb_publishable_') && legacyRole !== 'anon')) {
    return { configured: false, error: 'È consentita solo una publishable key o la vecchia anon key.' };
  }
  return { configured: true, url: parsed.origin, key };
}

function createSessionStorage({ safeStorage, file, isCurrent=()=>true }) {
  const read = () => {
    try {
      if (!isCurrent() || !safeStorage.isEncryptionAvailable()) return null;
      const encoded = JSON.parse(fs.readFileSync(file, 'utf8')).session;
      return encoded ? safeStorage.decryptString(Buffer.from(encoded, 'base64')) : null;
    } catch { return null; }
  };
  const write = (session) => {
    if (!isCurrent() || !safeStorage.isEncryptionAvailable()) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const encrypted = safeStorage.encryptString(session).toString('base64');
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ session: encrypted }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  return {
    getItem: async () => read(),
    setItem: async (_key, value) => write(value),
    removeItem: async () => { if(!isCurrent())return;try { fs.unlinkSync(file); } catch(error) { if(error.code!=='ENOENT')throw error; } },
  };
}

class CloudService {
  constructor({ store, userDataPath, safeStorage, notify = () => {}, beforeLibrarySwitch = async () => {}, env = process.env, client = null, clientFactory=null, remoteSignOut=null, logoutTimeoutMs=5000, isPackaged = false, resourcesPath = null }) {
    this.store = store;
    this.beforeLibrarySwitch=beforeLibrarySwitch;
    this.libraryFile = store.file;
    this.legacyLibrarySnapshot = store.snapshot();
    this.legacySyncSnapshot = null;
    this.legacyOwnerOverrideId = String(env.ANIME_PLAYER_LEGACY_OWNER_ID || '').trim() || null;
    this.libraryClaimFile = path.join(userDataPath, 'library-owner.json');
    this.activeLibraryUserId = null;
    this.file = path.join(userDataPath, 'supabase-sync.json');
    this.baseStateFile = this.file;
    this.notify = notify;
    this.configFile = path.join(userDataPath, 'supabase-config.json');
    const bundledConfigFile = isPackaged && resourcesPath ? path.join(resourcesPath, 'supabase-config.json') : null;
    this.config = readConfig(env, this.configFile, bundledConfigFile);
    this.state = this._loadState();
    this.client = client;
    this.safeStorage = safeStorage;
    this._clientGeneration=0;this._requestAbort=new AbortController();
    this._authRequestId=0;this._session=null;this.logoutTimeoutMs=logoutTimeoutMs;
    this.sessionFile=path.join(userDataPath,'supabase-session.json');
    this._clientFactory=clientFactory || (!client && this.config.configured ? ()=>this._createClient() : null);
    this._remoteSignOut=remoteSignOut || (async (session,signal)=>{
      if(!session?.access_token)throw Error('Sessione remota non disponibile: revoca non confermata.');
      const remote=createClient(this.config.url,this.config.key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:(url,init)=>fetch(url,{...init,signal})}});
      // Public SDK endpoint accepts the departing user's JWT, not a server key.
      return remote.auth.admin.signOut(session.access_token,'local');
    });
    if (!this.client && this.config.configured) {
      this.client = this._clientFactory();
    }
    this._accountEpoch = 0;
    this._stateRevision = 0;
    this.user = null;
    this.syncing = null;
    this.timer = null;
    this.stopped = false;
    this.pendingCatalogMatches = 0;
    this._lastQueuedPosition = new Map();
    this._onProgress = (event) => this._queueProgress(event);
    this._onSettings = (event) => this._queueSettings(event);
    this._onLibraryChanged = () => { if (this.user && !this.suppressLibrarySync) this._scheduleSync(1500); };
  }

  get user() { return this._user; }
  set user(value) {
    if((this._user?.id || null)!==(value?.id || null)){this._accountEpoch++;this._cancelRequests();}
    this._user=value;
  }
  _cancelRequests(){this._requestAbort?.abort();this._requestAbort=new AbortController();this.syncing=null;clearTimeout(this.syncTimer);}
  _createClient(){
    const generation=this._clientGeneration;
    return createClient(this.config.url,this.config.key,{
      auth:{storage:createSessionStorage({safeStorage:this.safeStorage,file:this.sessionFile,isCurrent:()=>generation===this._clientGeneration}),autoRefreshToken:true,persistSession:true,detectSessionInUrl:false},
      global:{fetch:(url,init={})=>{
        if(generation!==this._clientGeneration)return Promise.reject(Error('Contesto account scaduto.'));
        const signal=init.signal?AbortSignal.any([init.signal,this._requestAbort.signal]):this._requestAbort.signal;
        return fetch(url,{...init,signal});
      }},realtime:{transport:WebSocket},
    });
  }
  _rotateAuthClient(){
    if(!this._clientFactory)return;
    const old=this.client;this.authSubscription?.unsubscribe();this.authSubscription=null;
    this._clientGeneration++;
    Promise.resolve(old?.auth.stopAutoRefresh?.()).catch(()=>{});
    Promise.resolve(old?.removeAllChannels?.()).catch(()=>{});
    this.client=this._clientFactory();if(this._started)this._subscribeAuth();
  }
  _subscribeAuth(){
    if(!this.client?.auth.onAuthStateChange)return;
    const generation=this._clientGeneration;
    const {data:{subscription}}=this.client.auth.onAuthStateChange((_event,session)=>{
      if(generation!==this._clientGeneration || this._authChanging || (this._logoutPromise && this._logoutRequest===this._authRequestId) || this.stopped)return;
      this._session=session;this.user=session?.user || null;this._publish();
      const epoch=this._accountEpoch;
      setTimeout(()=>{if(epoch!==this._accountEpoch || this.stopped)return;(this.user?this.sync():this._activateLibrary(null)).catch(error=>this._failed(error));},0);
    });this.authSubscription=subscription;
  }
  _context(userId) { return {userId,epoch:this._accountEpoch,scope:this.store.scope,file:this.store.file,stateFile:this.file,signal:this._requestAbort.signal}; }
  _query(query,context){
    const request=context?.signal && typeof query.abortSignal==='function'?query.abortSignal(context.signal):query;
    return context?.strict?Promise.resolve(request).then(result=>{if(!this._current(context))throw Error('Contesto account scaduto.');return result;}):request;
  }
  _current(context) {
    return context && !this.stopped && !this._authChanging && this.user?.id===context.userId && this._accountEpoch===context.epoch
      && this.activeLibraryUserId===context.userId && this.store.scope===context.scope && this.store.file===context.file && this.file===context.stateFile;
  }

  _loadState() {
    try {
      const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        mappings: loaded.mappings || {}, favorites: loaded.favorites || [], removedFavorites: loaded.removedFavorites || [],
        history: loaded.history || [], settingsUpdatedAt: Number(loaded.settingsUpdatedAt) || 0, libraryRevision: Number(loaded.libraryRevision) || 0,
      };
    } catch { return EMPTY_SYNC_STATE(); }
  }

  _saveState() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  status() {
    return { configured: this.config.configured, connected: Boolean(this.user), user: this.user ? { id: this.user.id, email: this.user.email } : null, error: this.config.error || null, syncing: Boolean(this.syncing), pendingCatalogMatches: this.pendingCatalogMatches, logout:this.logoutStatus || null, authGeneration:this._authRequestId };
  }

  _publish(message = null) { this.notify('sync:state', { ...this.status(), message }); }

  async start() {
    this._started=true;
    this.store.on('progress', this._onProgress);
    this.store.on('settings', this._onSettings);
    this.store.on('changed', this._onLibraryChanged);
    if (!this.client) { this._publish(); return; }
    this._subscribeAuth();
    const epoch=this._accountEpoch;
    const { data: { session }, error } = await this.client.auth.getSession();
    if (error) this._failed(error);
    if(epoch===this._accountEpoch){this._session=session;this.user = session && session.user || null;}
    this._publish();
    if (this.user) this.sync().catch((err) => this._failed(err));
    // Retry local outbox while the app is open; network errors never block local playback.
    this.timer = setInterval(() => { if (this.user) this.sync().catch((err) => this._failed(err)); }, 60000);
  }

  stop() {
    this.stopped = true;
    this._cancelRequests();
    clearTimeout(this.syncTimer);
    clearInterval(this.timer);
    if (this.authSubscription) this.authSubscription.unsubscribe();
    this.store.removeListener('progress', this._onProgress);
    this.store.removeListener('settings', this._onSettings);
    this.store.removeListener('changed', this._onLibraryChanged);
  }

  _failed(error) {
    this.lastError = error && error.message || String(error);
    console.warn('[supabase]', this.lastError);
    this._publish(this.lastError);
  }

  _queueProgress({ seriesId, episodeId, progress, force }) {
    const series = this.store.getSeries(seriesId);
    const episode = this.store.getEpisode(seriesId, episodeId);
    if (!series || !episode || !this.client) return;
    const key = `${seriesId}:${episodeId}`;
    const previous = this._lastQueuedPosition.get(key) ?? 0;
    if (!force && !progress.watched && Math.abs(progress.pos - previous) < 30) return;
    this._lastQueuedPosition.set(key, progress.pos);
    this._scheduleSync(force ? 0 : 5000);
  }

  _queueSettings({ settings, updatedAt }) {
    if (!this.client || !CLOUD_SETTINGS.some((key) => Object.hasOwn(settings, key))) return;
    this.state.settingsUpdatedAt = updatedAt;
    this._stateRevision++;
    this._saveState();
    this._scheduleSync(1500);
  }

  _scheduleSync(delay) {
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.sync().catch((error) => this._failed(error)), delay);
  }

  async signUp(email, password) {
    this._requireClient();
    if(this._localTransition)await this._localTransition;
    const request=++this._authRequestId;this._authChanging=true;
    this._rotateAuthClient();
    let result;try{result=await this.client.auth.signUp({email,password});}finally{if(request===this._authRequestId)this._authChanging=false;}
    if(request!==this._authRequestId)throw Error('Richiesta registrazione superata da un cambio account.');
    const {data,error}=result;if(error)throw error;
    if (data.user && data.session) {
      this.logoutStatus=null;this._session=data.session;this.user=data.user;await this._activateLibrary(data.user.id);
      const context=this._context(data.user.id);await this.ensureProfile(data.user.id,{},context);
      if(!this._current(context))throw Error('Contesto registrazione scaduto.');
      this.sync().catch(err=>this._failed(err));this._publish();
    }
    return { user: data.user, needsEmailConfirmation: Boolean(data.user && !data.session), connected: Boolean(data.session) };
  }

  async signIn(email, password) {
    this._requireClient();
    if(this._localTransition)await this._localTransition;
    const request=++this._authRequestId;this._authChanging=true;this._accountEpoch++;this._cancelRequests();
    this._rotateAuthClient();
    let result;
    try{result=await this.client.auth.signInWithPassword({email,password});}finally{if(request===this._authRequestId)this._authChanging=false;}
    if(request!==this._authRequestId)throw Error('Richiesta accesso superata da un cambio account.');
    const {data,error}=result;if(error)throw error;
    this.logoutStatus=null;this._session=data.session || null;this.user = data.user;
    await this._activateLibrary(data.user.id);
    const context=this._context(data.user.id);await this.ensureProfile(data.user.id,{},context);
    if(!this._current(context))throw Error('Contesto accesso scaduto.');
    this.sync().catch((err) => this._failed(err));
    this._publish();
    return data.user;
  }

  async sendPasswordRecovery(email) {
    this._requireClient();
    const address=String(email || '').trim();
    if(!address)throw Error('Inserisci l’indirizzo email.');
    const {error}=await this.client.auth.resetPasswordForEmail(address,{redirectTo:'animeplayer://auth/reset-password'});
    if(error)throw error;
    // Auth intentionally gives the same result for existing and unknown emails.
    return true;
  }

  async completePasswordRecoveryLink(rawUrl) {
    this._requireClient();
    let url;try{url=new URL(String(rawUrl));}catch{throw Error('Link di recupero non valido.');}
    if(url.protocol!=='animeplayer:' || url.hostname!=='auth' || url.pathname!=='/reset-password' || url.username || url.password)
      throw Error('Link di recupero non valido.');
    const params=new URLSearchParams(url.search.slice(1));
    for(const [key,value] of new URLSearchParams(url.hash.slice(1)))params.set(key,value);
    const type=params.get('type');
    if(type && type!=='recovery')throw Error('Questo link non serve a reimpostare la password.');
    if(params.get('error_description'))throw Error(params.get('error_description'));
    if(type!=='recovery'&&!params.get('code'))throw Error('Questo link non serve a reimpostare la password.');
    const request=++this._authRequestId;this._authChanging=true;this._accountEpoch++;this._cancelRequests();this._rotateAuthClient();
    let result;
    try{
      const code=params.get('code');
      if(code)result=await this.client.auth.exchangeCodeForSession(code);
      else {
        const access_token=params.get('access_token'),refresh_token=params.get('refresh_token');
        if(!access_token || !refresh_token)throw Error('Il link è incompleto o scaduto. Richiedi un’altra email.');
        result=await this.client.auth.setSession({access_token,refresh_token});
      }
    }finally{if(request===this._authRequestId)this._authChanging=false;}
    if(request!==this._authRequestId)throw Error('Recupero password superato da un cambio account.');
    if(result.error)throw result.error;
    if(!result.data?.session || !result.data?.user)throw Error('Il link non ha creato una sessione di recupero valida.');
    this._session=result.data.session;this.user=result.data.user;
    await this._activateLibrary(result.data.user.id);
    const context=this._context(result.data.user.id);await this.ensureProfile(result.data.user.id,{},context);
    if(!this._current(context))throw Error('Contesto account scaduto.');
    this._publish();
    return true;
  }

  async updatePassword(password) {
    this._requireClient();
    if(!this.user)throw Error('Il link di recupero è scaduto. Richiedi un’altra email.');
    const value=String(password || '');
    if(value.length<6)throw Error('La password deve contenere almeno 6 caratteri.');
    const {error}=await this.client.auth.updateUser({password:value});
    if(error)throw error;
    return true;
  }

  signOut() {
    if(this._logoutPromise && this._logoutRequest===this._authRequestId)return this._logoutPromise;
    this._requireClient();
    // Flush the departing account's library and outbox before changing paths.
    // Failure is explicit and stops logout rather than silently losing edits.
    this.store.save(true,true,{cloud:true,emit:false});this._saveState();
    const session=this._session,oldClient=this.client;
    const request=++this._authRequestId;this._authChanging=false;this._accountEpoch++;this.user=null;this._cancelRequests();
    this._logoutRequest=request;
    this.store.scope++;this.store.revision++;
    this.store.accountTransitioning=true;
    this.logoutStatus={local:true,remote:'pending'};this._publish('Disconnesso localmente; revoca remota in corso.');
    this.authSubscription?.unsubscribe();this.authSubscription=null;
    this._clientGeneration++;this._session=null;
    try{fs.unlinkSync(this.sessionFile);}catch(error){if(error.code!=='ENOENT'){this._authBlocked=true;this.logoutStatus.remote='unconfirmed';throw Error('Logout locale: impossibile rimuovere la sessione cifrata. Dati account conservati; accesso bloccato fino al recupero del file.');}}
    Promise.resolve(oldClient.auth.stopAutoRefresh?.()).catch(()=>{});
    Promise.resolve(oldClient.removeAllChannels?.()).catch(()=>{});
    this.client=this._clientFactory?this._clientFactory():null;if(this._started)this._subscribeAuth();
    const controller=new AbortController();let timer;
    const remote=Promise.resolve().then(()=>this._remoteSignOut(session,controller.signal)).then(result=>result?.error?{remote:'error'}:{remote:'confirmed'},()=>({remote:'error'}));
    const deadline=new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({remote:'timeout'});},this.logoutTimeoutMs);});
    const remoteResult=Promise.race([remote,deadline]).finally(()=>clearTimeout(timer));
    remoteResult.then(outcome=>{if(request===this._authRequestId){this.logoutStatus={...this.logoutStatus,...outcome};if(this._authBlocked)this._publish('Contesto locale bloccato; esito revoca remota: '+outcome.remote);}});
    this._localTransition=this._activateLibrary(null).then(()=>{this.store.accountTransitioning=false;},error=>{
      this._authBlocked=true;
      throw Error('Cambio libreria non riuscito; dati account conservati e operazioni bloccate fino al recupero del file. '+error.message);
    });
    const running=(async()=>{
      await this._localTransition;
      const outcome=await remoteResult;
      if(request===this._authRequestId){this.logoutStatus={local:true,...outcome};this._publish(outcome.remote==='confirmed'?'Logout locale completato; revoca remota confermata.':'Logout locale completato; revoca remota non confermata.');}
      return {local:true,...outcome,authGeneration:request};
    })().finally(()=>{if(this._logoutPromise===running){this._logoutPromise=null;this._localTransition=null;}});
    this._logoutPromise=running;return running;
  }

  async getSession() {
    if (!this.client || this._authBlocked || this._authChanging || this._logoutPromise) return this.status();
    const epoch=this._accountEpoch;
    const { data, error } = await this.client.auth.getSession();
    if (error) throw error;
    if(epoch===this._accountEpoch && !this._authChanging){this._session=data.session;this.user = data.session && data.session.user || null;}
    return { ...this.status(), user: this.user ? { id: this.user.id, email: this.user.email, email_confirmed_at: this.user.email_confirmed_at || null } : null };
  }

  // Main-process service only. Never expose this result through renderer IPC.
  async watchPartyCredentials(){
    if(!this.user||this._authBlocked||this._authChanging||this._logoutPromise)return null;
    const epoch=this._accountEpoch,id=this.user.id,{data,error}=await this.client.auth.getSession();
    if(error)throw error;
    if(epoch!==this._accountEpoch||this.user?.id!==id||data.session?.user.id!==id)throw Error('Sessione account cambiata');
    if(!data.session?.access_token)throw Error('Accedi nuovamente all’account');
    return {accessToken:data.session.access_token,userId:id};
  }

  _requireClient() {
    if(this._authBlocked)throw Error('Contesto account bloccato: recupera i file prima di accedere.');
    if (!this.client) throw new Error(this.config.error || 'Supabase non configurato.');
  }

  _requireUser() {
    this._requireClient();
    if(this._authChanging)throw Error('Cambio account in corso.');
    if (!this.user) throw new Error('Accedi a Supabase per continuare.');
    return this.user;
  }

  async ensureProfile(userId, profile = {},context) {
    this._requireClient();
    const { error } = await this._query(this.client.from('profiles').upsert({ id: userId, ...profile }, { onConflict: 'id' }),context);
    if (error) throw error;
  }

  async getProfile(userId = null) {
    const user = this._requireUser();
    const context={...this._context(user.id),strict:true};
    const { data, error } = await this._query(this.client.from('profiles').select('id,username,display_name,avatar_url,bio,created_at,updated_at').eq('id', userId || user.id).maybeSingle(),context);
    if (error) throw error;
    return data;
  }

  async updateProfile(patch) {
    const user = this._requireUser();
    const context={...this._context(user.id),strict:true};
    const allowed = ['username', 'display_name', 'avatar_url', 'bio'];
    const value = Object.fromEntries(Object.entries(patch || {}).filter(([key]) => allowed.includes(key)));
    if (Object.hasOwn(value, 'username')) {
      value.username = value.username == null ? null : String(value.username).trim().replace(/^@/, '').toLowerCase();
      if (value.username && !/^[a-z0-9_]{3,24}$/.test(value.username)) throw new Error('Il nickname deve contenere 3–24 caratteri: lettere, numeri o underscore.');
    }
    if (Object.hasOwn(value, 'display_name') && value.display_name != null) {
      value.display_name = String(value.display_name).trim();
      if (value.display_name.length > 48) throw new Error('Il nome visualizzato può contenere al massimo 48 caratteri.');
    }
    if (Object.hasOwn(value, 'avatar_url')) {
      value.avatar_url = value.avatar_url == null || value.avatar_url === '' ? null : String(value.avatar_url).trim();
      if (value.avatar_url) {
        let url;
        try { url = new URL(value.avatar_url); } catch { throw new Error('L’immagine del profilo deve usare un URL HTTPS valido.'); }
        if (url.protocol !== 'https:' || value.avatar_url.length > 500) throw new Error('L’immagine del profilo deve usare un URL HTTPS valido (massimo 500 caratteri).');
      }
    }
    if (Object.hasOwn(value, 'bio') && value.bio != null) {
      value.bio = String(value.bio).trim();
      if (value.bio.length > 280) throw new Error('La descrizione può contenere al massimo 280 caratteri.');
    }
    const { data, error } = await this._query(this.client.from('profiles').upsert({ id: user.id, ...value, updated_at: nowIso() }, { onConflict: 'id' }).select().single(),context);
    if (error) throw error;
    return data;
  }

  recordWatchSession({ seriesId, episodeId, startedAt, finishedAt, watchedSeconds }) {
    this._stateRevision++;
    this.store.save();
    this.state.history.push({ id: uuid(), seriesId, episodeId, startedAt: nowIso(startedAt), finishedAt: nowIso(finishedAt), watchedSeconds: Math.max(0, Number(watchedSeconds) || 0), synced: false });
    this._saveState();
    if (this.user) this._scheduleSync(1000);
  }

  async setFavorite(seriesId, favorite) {
    const series = this.store.getSeries(seriesId);
    if (!series) throw new Error('Serie non trovata.');
    this._stateRevision++;
    this.store.save();
    if (favorite) {
      this.state.removedFavorites = this.state.removedFavorites.filter((id) => id !== seriesId);
      if (!this.state.favorites.includes(seriesId)) this.state.favorites.push(seriesId);
    } else {
      this.state.favorites = this.state.favorites.filter((id) => id !== seriesId);
      if (series.anilistId && !this.state.removedFavorites.includes(seriesId)) this.state.removedFavorites.push(seriesId);
    }
    this._saveState();
    if (this.user) {
      try { await this.sync(); } catch (error) { this._failed(error); }
    }
    return this.state.favorites.includes(seriesId);
  }

  async listFavorites() { return [...this.state.favorites]; }

  async sync() {
    if (this.syncing) return this.syncing;
    if (!this.client || !this.user || this.stopped) return;
    const userId = this.user.id;
    const running=this._syncForUser(userId).finally(() => { if(this.syncing!==running)return;this.syncing = null; this._publish(); if (this.user && this.user.id !== userId) this._scheduleSync(0); });
    this.syncing=running;
    this._publish();
    return this.syncing;
  }

  async _syncForUser(userId) {
    if(this.user?.id!==userId || this.stopped)return;
    await this._activateLibrary(userId);
    const context=this._context(userId);
    await this._syncPrivateLibrary(userId,context);
    if(!this._current(context))return;
    await this.ensureProfile(userId,{},context);
    if(!this._current(context))return;
    const catalog = await this._resolveCatalog(context);
    if(!this._current(context))return;
    await this._syncProgress(userId, catalog,context);
    if(!this._current(context))return;
    await this._syncHistory(userId, catalog,context);
    if(!this._current(context))return;
    await this._syncFavorites(userId, catalog,context);
    if(!this._current(context))return;
    await this._syncSettings(userId,context);
    if(!this._current(context))return;
    await this._syncPrivateLibrary(userId,context);
    if(!this._current(context))return;
    this._saveState();
    this.lastError = null;
    const message = this.pendingCatalogMatches
      ? `Libreria privata sincronizzata; ${this.pendingCatalogMatches} anime/episodi locali attendono una voce nel catalogo condiviso per la sincronizzazione aggiuntiva.`
      : 'Libreria privata sincronizzata';
    this._publish(message);
  }

  async getMyProfile() {
    const user = this._requireUser();
    const context={...this._context(user.id),strict:true};
    const profile = await this.getProfile(user.id);
    return profile || { id: user.id, username: null, display_name: null, avatar_url: null, bio: null };
  }

  _syncFileForUser(userId) { return path.join(path.dirname(this.baseStateFile), `supabase-sync-${userId}.json`); }

  async _activateLibrary(userId) {
    if (this.activeLibraryUserId === userId) return;
    this._accountEpoch++;
    const epoch=this._accountEpoch;
    // Flush/stop the current account's player before replacing its Store.
    await this.beforeLibrarySwitch();
    if(epoch!==this._accountEpoch || (this.user?.id || null)!==userId)return;
    const wasUnclaimed = !fs.existsSync(this.libraryClaimFile);
    let claim = null;
    try { claim = JSON.parse(fs.readFileSync(this.libraryClaimFile, 'utf8')); } catch { /* first login */ }
    const targetFile = userId ? path.join(path.dirname(this.libraryFile), `library-${userId}.json`) : this.libraryFile;
    const legacySnapshot=this.store.file===this.libraryFile?this.store.snapshot():this.legacyLibrarySnapshot;
    const legacyState=this.file===this.baseStateFile?JSON.parse(JSON.stringify(this.state)):this.legacySyncSnapshot;
    const hasLegacyData=legacySnapshot.series.length || legacySnapshot.franchises?.length || legacySnapshot.deletedSeries?.length
      || legacySnapshot.deletedEpisodes?.length || legacyState?.history?.length || legacyState?.favorites?.length;
    if (userId && wasUnclaimed && this.legacyOwnerOverrideId && this.legacyOwnerOverrideId !== userId && legacySnapshot.series.length) {
      throw new Error('Per trasferire la libreria locale, accedi all’account che hai indicato.');
    }
    const legacyOwnerId = claim && claim.userId ? claim.userId : (userId && wasUnclaimed ? userId : null);
    const legacyOwnerFile = legacyOwnerId ? path.join(path.dirname(this.libraryFile), `library-${legacyOwnerId}.json`) : null;
    let transferred=false;
    if (legacyOwnerId && hasLegacyData && !fs.existsSync(legacyOwnerFile)) {
      // A saved owner marker keeps the original library assigned to the selected account.
      this.store.writeLibraryFile(legacyOwnerFile, legacySnapshot);
      transferred=true;
      const ownerStateFile = this._syncFileForUser(legacyOwnerId);
      if (!fs.existsSync(ownerStateFile)) {
        fs.writeFileSync(ownerStateFile, JSON.stringify(legacyState, null, 2), { mode: 0o600 });
      }
    }
    if (userId && wasUnclaimed && !claim) {
      fs.mkdirSync(path.dirname(this.libraryClaimFile), { recursive: true });
      fs.writeFileSync(this.libraryClaimFile, JSON.stringify({ userId }), { mode: 0o600 });
    }
    this.suppressLibrarySync = true;
    try { this.store.switchFile(targetFile); } finally { this.suppressLibrarySync = false; }
    if (transferred) {
      // Clear only the snapshot just transferred, AFTER switchFile has flushed
      // the old path. Later anonymous libraries are independent and stay intact.
      this.store.backup('pre-account-transfer',this.libraryFile);
      this.store.backup('pre-account-transfer',this.baseStateFile);
      this.store.writeLibraryFile(this.libraryFile, EMPTY_LIBRARY());
      const stateTemp=`${this.baseStateFile}.tmp`;
      fs.writeFileSync(stateTemp,JSON.stringify(EMPTY_SYNC_STATE(),null,2),{mode:0o600});
      fs.renameSync(stateTemp,this.baseStateFile);
    }
    this.activeLibraryUserId = userId;
    this.file = userId ? this._syncFileForUser(userId) : this.baseStateFile;
    this.state = this._loadState();
    this.legacySyncSnapshot = JSON.parse(JSON.stringify(this.state));
  }

  _privateSnapshot() {
    const library = this.store.snapshot();
    library.settings = Object.fromEntries(Object.entries(library.settings || {}).filter(([key]) => !DEVICE_SETTINGS.includes(key)));
    library.cloudDirty = false;
    return JSON.parse(JSON.stringify({ library: compressLibraryForCloud(library), history: this.state.history, sync: { mappings: this.state.mappings, favorites: this.state.favorites, removedFavorites: this.state.removedFavorites, settingsUpdatedAt: this.state.settingsUpdatedAt } }));
  }

  async _syncPrivateLibrary(userId,context=this._context(userId)) {
    if(!this._current(context))return;
    const readStateRevision=this._stateRevision;
    const { data: remote, error } = await this._query(this.client.from('user_library_snapshots').select('snapshot,revision,updated_at').eq('user_id', userId).maybeSingle(),context);
    if(!this._current(context))return;
    if (error) throw error;
    const localDirty = Boolean(this.store.data.cloudDirty) || readStateRevision!==this._stateRevision;
    if(remote)validateCloudEnvelope(remote.snapshot);
    const localRevision = Number(this.state.libraryRevision) || 0;
    if (!remote) {
      const token=this.store.versionToken(),stateRevision=this._stateRevision;
      const snapshot = this._privateSnapshot();
      snapshot.library.settings = Object.fromEntries(Object.entries(snapshot.library.settings || {}).filter(([key]) => !DEVICE_SETTINGS.includes(key)));
      const { data, error: insertError } = await this._query(this.client.from('user_library_snapshots').insert({ user_id: userId, snapshot, revision: 1, updated_at: nowIso() }).select('revision,updated_at').single(),context);
      if(!this._current(context))return;
      if (insertError) { if (insertError.code === '23505') {this._scheduleSync(1000);return;} throw insertError; }
      this.state.libraryRevision = Number(data.revision) || 1;
      if(stateRevision===this._stateRevision)this.store.markCloudSynced(data.updated_at,token);
      if(!this.store.matchesToken(token) || stateRevision!==this._stateRevision) {this.store.save(true,true);this._scheduleSync(1000);}
      this._saveState();
      return;
    }
    if (!localDirty && localRevision !== Number(remote.revision)) {
      const deviceSettings = Object.fromEntries(DEVICE_SETTINGS.map((key) => [key, this.store.data.settings[key]]));
      const remoteSnapshot = remote.snapshot || {};
      const restored = mergeLibrarySnapshots(this.store.snapshot(), { ...expandLibraryFromCloud(remoteSnapshot.library || EMPTY_LIBRARY()), cloudDirty: false });
      restored.settings = { ...(remoteSnapshot.library?.settings || {}), ...deviceSettings };
      restored.cloudDirty = false;
      this.suppressLibrarySync = true;
      try { this.store.applyCloudData(restored, remote.updated_at); } finally { this.suppressLibrarySync = false; }
      this.state = { ...this.state, ...(remoteSnapshot.sync || {}), history: [...new Map([...(remoteSnapshot.history || []),...this.state.history].map(r=>[r.id,r])).values()], libraryRevision: Number(remote.revision) };
      this._saveState();
      return;
    }
    if (!localDirty) return;
    const token=this.store.versionToken(),base=this.store.snapshot(),stateRevision=this._stateRevision;
    let library = base;
    if (localRevision !== Number(remote.revision)) library = mergeLibrarySnapshots(library, expandLibraryFromCloud(remote.snapshot?.library || EMPTY_LIBRARY()));
    const snapshot = this._privateSnapshot();
    snapshot.library = compressLibraryForCloud(library);
    snapshot.library.settings = Object.fromEntries(Object.entries(snapshot.library.settings || {}).filter(([key]) => !DEVICE_SETTINGS.includes(key)));
    const history = new Map([...(remote.snapshot?.history || []), ...this.state.history].map((record) => [record.id, record]));
    Object.assign(snapshot,JSON.parse(JSON.stringify({history:[...history.values()],sync:{ ...(remote.snapshot?.sync || {}), mappings: this.state.mappings, favorites: this.state.favorites, removedFavorites: this.state.removedFavorites, settingsUpdatedAt: this.state.settingsUpdatedAt }})));
    const updatedAt = nowIso();
    const { data, error: updateError } = await this._query(this.client.from('user_library_snapshots').update({ snapshot, revision: Number(remote.revision) + 1, updated_at: updatedAt }).eq('user_id', userId).eq('revision', remote.revision).select('revision,updated_at').maybeSingle(),context);
    if(!this._current(context))return;
    if (updateError) throw updateError;
    if (!data) { this.state.libraryRevision = 0; this._saveState(); this._scheduleSync(1000); return; }
    this.state.libraryRevision = Number(data.revision);
    const pending=!this.store.matchesToken(token) || stateRevision!==this._stateRevision;
    if (library !== base) {
      if(pending){const current=this.store.snapshot();library=Organization.rebase(base,current,Links.rebaseDecisions(base,current,Identity.rebase(base,current,library)),library);}
      const deviceSettings = Object.fromEntries(DEVICE_SETTINGS.map((key) => [key, this.store.data.settings[key]]));
      this.suppressLibrarySync = true;
      try { this.store.applyCloudData({ ...library, settings: { ...library.settings, ...deviceSettings } }, data.updated_at,{pending}); } finally { this.suppressLibrarySync = false; }
    } else if(pending) {
      this.store.data.cloudDirty=true;
      this.store.save(true,true,{cloud:true,emit:false});
    } else this.store.markCloudSynced(data.updated_at,token);
    if(pending)this._scheduleSync(1000);
    this._saveState();
  }

  async _resolveCatalog(context) {
    const series = this.store.data.series.filter((item) => item.anilistId != null);
    const ids = [...new Set(series.flatMap((item) => [String(item.anilistId), `anilist:${item.anilistId}`]))];
    const { data: animeRows, error: animeError } = await this._query(this.client.from('anime').select('id,external_id').in('external_id', ids),context);
    if(context && !this._current(context))return;
    if (animeError) throw animeError;
    const localAnime = new Map();
    for (const row of animeRows || []) {
      const id = String(row.external_id).replace(/^anilist:/, '');
      if (!localAnime.has(id)) localAnime.set(id, row.id);
    }
    const remoteAnimeIds = [...new Set(localAnime.values())];
    if (!remoteAnimeIds.length) {
      this.pendingCatalogMatches = series.reduce((count, item) => count + Math.max(1, item.episodes.length), 0);
      return { episodes: new Map(), anime: new Map() };
    }
    const { data: episodeRows, error: episodeError } = await this._query(this.client.from('episodes').select('id,anime_id,episode_number,season_number').in('anime_id', remoteAnimeIds),context);
    if(context && !this._current(context))return;
    if (episodeError) throw episodeError;
    const remoteEpisodes = new Map();
    for (const row of episodeRows || []) remoteEpisodes.set(`${row.anime_id}:${row.season_number}:${row.episode_number}`, row.id);
    const episodeMap = new Map();
    let unmatchedEpisodes = 0;
    for (const item of series) {
      const animeId = localAnime.get(String(item.anilistId));
      if (!animeId) { unmatchedEpisodes += Math.max(1, item.episodes.length); continue; }
      this.state.mappings[item.id] = { animeId };
      const season = detectSeasonFromTitle(item.title) || 1;
      for (const episode of item.episodes) {
        const remoteId = remoteEpisodes.get(`${animeId}:${season}:${episode.number}`);
        if (!remoteId) { unmatchedEpisodes++; continue; }
        const localKey = `${item.id}:${episode.id}`;
        this.state.mappings[item.id].episodes ||= {};
        this.state.mappings[item.id].episodes[episode.id] = remoteId;
        episodeMap.set(localKey, remoteId);
      }
    }
    const animeMap = new Map();
    for (const item of series) {
      const animeId = localAnime.get(String(item.anilistId));
      if (animeId) animeMap.set(item.id, animeId);
    }
    // The optional numbered catalogue cannot represent independent cuts/units
    // targeting the same row. Keep their progress in the private UUID snapshot.
    const targets=new Map();for(const remoteId of episodeMap.values())targets.set(remoteId,(targets.get(remoteId)||0)+1);
    for(const [localKey,remoteId] of episodeMap)if(targets.get(remoteId)>1) {
      episodeMap.delete(localKey);unmatchedEpisodes++;
      const [seriesId,episodeId]=localKey.split(':');
      delete this.state.mappings[seriesId]?.episodes?.[episodeId];
    }
    this.pendingCatalogMatches = unmatchedEpisodes;
    return { episodes: episodeMap, anime: animeMap };
  }

  async _syncProgress(userId, catalog,context) {
    const token=this.store.versionToken();
    const pendingLocal=Boolean(this.store.data.cloudDirty);
    const { data: remoteRows, error } = await this._query(this.client.from('user_progress').select('episode_id,position_seconds,completed,updated_at').eq('user_id', userId),context);
    if(context && !this._current(context))return;
    if (error) throw error;
    const remoteByEpisode = new Map((remoteRows || []).map((row) => [row.episode_id, row]));
    const localByRemote = new Map([...catalog.episodes].map(([local, remote]) => [remote, local]));
    for (const row of !pendingLocal && this.store.matchesToken(token)?remoteRows || []:[]) {
      const local = localByRemote.get(row.episode_id);
      if (!local) continue;
      const [seriesId, episodeId] = local.split(':');
      const episode = this.store.getEpisode(seriesId, episodeId);
      if (episode && (Date.parse(row.updated_at) || 0) > (episode.progress.updatedAt || 0)) this.store.applySyncedProgress(seriesId, episodeId, row);
    }
    const pending = [];
    for (const series of this.store.data.series) for (const episode of series.episodes) {
      const remoteId = catalog.episodes.get(`${series.id}:${episode.id}`);
      const progress = episode.progress || {};
      if (!remoteId || !progress.updatedAt) continue;
      const remote = remoteByEpisode.get(remoteId);
      if (remote && (Date.parse(remote.updated_at) || 0) >= progress.updatedAt) continue;
      pending.push({ user_id: userId, episode_id: remoteId, position_seconds: Math.max(0, progress.pos || 0), completed: Boolean(progress.watched), updated_at: nowIso(progress.updatedAt) });
    }
    if (pending.length) {
      const { error: upsertError } = await this._query(this.client.from('user_progress').upsert(pending, { onConflict: 'user_id,episode_id' }),context);
      if(context && !this._current(context))return;
      if (upsertError) throw upsertError;
    }
  }

  async _syncHistory(userId, catalog,context) {
    const reverseMap = new Map([...catalog.episodes].map(([local, remote]) => [remote, local]));
    const { data: remoteRows, error: selectError } = await this._query(this.client.from('watch_history').select('id,episode_id,started_at,finished_at,watched_seconds').eq('user_id', userId),context);
    if(context && !this._current(context))return;
    if (selectError) throw selectError;
    const knownIds = new Set(this.state.history.map((record) => record.id));
    for (const row of remoteRows || []) {
      const local = reverseMap.get(row.episode_id);
      if (!local || knownIds.has(row.id)) continue;
      const [seriesId, episodeId] = local.split(':');
      this.state.history.push({ id: row.id, seriesId, episodeId, startedAt: row.started_at, finishedAt: row.finished_at, watchedSeconds: Number(row.watched_seconds) || 0, synced: true });
      knownIds.add(row.id);
    }
    const pending = [];
    for (const record of this.state.history) {
      if (record.synced) continue;
      const episodeId = catalog.episodes.get(`${record.seriesId}:${record.episodeId}`);
      if (episodeId) pending.push({ id: record.id, user_id: userId, episode_id: episodeId, started_at: record.startedAt, finished_at: record.finishedAt, watched_seconds: record.watchedSeconds });
    }
    if (!pending.length) return;
    const { error } = await this._query(this.client.from('watch_history').upsert(pending, { onConflict: 'id' }),context);
    if(context && !this._current(context))return;
    if (error) throw error;
    const sent = new Set(pending.map((record) => record.id));
    for (const record of this.state.history) if (sent.has(record.id)) record.synced = true;
  }

  async _syncFavorites(userId, catalog,context) {
    const { data: remoteRows, error } = await this._query(this.client.from('favorites').select('anime_id').eq('user_id', userId),context);
    if(context && !this._current(context))return;
    if (error) throw error;
    const localAnime = new Map([...catalog.anime].map(([local, remote]) => [remote, local]));
    const remoteFavorites = new Set((remoteRows || []).map((row) => row.anime_id));
    for (const row of remoteRows || []) {
      const localId = localAnime.get(row.anime_id);
      if (localId && !this.state.removedFavorites.includes(localId) && !this.state.favorites.includes(localId)) this.state.favorites.push(localId);
    }
    const localFavoriteAnime = new Set(this.state.favorites.map((id) => catalog.anime.get(id)).filter(Boolean));
    const additions = [...localFavoriteAnime].filter((id) => !remoteFavorites.has(id)).map((anime_id) => ({ user_id: userId, anime_id }));
    if (additions.length) {
      const { error: insertError } = await this._query(this.client.from('favorites').insert(additions),context);
      if(context && !this._current(context))return;
      if (insertError) throw insertError;
    }
    const removed = [];
    for (const localId of this.state.removedFavorites) {
      const animeId = catalog.anime.get(localId);
      if (animeId) {
        const { error: deleteError } = await this._query(this.client.from('favorites').delete().eq('user_id', userId).eq('anime_id', animeId),context);
        if(context && !this._current(context))return;
        if (deleteError) throw deleteError;
        removed.push(localId);
      }
    }
    this.state.removedFavorites = this.state.removedFavorites.filter((id) => !removed.includes(id));
  }

  async _syncSettings(userId,context) {
    const token=this.store.versionToken();
    const { data: remote, error } = await this._query(this.client.from('settings').select('settings,updated_at').eq('user_id', userId).maybeSingle(),context);
    if(context && !this._current(context) || !this.store.matchesToken(token))return;
    if (error) throw error;
    const localUpdatedAt = Math.max(this.state.settingsUpdatedAt || 0,this.store.data.settingsUpdatedAt || 0);
    if (remote && (Date.parse(remote.updated_at) || 0) > localUpdatedAt) {
      const patch = Object.fromEntries(CLOUD_SETTINGS.filter((key) => Object.hasOwn(remote.settings || {}, key) && validCloudSetting(key, remote.settings[key])).map((key) => [key, remote.settings[key]]));
      Object.assign(this.store.data.settings, patch);
      this.store.data.settingsUpdatedAt=Date.parse(remote.updated_at) || 0;
      this.store.save();
      this.notify('lib:changed', this.store.snapshot());
      this.state.settingsUpdatedAt = Date.parse(remote.updated_at) || 0;
      return;
    }
    const settings = Object.fromEntries(CLOUD_SETTINGS.filter((key) => Object.hasOwn(this.store.data.settings, key) && validCloudSetting(key, this.store.data.settings[key])).map((key) => [key, this.store.data.settings[key]]));
    const row = { user_id: userId, settings, updated_at: nowIso(localUpdatedAt || Date.now()) };
    const { error: upsertError } = await this._query(this.client.from('settings').upsert(row, { onConflict: 'user_id' }),context);
    if(context && !this._current(context) || !this.store.matchesToken(token))return;
    if (upsertError) throw upsertError;
    if (!localUpdatedAt) this.state.settingsUpdatedAt = Date.now();
  }

  async searchUsers(query) {
    const user=this._requireUser(),context={...this._context(user.id),strict:true};
    const value = String(query || '').trim();
    if (value.length < 2) return [];
    let result;
    if (value.includes('@') && !value.startsWith('@')) {
      const email = value.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return [];
      result = await this._query(this.client.rpc('search_profiles_by_email', { search_email: email }),context);
    } else {
      const nickname = value.replace(/^@+/, '').trim();
      if (nickname.length < 2) return [];
      const escaped = nickname.replace(/[\\%_]/g, (character) => `\\${character}`);
      result = await this._query(this.client.from('profiles').select('id,username,display_name,avatar_url,bio').ilike('username', `%${escaped}%`).limit(20),context);
    }
    const { data, error } = result;
    if (error) throw error;
    return data;
  }

  async sendFriendRequest(receiverId) {
    const user = this._requireUser();
    const context={...this._context(user.id),strict:true};
    const { data, error } = await this._query(this.client.from('friend_requests').insert({ sender_id: user.id, receiver_id: receiverId }).select().single(),context);
    if (error) throw error;
    return data;
  }

  async listFriendRequests() {
    const user = this._requireUser();
    const context={...this._context(user.id),strict:true};
    const { data, error } = await this._query(this.client.from('friend_requests').select('*').or(`sender_id.eq.${user.id},receiver_id.eq.${user.id}`).order('created_at', { ascending: false }),context);
    if (error) throw error;
    return data;
  }

  async respondFriendRequest(requestId, status) {
    const user = this._requireUser();
    const context={...this._context(user.id),strict:true};
    if (!['accepted', 'rejected', 'cancelled'].includes(status)) throw new Error('Stato richiesta non valido.');
    const actorColumn = status === 'cancelled' ? 'sender_id' : 'receiver_id';
    const { data, error } = await this._query(this.client.from('friend_requests')
      .update({ status, responded_at: nowIso() })
      .eq('id', requestId)
      .eq(actorColumn, user.id)
      .select()
      .single(),context);
    if (error) throw error;
    return data;
  }

  async listFriends() {
    const user = this._requireUser();
    const context={...this._context(user.id),strict:true};
    const { data, error } = await this._query(this.client.from('friendships').select('user_id,friend_id,created_at').or(`user_id.eq.${user.id},friend_id.eq.${user.id}`),context);
    if (error) throw error;
    const ids = data.map((row) => row.user_id === user.id ? row.friend_id : row.user_id);
    if (!ids.length) return [];
    const { data: profiles, error: profileError } = await this._query(this.client.from('profiles').select('id,username,display_name,avatar_url,bio').in('id', ids),context);
    if (profileError) throw profileError;
    return profiles;
  }

  async removeFriend(friendId) {
    const user = this._requireUser();
    const context={...this._context(user.id),strict:true};
    const { error } = await this._query(this.client.from('friendships').delete().or(`and(user_id.eq.${user.id},friend_id.eq.${friendId}),and(user_id.eq.${friendId},friend_id.eq.${user.id})`),context);
    if (error) throw error;
  }

  async createWatchRoom({ animeId = null, episodeId = null } = {}) {
    const user = this._requireUser();
    const context={...this._context(user.id),strict:true};
    const { data, error } = await this._query(this.client.from('watch_rooms').insert({ host_id: user.id, anime_id: animeId, episode_id: episodeId, status: 'waiting' }).select().single(),context);
    if (error) throw error;
    const { error: memberError } = await this._query(this.client.from('watch_room_members').upsert({ room_id: data.id, user_id: user.id, role: 'host' }, { onConflict: 'room_id,user_id' }),context);
    if (memberError) throw memberError;
    return data;
  }

  async joinWatchRoom(roomId) {
    const user = this._requireUser();
    const context={...this._context(user.id),strict:true};
    const { data: existing, error: selectError } = await this._query(this.client.from('watch_room_members').select('role,left_at').eq('room_id', roomId).eq('user_id', user.id).maybeSingle(),context);
    if (selectError) throw selectError;
    if (existing && existing.left_at == null) return;
    const { error } = await this._query(this.client.from('watch_room_members').upsert({ room_id: roomId, user_id: user.id, role: existing && existing.role === 'host' ? 'host' : 'member', left_at: null }, { onConflict: 'room_id,user_id' }),context);
    if (error) throw error;
  }

  subscribeWatchRoom(roomId, { onPlayback = () => {}, onPresence = () => {} } = {}) {
    const user = this._requireUser();
    const context={...this._context(user.id),strict:true};
    const client=this.client;
    const channel = client.channel(`watch-room:${roomId}`, { config: { broadcast: { self: false }, presence: { key: user.id } } });
    channel.on('broadcast', { event: 'playback' }, ({ payload }) => {if(this._current(context))onPlayback(payload);});
    channel.on('presence', { event: 'sync' }, () => {if(this._current(context))onPresence(channel.presenceState());});
    channel.subscribe((status) => { if (status === 'SUBSCRIBED' && this._current(context)) channel.track({ userId: user.id, onlineAt: nowIso() }); });
    return {
      sendPlayback: async (type, details = {}) => {
        if(!this._current(context))throw Error('Contesto account scaduto.');
        if (!['PLAY', 'PAUSE', 'SEEK', 'EPISODE_CHANGED'].includes(type)) throw new Error('Evento playback non valido.');
        return channel.send({ type: 'broadcast', event: 'playback', payload: { type, ...details, sentAt: nowIso() } });
      },
      unsubscribe: () => client.removeChannel(channel),
    };
  }
}

module.exports = { CloudService, PROJECT_REF, CLOUD_SETTINGS, readConfig, createSessionStorage, mergeLibrarySnapshots, compressLibraryForCloud, expandLibraryFromCloud };
