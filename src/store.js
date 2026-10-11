// Libreria su file JSON, scrittura atomica con debounce.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { hostLabel, isValidSource } = require('./patterns');
const { sourceMetadata, redact, urlLifetime } = require('./source-state');
const Language = require('./source-language');
const { legacyFranchiseRepairs } = require('./franchise');
const Franchise = require('./franchise-model');
const Parts = require('./content-parts');
const Identity = require('./content-identity');
const Links = require('./franchise-links');
const Organization = require('./organization');
const Descriptions=require('./descriptions');

const DEFAULT_SETTINGS = {
  mpvPath: '',
  mpvInstallDirectory: '',
  defaultPreset: 'aa-hq',
  theme: 'default',
  language: 'en',
  descriptionMode:'original',
  onboardingComplete: false,
  autoplayNext: true,
  alang: 'jpn,ja,eng,en',
  slang: 'ita,it,eng,en',
  userAgent: '',
  extraArgs: '',
  skipOpening: false,
  skipEnding: false,
  shortcuts: { ...require('./playback-shortcuts').DEFAULTS },
};

const nonNegativeSeconds = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const personalRating = (value) => {
  if (value === null || value === '' || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : null;
};

const uid = () => crypto.randomUUID();

function validateLibraryData(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Il file non contiene una libreria valida.');
  if (!Array.isArray(input.series)) throw new Error('La libreria importata non contiene un elenco di serie.');
  if (input.settings != null && (typeof input.settings !== 'object' || Array.isArray(input.settings))) {
    throw new Error('Le impostazioni della libreria importata non sono valide.');
  }

  const ids = new Set();
  const series = input.series.map((rawSeries) => {
    if (!rawSeries || typeof rawSeries !== 'object' || typeof rawSeries.id !== 'string' || !rawSeries.id || typeof rawSeries.title !== 'string' || !Array.isArray(rawSeries.episodes)) {
      throw new Error('Una serie importata non ha una struttura valida.');
    }
    if (ids.has(rawSeries.id)) throw new Error(`Serie duplicata nella libreria importata: ${rawSeries.id}`);
    ids.add(rawSeries.id);

    const episodeIds = new Set();
    if (rawSeries.mediaParts != null && !Array.isArray(rawSeries.mediaParts)) throw new Error('Parti del contenuto non valide.');
    const units = [...rawSeries.episodes.map(e=>({...e,_part:false})), ...(rawSeries.mediaParts || []).map(e=>({...e,_part:true}))].map((rawEpisode) => {
      if (!rawEpisode || typeof rawEpisode !== 'object' || typeof rawEpisode.id !== 'string' || !rawEpisode.id || !Number.isInteger(rawEpisode.number) || rawEpisode.number < 0 || !Array.isArray(rawEpisode.sources)) {
        throw new Error(`Episodio non valido nella serie "${rawSeries.title}".`);
      }
      if (episodeIds.has(rawEpisode.id)) throw new Error(`Episodio duplicato nella serie "${rawSeries.title}".`);
      episodeIds.add(rawEpisode.id);
      const sources = rawEpisode.sources.map((source) => {
        if (!source || typeof source.url !== 'string' || !isValidSource(source.url)) {
          throw new Error(`Link non valido nella serie "${rawSeries.title}", episodio ${rawEpisode.number}.`);
        }
        return {
          id: Identity.sourceId(rawEpisode.id,source),
          url: source.url,
          label: typeof source.label === 'string' && source.label ? source.label : hostLabel(source.url),
          ...(['animeunity', 'animeworld'].includes(source.provider) ? { provider: source.provider } : {}),
          ...(typeof source.referer === 'string' && /^https?:\/\//i.test(source.referer) ? { referer: source.referer } : {}),
          ...(typeof source.userAgent === 'string' && source.userAgent.length <= 300 ? { userAgent: source.userAgent } : {}),
          ...(['found','resolved'].includes(source.resolutionState) ? {resolutionState:source.resolutionState} : {}),
          ...(Number(source.playbackVerifiedAt)>0 ? {playbackVerifiedAt:Number(source.playbackVerifiedAt)} : {}),
          ...sourceMetadata(source),
        };
      });
      const p = rawEpisode.progress || {};
      if (typeof p.watched !== 'boolean' || !Number.isFinite(Number(p.pos || 0)) || !Number.isFinite(Number(p.duration || 0)) || !Number.isFinite(Number(p.updatedAt || 0))) {
        throw new Error(`Progresso non valido nella serie "${rawSeries.title}", episodio ${rawEpisode.number}.`);
      }
      const {_part,...fields} = rawEpisode;
      return {
        ...fields, ...(_part ? {kind:'part'} : {}),
        updatedAt: Math.max(0, Number(rawEpisode.updatedAt) || Number(p.updatedAt) || Number(rawSeries.updatedAt) || Number(rawSeries.addedAt) || 0),
        title: typeof rawEpisode.title === 'string' ? rawEpisode.title : '',
        thumb: rawEpisode.thumb || null,
        duration: Math.max(0, Number(rawEpisode.duration || 0)),
        personalRating: personalRating(rawEpisode.personalRating),
        skipTimes: Array.isArray(rawEpisode.skipTimes) ? rawEpisode.skipTimes : [],
        sources,
        progress: {
          pos: Math.max(0, Number(p.pos || 0)),
          duration: Math.max(0, Number(p.duration || 0)),
          watched: p.watched,
          updatedAt: Number(p.updatedAt || 0),
        },
      };
    });
    const movieSources = Array.isArray(rawSeries.movieSources) ? rawSeries.movieSources.map((source) => {
      if (!source || typeof source.url !== 'string' || !isValidSource(source.url)) throw new Error(`Link film non valido nella serie "${rawSeries.title}".`);
      return {...source, url: source.url, label: typeof source.label === 'string' && source.label ? source.label : hostLabel(source.url), ...sourceMetadata(source), ...(typeof source.referer === 'string' && /^https?:\/\//i.test(source.referer) ? { referer: source.referer } : {}) };
    }) : [];
    const lastWatchedAt = Number(rawSeries.lastWatchedAt || 0);
    if (!Number.isFinite(lastWatchedAt)) throw new Error(`Data di visione non valida nella serie "${rawSeries.title}".`);
    return {
      ...rawSeries,
      ...Descriptions.descriptionFields(rawSeries),
      videoPreference: Language.preference(rawSeries.videoPreference),
      sourcePatternLanguage: Language.classification(rawSeries.sourcePatternLanguage),
      title: rawSeries.title.trim() || 'Senza titolo',
      updatedAt: Math.max(0, Number(rawSeries.updatedAt) || Number(rawSeries.addedAt) || 0),
      episodes:units.filter(e=>e.kind !== 'part'),
      ...(rawSeries.mediaParts ? {mediaParts:units.filter(e=>e.kind === 'part')} : {}),
      cover: rawSeries.cover || rawSeries.coverImage?.extraLarge || rawSeries.coverImage?.large || rawSeries.coverImage?.medium || rawSeries.poster || null,
      movieSources,
      introDuration: nonNegativeSeconds(rawSeries.introDuration),
      outroDuration: nonNegativeSeconds(rawSeries.outroDuration),
      personalRating: personalRating(rawSeries.personalRating),
      genres: Array.isArray(rawSeries.genres) ? rawSeries.genres : [],
      cast: Array.isArray(rawSeries.cast) ? rawSeries.cast : [],
      related: Array.isArray(rawSeries.related) ? rawSeries.related : [],
      lastWatchedAt,
    };
  });
  const settings = { ...DEFAULT_SETTINGS, ...(input.settings || {}) };
  if (input.settings && input.settings.language == null) settings.language = 'it';
  if (!['en', 'it'].includes(settings.language)) settings.language = DEFAULT_SETTINGS.language;
  if (!['translated','original'].includes(settings.descriptionMode))settings.descriptionMode=DEFAULT_SETTINGS.descriptionMode;
  if (!['default', 'compact'].includes(settings.theme)) settings.theme = DEFAULT_SETTINGS.theme;
  if (!settings.defaultPreset || settings.defaultPreset === 'a-fast') settings.defaultPreset = DEFAULT_SETTINGS.defaultPreset;
  if (!input.settings || input.settings.onboardingComplete == null) {
    try { settings.onboardingComplete = Boolean(settings.mpvPath && fs.statSync(settings.mpvPath).isFile()); } catch { /* onboarding richiesto */ }
  }
  const deletedSeries = Array.isArray(input.deletedSeries) ? input.deletedSeries.filter((item) => item && typeof item.id === 'string' && Number.isFinite(Number(item.deletedAt))).map((item) => ({ id: item.id, deletedAt: Number(item.deletedAt) })) : [];
  const deletedEpisodes = Array.isArray(input.deletedEpisodes) ? input.deletedEpisodes.filter((item) => item && typeof item.seriesId === 'string' && typeof item.id === 'string' && Number.isFinite(Number(item.deletedAt))).map((item) => ({ ...item, seriesId: item.seriesId, id: item.id, deletedAt: Number(item.deletedAt) })) : [];
  const franchises = Array.isArray(input.franchises) ? input.franchises.map(group => {
    if (!group || typeof group.id !== 'string' || !group.id || typeof group.title !== 'string') throw new Error('Franchise non valido.');
    return {...group,custom:group.custom || {},suggestions:Array.isArray(group.suggestions)?group.suggestions:[],updatedAt:Math.max(0,Number(group.updatedAt)||0)};
  }) : [];
  if (new Set(franchises.map(g=>g.id)).size !== franchises.length) throw new Error('Franchise duplicato.');
  const deletedFranchises = (Array.isArray(input.deletedFranchises)?input.deletedFranchises:[]).filter(g=>typeof g?.id === 'string' && Number(g.deletedAt)>0);
  for (const record of series) if (record.franchiseMembership && !Franchise.membership(record.franchiseMembership)) throw new Error('Appartenenza al franchise non valida.');
  return { settings, settingsUpdatedAt:Math.max(0,Number(input.settingsUpdatedAt)||0), organization:Organization.validate(input.organization), series, franchises, franchiseLinks:Links.validateLinks(input.franchiseLinks), deletedFranchises, deletedSeries, deletedEpisodes, updatedAt: Math.max(0, Number(input.updatedAt) || 0), cloudDirty: Boolean(input.cloudDirty) };
}

class Store extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.data = { settings: { ...DEFAULT_SETTINGS }, series: [], deletedSeries: [], deletedEpisodes: [], updatedAt: 0, cloudDirty: false };
    this._timer = null;
    this.revision = 0;
    this.scope = 0;
    this._migrationBackups = new Set();
    this.load();
  }

  load() {
    let linkError,organizationError;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      try{this.data.organization=Organization.validate(raw.organization);}catch(error){organizationError=error;throw error;}
      if(!Object.hasOwn(raw,'organization'))this._pendingMigrationBackup=true;
      if(!Object.hasOwn(raw,'settingsUpdatedAt'))this._pendingMigrationBackup=true;
      if(!Object.hasOwn(raw.settings||{},'descriptionMode'))this._pendingMigrationBackup=true;
      this.data.series = Array.isArray(raw.series) ? raw.series : [];
      this.data.franchises = raw.franchises || [];
      try{this.data.franchiseLinks = Links.validateLinks(raw.franchiseLinks);}catch(error){linkError=error;throw error;}
      if(!Object.hasOwn(raw,'franchiseLinks'))this._pendingMigrationBackup=true;
      this.data.deletedFranchises = raw.deletedFranchises || [];
      this.data.deletedSeries = Array.isArray(raw.deletedSeries) ? raw.deletedSeries : [];
      this.data.deletedEpisodes = Array.isArray(raw.deletedEpisodes) ? raw.deletedEpisodes : [];
      this.data.updatedAt = Math.max(0, Number(raw.updatedAt) || 0);
      this.data.settingsUpdatedAt = Math.max(0,Number(raw.settingsUpdatedAt)||0);
      this.data.cloudDirty = raw.cloudDirty == null ? this.data.series.length > 0 : Boolean(raw.cloudDirty);
      this.data.series.forEach((s) => {
        s.videoPreference = Language.preference(s.videoPreference);
        s.cover ||= s.coverImage?.extraLarge || s.coverImage?.large || s.coverImage?.medium || s.poster || null;
        s.updatedAt = Math.max(0, Number(s.updatedAt) || Number(s.addedAt) || 0);
        s.introDuration = nonNegativeSeconds(s.introDuration);
        s.outroDuration = nonNegativeSeconds(s.outroDuration);
        for (const episode of s.episodes || []) episode.updatedAt = Math.max(0, Number(episode.updatedAt) || Number(episode.progress && episode.progress.updatedAt) || s.updatedAt || 0);
        if (s.imdbChart) require('./episode-ratings').apply(s,s.imdbChart);
      });
      this.data.settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
      if (!['default', 'compact'].includes(this.data.settings.theme)) this.data.settings.theme = DEFAULT_SETTINGS.theme;
      if (raw.settings && raw.settings.language == null) this.data.settings.language = 'it';
      if (!['en', 'it'].includes(this.data.settings.language)) this.data.settings.language = DEFAULT_SETTINGS.language;
      if (!['translated','original'].includes(this.data.settings.descriptionMode))this.data.settings.descriptionMode=DEFAULT_SETTINGS.descriptionMode;
      if (!this.data.settings.defaultPreset || this.data.settings.defaultPreset === 'a-fast') this.data.settings.defaultPreset = DEFAULT_SETTINGS.defaultPreset;
      // Librerie create prima dell'onboarding: se erano già configurate,
      // non devono essere bloccate dalla nuova procedura di primo avvio.
      if (!raw.settings || raw.settings.onboardingComplete == null) {
        let configured = false;
        try { configured = this.data.series.length > 0 && fs.statSync(this.data.settings.mpvPath).isFile(); } catch { /* onboarding richiesto */ }
        this.data.settings.onboardingComplete = Boolean(configured);
      }
    } catch { /* primo avvio o file rovinato: si parte da zero */ }
    if(linkError)throw new Error(`Collegamenti franchise non validi; libreria non modificata: ${linkError.message}`);
    if(organizationError)throw new Error(`Organizzazione non valida; libreria non modificata: ${organizationError.message}`);
    this.data.organization ||= Organization.empty();
    const repaired = this.repairFranchiseGroups();
    this.migrateFranchises();
    if (repaired) this.save();
  }

  migrateFranchises() {
    this.data.franchiseLinks ||= [];
    const before=JSON.stringify(this.data.series);
    Franchise.migrate(this.data);
    for (const series of this.data.series) if (Franchise.singleWork(series) || series.mediaParts || series.movieSources?.length) this.migrateParts(series);
    Identity.ensureSourceIds(this.data);
    if(JSON.stringify(this.data.series)!==before)this._pendingMigrationBackup=true;
  }

  migrateParts(series) {
    const before=JSON.stringify([series.episodes,series.mediaParts,series.movieSourcesMigrated]);
    Parts.migrateParts(series);
    if(JSON.stringify([series.episodes,series.mediaParts,series.movieSourcesMigrated])!==before)this._pendingMigrationBackup=true;
  }

  backup(reason='pre-integrity',file=this.file) {
    if(!fs.existsSync(file))return null;
    const target=`${file}.${reason}-${Date.now()}-${uid()}.bak`;
    fs.copyFileSync(file,target,fs.constants.COPYFILE_EXCL);
    return target;
  }

  versionToken() { return {revision:this.revision,scope:this.scope,file:path.resolve(this.file)}; }
  matchesToken(token) { return token && token.revision===this.revision && token.scope===this.scope && token.file===path.resolve(this.file); }

  repairFranchiseGroups() {
    const repairs = legacyFranchiseRepairs(this.data.series);
    const now = Date.now();
    for (const { record, patch } of repairs) {
      Object.assign(record, patch);
      record.updatedAt = Math.max(now, (Number(record.updatedAt) || 0) + 1);
      if (record.franchiseMembership) record.franchiseMembership = {franchiseId:patch.franchiseId,category:patch.franchiseType || Franchise.category(record),
        order:patch.franchiseOrder || 0,manual:false,updatedAt:record.updatedAt};
    }
    if (repairs.length) this.data.franchises = (this.data.franchises || []).filter(g=>this.data.series.some(s=>s.franchiseId === g.id));
    return repairs.length > 0;
  }

  save(now = false, throwOnError = false, { cloud = false, emit = true } = {}) {
    if(this._transactionDepth)return true;
    clearTimeout(this._timer);
    this._timer=null;
    this.data.updatedAt = cloud ? Math.max(this.data.updatedAt || 0, Date.now()) : Date.now();
    if (!cloud) {this.data.cloudDirty = true;this.revision++;}
    const write = () => {
      this._timer=null;
      try {
        if(this._pendingMigrationBackup && !this._migrationBackups.has(path.resolve(this.file))) {
          if(this.backup())this._migrationBackups.add(path.resolve(this.file));
        }
        this._pendingMigrationBackup=false;
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
        fs.renameSync(tmp, this.file);
        if (emit) this.emit('changed', { updatedAt: this.data.updatedAt, cloudDirty: this.data.cloudDirty });
        return true;
      } catch (e) {
        console.error('Salvataggio libreria fallito:', e.message);
        if (throwOnError) throw new Error(`Impossibile salvare la libreria: ${e.message}`);
        return false;
      }
    };
    if (now) return write();
    this._timer = setTimeout(write, 400);
    return true;
  }

  snapshot() { return JSON.parse(JSON.stringify(this.data)); }
  // No asynchronous work is allowed in this atomic local commit. All metadata
  // is prepared first; failed backup/write restores both data and revision.
  transaction(fn) {
    if(this._transactionDepth)throw new Error('Transazione già in corso.');
    const previous=this.snapshot(),revision=this.revision,backupPending=this._pendingMigrationBackup,hadPending=this._timer!=null;
    clearTimeout(this._timer);this._transactionDepth=1;
    try {const result=fn();if(result?.then)throw new Error('Transazione asincrona non consentita.');
      this._transactionDepth=0;this.save(true,true,{emit:false});
      try{this.emit('changed',{updatedAt:this.data.updatedAt,cloudDirty:this.data.cloudDirty});}catch(error){console.error('Notifica libreria fallita:',error.message);}
      return result;
    } catch(error){this._transactionDepth=0;this.data=previous;this.revision=revision;this._pendingMigrationBackup=backupPending;
      // Preserve any earlier debounced edits after a failed transaction.
      if(hadPending){const originalTime=previous.updatedAt;this.save(false,false,{cloud:true,emit:false});this.data.updatedAt=originalTime;}
      throw error;}
  }
  recordFranchiseLink(link) {
    const checked=Links.validateLinks([link])[0];
    const old=(this.data.franchiseLinks || []).find(l=>l.id===checked.id);
    if(checked.origin==='automatic'){
      const combined=Links.mergeLinks(old?[old]:[],[checked])[0];
      const candidate={...combined,...checked,evidence:combined.evidence,...(old?.decision?{decision:old.decision}:{}),updatedAt:old?.updatedAt || 0};
      if(JSON.stringify(candidate)!==JSON.stringify(old))candidate.updatedAt=Math.max(Date.now(),(old?.updatedAt || 0)+1);
      Object.assign(checked,candidate);
    }
    const next=Links.mergeLinks(this.data.franchiseLinks || [],[checked]);
    if(JSON.stringify(next)!==JSON.stringify(this.data.franchiseLinks || [])) {
      this.data.franchiseLinks=next;this.save();
    }
    return this.data.franchiseLinks.find(l=>l.id===link.id);
  }
  decideFranchiseLink(id,patch) {
    const link=(this.data.franchiseLinks || []).find(l=>l.id===id);if(!link)throw new Error('Collegamento non trovato.');
    const state=patch.state || link.decision?.state || 'confirmed',type=patch.type || link.decision?.type || link.type;
    if(!Franchise.LINK_STATES.includes(state) || !Franchise.LINK_TYPES.includes(type))throw new Error('Tipo o stato non valido.');
    const directions=patch.directions || (patch.type && type!=='crossover' ? Object.fromEntries(link.endpoints.map(e=>[e.key,'related'])) : link.decision?.directions || link.directions);
    if(directions && (typeof directions!=='object' || Object.keys(directions).some(key=>!link.endpoints.some(e=>e.key===key)) || Object.values(directions).some(v=>!['related','crossover_work','source_work'].includes(v))))throw new Error('Direzione non valida.');
    link.decision={state,type,origin:'manual',updatedAt:Math.max(Date.now(),(link.decision?.updatedAt || 0)+1),...(directions?{directions}:{})};
    link.updatedAt=Math.max(link.updatedAt || 0,link.decision.updatedAt);this.save();return link;
  }
  importData(input) {
    const next = validateLibraryData(input);
    this.backup('pre-import');
    for (const series of next.series) series.videoPreference ||= Language.preference(this.getSeries(series.id)?.videoPreference);
    const previous = this.data;
    this.data = next;
    this.repairFranchiseGroups();
    this.migrateFranchises();
    try { this.save(true, true); } catch (e) { this.data = previous; throw e; }
    this.emit('settings:applied');
    return this.snapshot();
  }

  applyCloudData(input, updatedAt, {expected, pending=false} = {}) {
    if(expected && !this.matchesToken(expected))return false;
    const next = validateLibraryData(input);
    const deleted=new Set(next.deletedSeries.map(s=>s.id));
    const deletedUnits=new Set(next.deletedEpisodes.map(e=>`${e.seriesId}:${e.id}`));
    next.series=next.series.filter(s=>!deleted.has(s.id));
    for(const s of next.series) {
      s.episodes=s.episodes.filter(e=>!deletedUnits.has(`${s.id}:${e.id}`));
      if(s.mediaParts)s.mediaParts=s.mediaParts.filter(e=>!deletedUnits.has(`${s.id}:${e.id}`));
    }
    for (const series of next.series) series.videoPreference ||= Language.preference(this.getSeries(series.id)?.videoPreference);
    const previous = this.data;
    next.updatedAt = Math.max(0, Date.parse(updatedAt) || Number(input.updatedAt) || 0);
    next.cloudDirty = pending;
    this.data = next;
    const repaired = this.repairFranchiseGroups();
    this.migrateFranchises();
    try { this.save(true, true, { cloud: !repaired, emit: false });this.revision++; } catch (error) { this.data = previous; throw error; }
    this.emit('settings:applied');
    return this.snapshot();
  }

  markCloudSynced(updatedAt, expected) {
    if(expected && !this.matchesToken(expected))return false;
    this.data.cloudDirty = false;
    this.data.updatedAt = Math.max(this.data.updatedAt || 0, Date.parse(updatedAt) || Date.now());
    this.save(true, true, { cloud: true, emit: false });
    return true;
  }

  switchFile(file) {
    if (path.resolve(file) === path.resolve(this.file)) return;
    this.save(true, true);
    const deviceSettings = { mpvPath: this.data.settings.mpvPath || '', onboardingComplete: Boolean(this.data.settings.onboardingComplete) };
    this.file = file;
    this.scope++;
    this.revision++;
    this._pendingMigrationBackup=false;
    this.data = { settings: { ...DEFAULT_SETTINGS, ...deviceSettings }, series: [], deletedSeries: [], deletedEpisodes: [], updatedAt: 0, cloudDirty: false };
    this.load();
    this.data.settings.mpvPath = deviceSettings.mpvPath || this.data.settings.mpvPath || '';
    if (this.data.settings.mpvPath) this.data.settings.onboardingComplete = deviceSettings.onboardingComplete;
    this.save(true, true, { cloud: true, emit: false });
  }

  writeLibraryFile(file, data) {
    const previousFile = this.file;
    const previousData = this.data;
    const previousBackup = this._pendingMigrationBackup;
    this.file = file;
    this.data = validateLibraryData(data);
    const repaired = this.repairFranchiseGroups();
    this.migrateFranchises();
    try { this.save(true, true, { cloud: !repaired, emit: false }); }
    catch (error) { this.file = previousFile; this.data = previousData;this._pendingMigrationBackup=previousBackup; throw error; }
    this.file = previousFile;
    this.data = previousData;
    this._pendingMigrationBackup=previousBackup;
  }

  getSeries(id) { return this.data.series.find((s) => s.id === id); }
  getEpisode(sid, eid) { return Franchise.units(this.getSeries(sid)).find(e=>e.id === eid); }
  getSource(sid,eid,source) {
    const unit=this.getEpisode(sid,eid);
    const id=typeof source==='string'?source:source && Identity.sourceId(eid,source);
    return unit?.sources.find(s=>Identity.sourceId(eid,s)===id);
  }
  episodeNumberDeleted(sid,number) { return (this.data.deletedEpisodes || []).some(e=>e.seriesId===sid && e.kind!=='part' && e.number===number); }

  setSettings(patch) {
    Object.assign(this.data.settings, patch);
    this.data.settingsUpdatedAt=Math.max(Date.now(),(this.data.settingsUpdatedAt || 0)+1);
    this.save();
    this.emit('settings', { settings: { ...this.data.settings }, updatedAt: this.data.settingsUpdatedAt });
  }

  needsOnboarding() {
    return !this.data.settings.onboardingComplete;
  }

  addSeries(meta = {}) {
    const now = Date.now();
    const s = {
      id: uid(), title: 'Senza titolo', anilistId: null, kitsuId: null, imdbId: null, imdbChart: null, cover: null, banner: null,
      description: '',descriptionLanguage:'unknown',descriptionSource:'unknown',descriptionTranslations:{},genres: [], score: null, scoreSource: null, year: null, format: null, episodeCount: null, status: null,
      nextAiringAt: null, nextEpisode: null, malId: null, personalRating: null,
      preset: null, referer: '', addedAt: now, updatedAt: now, lastWatchedAt: 0, episodes: [], ...meta,
    };
    if (!Array.isArray(s.episodes)) s.episodes = [];
    Object.assign(s,Descriptions.descriptionFields(s));
    s.introDuration = nonNegativeSeconds(s.introDuration);
    s.outroDuration = nonNegativeSeconds(s.outroDuration);
    s.personalRating = personalRating(s.personalRating);
    s.videoPreference = Language.preference(s.videoPreference);
    this.data.series.push(s);
    this.migrateFranchises();
    this.save();
    return s;
  }

  updateSeries(id, patch) {
    const s = this.getSeries(id);
    if (!s) throw new Error('Serie non trovata');
    this._applyDescriptionFields(s,patch);
    const allowed = ['title', 'altTitle', 'titleAliases', 'averageDuration', 'sourceDiscovery', 'preset', 'referer', 'cover', 'banner', 'genres', 'score', 'scoreSource', 'year', 'format', 'episodeCount', 'status', 'nextAiringAt', 'nextEpisode', 'malId', 'kitsuId', 'anilistId', 'imdbId', 'imdbChart', 'imdbSelection', 'introDuration', 'outroDuration', 'personalRating', 'franchiseId', 'franchiseTitle', 'franchiseOrder', 'franchiseType', 'franchiseSeasonNumber', 'movieSources', 'franchiseEvidence', 'franchiseRelations', 'related','relationTags'];
    for (const k of allowed) if (k in patch) s[k] = patch[k];
    if(Object.hasOwn(patch,'personalRating'))s.personalRatingUpdatedAt=Math.max(Date.now(),(s.personalRatingUpdatedAt || 0)+1);
    if (Object.hasOwn(patch,'movieSources')) {delete s.movieSourcesMigrated;this.migrateParts(s);}
    if (Franchise.singleWork(s)) this.migrateParts(s);
    s.updatedAt = Date.now();
    s.introDuration = nonNegativeSeconds(s.introDuration);
    s.outroDuration = nonNegativeSeconds(s.outroDuration);
    s.personalRating = personalRating(s.personalRating);
    this.save();
    return s;
  }

  setVideoPreference(id, mode) {
    if (!Language.MODES.includes(mode)) throw new Error('Versione video non valida');
    const series = this.getSeries(id);
    if (!series) throw new Error('Serie non trovata');
    series.videoPreference = { mode, updatedAt: Math.max(Date.now(), (series.videoPreference?.updatedAt || 0) + 1) };
    series.updatedAt = series.videoPreference.updatedAt;
    this.save();
  }

  getFranchise(id) { return (this.data.franchises || []).find(g=>g.id === String(id)); }
  franchiseMembers(id) { return this.data.series.filter(s=>s.franchiseId === String(id)); }
  ensureFranchise(fields = {}) {
    const id = String(fields.id || `franchise-${uid()}`);
    let group = this.getFranchise(id);
    if (!group) {
      if ((this.data.deletedFranchises || []).some(g=>g.id === id)) throw new Error('Franchise eliminato; ripeti l’aggiunta per creare un nuovo gruppo.');
      group = {id,title:fields.title || 'Franchise',cover:fields.cover || null,banner:fields.banner || null,
        rootAniListId:fields.rootAniListId || null,custom:{},suggestions:[],excludedAniListIds:[],updatedAt:Date.now(),...fields,id};
      this.data.franchises ||= []; this.data.franchises.push(group); this.save();
    }
    return group;
  }
  updateFranchise(id, patch) {
    const group = this.getFranchise(id); if (!group) throw new Error('Franchise non trovato.');
    const now = Math.max(Date.now(),(Number(group.updatedAt)||0)+1);
    for (const field of ['title','cover','banner']) if (Object.hasOwn(patch,field)) {
      const value = field === 'title' ? String(patch[field] || '').trim() : String(patch[field] || '').trim() || null;
      if (field === 'title' && !value) throw new Error('Scrivi un titolo.');
      group[field] = value; group.custom ||= {}; group.custom[field] = {value,updatedAt:now};
    }
    group.updatedAt = now;
    for (const record of this.franchiseMembers(id)) record.franchiseTitle = group.title;
    this.save(); return group;
  }
  setMembership(sid, {franchiseId,category,order,role}, {manual=true}={}) {
    const record = this.getSeries(sid); if (!record) throw new Error('Opera non trovata.');
    if (!manual && record.franchiseMembership?.manual) return record;
    const group = franchiseId != null ? this.getFranchise(franchiseId) : null;
    if (franchiseId != null && !group) throw new Error('Franchise non trovato.');
    if(group && this._deletingFranchises?.has(group.id)) throw new Error('Eliminazione del franchise in corso.');
    if (group && record.anilistId != null && this.franchiseMembers(group.id).some(s=>s.id !== sid && String(s.anilistId) === String(record.anilistId))) {
      throw new Error('La stessa opera AniList è già nel franchise. Conserva il duplicato come scheda separata.');
    }
    const kind = category || Franchise.category(record);
    if (!Franchise.CATEGORIES.includes(kind)) throw new Error('Categoria non valida.');
    if (role != null && !Franchise.ROLES.includes(role)) throw new Error('Relazione non valida.');
    const savedRole=role===null ? undefined : role || record.franchiseMembership?.role;
    const position = order == null && !manual && record.franchiseId===group?.id ? Number(record.franchiseOrder)||0
      : order == null ? Math.max(0,...(group ? this.franchiseMembers(group.id).map(s=>Number(s.franchiseOrder)||0):[]))+1 : Number(order);
    if (!Number.isFinite(position) || position < 0) throw new Error('Ordine non valido.');
    const previous=record.franchiseMembership;
    if(!manual && previous && previous.franchiseId===(group?.id || null) && previous.category===kind && previous.order===position && previous.role===savedRole)return record;
    const updatedAt = Math.max(Date.now(),(Number(record.franchiseMembership?.updatedAt)||0)+1);
    Franchise.mirror(record,{franchiseId:group?.id || null,category:kind,order:position,manual,updatedAt,...(savedRole?{role:savedRole}: {})},group);
    record.updatedAt = Math.max(record.updatedAt||0,updatedAt);
    if (group && record.anilistId != null) group.excludedAniListIds = (group.excludedAniListIds || []).filter(id=>String(id)!==String(record.anilistId));
    this.save(); return record;
  }
  reorderFranchise(id, ids) {
    const members = this.franchiseMembers(id);
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.length !== members.length || ids.some(sid=>!members.some(s=>s.id===sid))) throw new Error('Ordine dei membri non valido.');
    ids.forEach((sid,index)=>this.setMembership(sid,{franchiseId:id,order:index+1}));
  }
  previewFranchiseMerge(sourceId,targetId) {
    const source=this.getFranchise(sourceId),target=this.getFranchise(targetId);
    if (!source || !target || source.id === target.id) throw new Error('Scegli due franchise diversi.');
    const members=this.franchiseMembers(source.id),destination=this.franchiseMembers(target.id);
    const identities=new Map(),duplicates=[];
    for(const record of [...destination,...members]) {
      if(record.anilistId == null)continue;
      const key=String(record.anilistId),canonical=identities.get(key);
      if(canonical)duplicates.push({sourceId:record.id,targetId:canonical.id,anilistId:record.anilistId,title:record.title,scope:destination.includes(record)?'target':'source'});
      else identities.set(key,record);
    }
    return {source,target,members,duplicates};
  }
  mergeFranchises(sourceId,targetId,{duplicatePolicy}={}) {
    const plan=this.previewFranchiseMerge(sourceId,targetId);
    sourceId=plan.source.id;targetId=plan.target.id;
    if (this._deletingFranchises?.has(sourceId) || this._deletingFranchises?.has(targetId)) throw new Error('Eliminazione del franchise in corso.');
    if (plan.duplicates.length && duplicatePolicy !== 'detach') throw new Error('Conferma come conservare i duplicati prima dell’unione.');
    const duplicateIds=new Set(plan.duplicates.map(d=>d.sourceId));
    for(const duplicate of plan.duplicates.filter(d=>d.scope === 'target'))this.setMembership(duplicate.sourceId,{franchiseId:null});
    for (const record of plan.members) this.setMembership(record.id,{franchiseId:duplicateIds.has(record.id)?null:targetId});
    const target=this.getFranchise(targetId);
    target.mergedFranchiseMetadata=[...(target.mergedFranchiseMetadata || []),...(plan.source.mergedFranchiseMetadata || []),
      Object.fromEntries(['id','title','cover','banner','custom','rootAniListId'].map(key=>[key,plan.source[key]]))];
    const present=new Set(this.franchiseMembers(targetId).map(s=>String(s.anilistId)));
    target.excludedAniListIds=[...new Set([...(target.excludedAniListIds||[]),...(plan.source.excludedAniListIds||[])])].filter(id=>!present.has(String(id)));
    target.suggestions=[...new Map([...(target.suggestions||[]),...(plan.source.suggestions||[])].map(s=>[String(s.anilistId),s])).values()]
      .filter(s=>!present.has(String(s.anilistId)) && !target.excludedAniListIds.includes(String(s.anilistId)));
    target.updatedAt=Math.max(Date.now(),(Number(target.updatedAt)||0)+1);
    this.data.franchises=this.data.franchises.filter(g=>g.id !== sourceId);
    this.data.deletedFranchises.push({id:sourceId,deletedAt:Math.max(Date.now(),(plan.source.updatedAt||0)+1)});this.save();
    return plan;
  }
  deleteFranchise(id) {
    const group=this.getFranchise(id); if (!group) throw new Error('Franchise non trovato.');
    const members=this.franchiseMembers(id);
    for (const record of members) this.deleteSeries(record.id);
    this.data.franchises=this.data.franchises.filter(g=>g.id !== id);
    this.data.deletedFranchises.push({id,deletedAt:Math.max(Date.now(),(group.updatedAt||0)+1)});
    this.save();return members.map(s=>s.id);
  }
  ensurePart(series,number=1,title='',key,layout) {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('Numero parte non valido.');
    series.mediaParts ||= [];
    const matches=series.mediaParts.filter(p=>key ? p.key === key : p.number === number);
    if(matches.length>1)throw new Error('Parti ambigue: seleziona l’unità tramite il suo identificatore prima di aggiungere link.');
    let part=matches[0];
    if (!part) {
      const position=series.mediaParts.some(p=>p.number === number)?Math.max(...series.mediaParts.map(p=>p.number))+1:number;
      part=Parts.makePart(position,title,key,layout);series.mediaParts.push(part);
    }
    return part;
  }
  addContentSources(id,sources) { return this.addSources(id,sources.map(s=>({...s,contentPart:true}))); }

  deleteSeries(id) {
    if (!this.data.series.some((s) => s.id === id)) return;
    this.data.deletedSeries ||= [];
    const record=this.getSeries(id),group=this.getFranchise(record?.franchiseId);
    if (group && record.anilistId != null) group.excludedAniListIds=[...new Set([...(group.excludedAniListIds||[]),String(record.anilistId)])];
    this.data.deletedSeries.push({ id, deletedAt: Math.max(Date.now(),(Number(record.updatedAt)||0)+1) });
    this.data.series = this.data.series.filter((s) => s.id !== id);
    this.save();
  }

  ensureEpisode(s, number) {
    if(Franchise.singleWork(s))throw new Error('Un’opera singola richiede una parte, non un episodio TV.');
    let ep = s.episodes.find((e) => e.number === number);
    if (!ep) {
      if(this.episodeNumberDeleted(s.id,number))throw new Error('Episodio eliminato: ripristino esplicito richiesto.');
      ep = { id: uid(), number, title: '', thumb: null, duration: 0, rating: null, ratingSource: null, personalRating: null, skipTimes: [], sources: [], updatedAt: Date.now(), progress: { pos: 0, duration: 0, watched: false, updatedAt: 0 } };
      s.episodes.push(ep);
      s.episodes.sort((a, b) => a.number - b.number);
    }
    return ep;
  }

  // items: [{number, url, title?}] — aggiunge la sorgente (senza duplicati)
  addSources(sid, items) {
    const s = this.getSeries(sid);
    if (!s) throw new Error('Serie non trovata');
    let added = 0;
    for (const it of items) {
      const ep = it.contentPart || Franchise.singleWork(s) ? this.ensurePart(s,Math.max(1,it.number),it.title,
        it.contentPartKey || (it.number<=1?'single':`manual:${it.number}`),it.contentLayout || (it.number<=1?'single':'manual')) : this.ensureEpisode(s, it.number);
      if (it.title && !ep.title) ep.title = it.title;
      const identity = Language.sourceIdentity({...it, ...sourceMetadata(it)});
      const existing = ep.sources.find(source => source.url === it.url || identity && Language.sourceIdentity(source) === identity);
      if (existing) {
        if (existing.url !== it.url) {
          this.refreshSource(sid, ep.id, existing, it);
          added++;
        } else if (existing.language?.origin !== 'manual') Object.assign(existing, Language.metadata(it));
      } else {
        const descriptor=identity && ep.automaticSources?.find(source=>Language.sourceIdentity(source)===identity);
        ep.sources.push({ url: it.url, label: hostLabel(it.url), ...(['animeunity', 'animeworld'].includes(it.provider) ? { provider: it.provider } : {}), ...(it.referer ? { referer: it.referer } : {}), ...(it.userAgent ? { userAgent: it.userAgent } : {}), ...(['found','resolved'].includes(it.resolutionState) ? {resolutionState:it.resolutionState} : {}) });
        Object.assign(ep.sources.at(-1), sourceMetadata(it));
        ep.sources.at(-1).id=descriptor?.id || Identity.sourceId(ep.id,it);
        if(descriptor?.referer)ep.sources.at(-1).referer=descriptor.referer;
        if(descriptor?.userAgent)ep.sources.at(-1).userAgent=descriptor.userAgent;
        ep.updatedAt = Date.now(); added++;
      }
      const priority = (source) => source.provider === 'animeunity' ? 0 : source.provider === 'animeworld' ? 1 : 2;
      ep.sources = ep.sources.map((source, index) => ({ source, index })).sort((a, b) => priority(a.source) - priority(b.source) || a.index - b.index).map(({ source }) => source);
    }
    if (added) s.updatedAt = Date.now();
    this.save();
    return added;
  }

  setSources(sid, eid, urls) {
    const ep = this.getEpisode(sid, eid);
    if (!ep) throw new Error('Episodio non trovato');
    ep.sources = [...new Set(urls)].map(url => ep.sources.find(source => source.url === url) || { id:Identity.sourceId(eid,{url}), url, label: hostLabel(url) });
    ep.automaticSources=(ep.automaticSources || []).filter(d=>ep.sources.some(s=>s.id===d.id));
    ep.updatedAt = Date.now();
    const series = this.getSeries(sid); if (series) series.updatedAt = ep.updatedAt;
    this.save();
  }

  markSourcePlayback(sid, eid, url) {
    const ep=this.getEpisode(sid,eid);
    const source=ep?.sources.find(item=>item.url===url);
    if(!source) return;
    delete source.playbackFailedAt; delete source.playbackError; delete source.playbackExitCode;
    source.playbackVerifiedAt=Date.now();ep.updatedAt=source.playbackVerifiedAt;
    this.save();
  }

  setSourceLanguage(sid, eid, url, mode) {
    if (!['unknown', 'it', 'ja-sub-it'].includes(mode)) throw new Error('Lingua non valida');
    const ep = this.getEpisode(sid, eid); const source = ep?.sources.find(item => item.url === url);
    if (!source || source.provider) throw new Error('Classificazione manuale consentita soltanto per link manuali');
    const language = Language.manualClassification(mode);
    if (language) source.language = language; else delete source.language;
    ep.updatedAt = Date.now(); this.save();
  }

  recordSourceTracks(sid, eid, source, list) {
    const ep = this.getEpisode(sid, eid);
    source=this.getSource(sid,eid,source);
    if (!source) return;
    source.mediaTracks = Language.observedTracks(list);
    ep.updatedAt = Date.now(); this.save();
  }

  refreshSource(sid, eid, source, fresh) {
    const ep = this.getEpisode(sid, eid);
    source=this.getSource(sid,eid,source);
    if (!source || !['animeunity', 'animeworld'].includes(source.provider) || source.provider !== fresh.provider) return false;
    const replaceReferer = !source.referer || source.referer === source.resolverReferer || !source.resolverReferer && urlLifetime(source.referer).temporary;
    const metadata = sourceMetadata(fresh);
    if (source.url !== fresh.url) { delete source.mediaTracks; delete metadata.mediaTracks; }
    source.url = fresh.url; source.label = hostLabel(fresh.url);
    Object.assign(source, metadata);
    // The embed Referer carries the same credentials as the resolved URL.
    if (fresh.referer && replaceReferer) source.referer = fresh.referer;
    delete source.playbackVerifiedAt; delete source.playbackFailedAt; delete source.playbackError; delete source.playbackExitCode;
    ep.updatedAt = Date.now(); this.save(); return true;
  }

  markSourceFailure(sid, eid, url, { error, code } = {}) {
    const ep = this.getEpisode(sid, eid); const source = ep?.sources.find(item => item.url === url);
    if (!source) return;
    source.playbackFailedAt = Date.now(); source.playbackError = redact(error).slice(0,1000);
    source.playbackExitCode = Number.isInteger(code) ? code : null;
    ep.updatedAt = source.playbackFailedAt; this.save();
  }

  deleteEpisode(sid, eid) {
    const s = this.getSeries(sid);
    if (!s || !this.getEpisode(sid,eid)) return;
    this.data.deletedEpisodes ||= [];
    const unit=this.getEpisode(sid,eid);
    this.data.deletedEpisodes.push({ seriesId: sid, id: eid, number:unit.number,kind:unit.kind || 'episode',...(unit.key?{key:unit.key}:{}), deletedAt: Math.max(Date.now(),(Number(unit.updatedAt)||0)+1) });
    s.episodes = s.episodes.filter((e) => e.id !== eid);
    if(s.mediaParts)s.mediaParts=s.mediaParts.filter(e=>e.id!==eid);
    s.updatedAt = Date.now();
    this.save();
  }

  markWatched(sid, eid, watched) {
    const ep = this.getEpisode(sid, eid);
    if (!ep) return;
    ep.progress = { ...ep.progress, watched, pos: 0, updatedAt: Date.now() };
    ep.updatedAt = ep.progress.updatedAt;
    const series = this.getSeries(sid); if (series) series.updatedAt = ep.updatedAt;
    this.save();
    this.emit('progress', { seriesId: sid, episodeId: eid, progress: { ...ep.progress }, force: true });
  }

  rateEpisode(sid, eid, rating) {
    const ep = this.getEpisode(sid, eid);
    if (!ep) throw new Error('Episodio non trovato');
    ep.personalRating = personalRating(rating);
    ep.personalRatingUpdatedAt=Math.max(Date.now(),(ep.personalRatingUpdatedAt || 0)+1);
    ep.updatedAt = Date.now();
    const series = this.getSeries(sid); if (series) series.updatedAt = ep.updatedAt;
    this.save();
    return ep;
  }

  setProgress(sid, eid, p, { forceSync = false } = {}) {
    const s = this.getSeries(sid); const ep = this.getEpisode(sid, eid);
    if (!ep) return;
    const previous = ep.progress;
    ep.progress = { ...ep.progress, ...p, updatedAt: Date.now() };
    if (!(Number(p.duration)>0)) ep.progress.duration = previous.duration || 0;
    if (Number(p.duration)>0) { ep.duration=Number(p.duration); ep.durationSource='mpv'; }
    s.lastWatchedAt = Date.now();
    ep.updatedAt = ep.progress.updatedAt;
    s.updatedAt = ep.progress.updatedAt;
    this.save();
    if (forceSync || previous.pos !== ep.progress.pos || previous.duration !== ep.progress.duration || previous.watched !== ep.progress.watched) {
      this.emit('progress', { seriesId: sid, episodeId: eid, progress: { ...ep.progress }, force: forceSync });
    }
  }

  applySyncedProgress(sid, eid, progress) {
    const series = this.getSeries(sid); const episode = this.getEpisode(sid, eid);
    if (!series || !episode) return false;
    episode.progress = {
      pos: Math.max(0, Number(progress.position_seconds) || 0),
      duration: Math.max(0, Number(progress.duration_seconds) || episode.progress.duration || 0),
      watched: Boolean(progress.completed),
      updatedAt: Date.parse(progress.updated_at) || 0,
    };
    episode.updatedAt = episode.progress.updatedAt;
    series.updatedAt = Math.max(series.updatedAt || 0, episode.updatedAt);
    series.lastWatchedAt = Math.max(series.lastWatchedAt || 0, episode.progress.updatedAt);
    this.save();
    return true;
  }

  // Unisce titoli/miniature trovati online senza toccare link e progresso
  mergeDuration(ep, meta) {
    if (ep.durationSource === 'mpv' || Number(ep.progress?.duration)>0) return;
    if (Number(meta.duration)>0 && Number.isFinite(Number(meta.duration))) {
      ep.duration = Number(meta.duration) * (meta.durationUnit === 'seconds' ? 1 : 60);
      ep.durationSource = meta.durationSource || 'metadata';
    }
  }
  mergeEpisodeMeta(sid, list) {
    const s = this.getSeries(sid);
    if (!s || Franchise.singleWork(s)) return;
    for (const m of list) {
      if(this.episodeNumberDeleted(sid,m.number))continue;
      const ep = this.ensureEpisode(s, m.number);
      const before = JSON.stringify(ep);
      if (m.title && !ep.title) ep.title = m.title;
      if (m.thumb && !ep.thumb) ep.thumb = m.thumb;
      this.mergeDuration(ep,m);
      if (Array.isArray(m.skipTimes)) ep.skipTimes = m.skipTimes;
      if (m.rating != null && Number.isFinite(Number(m.rating))) { ep.rating = Number(m.rating); ep.ratingSource = m.ratingSource || 'IMDb'; }
      if (JSON.stringify(ep) !== before) ep.updatedAt = Date.now();
    }
    if (s.imdbChart && Array.isArray(s.imdbChart.seasons) && s.imdbChart.seasons.length > 0) {
      const { applyImdbRatingsToEpisodes } = require('./metadata');
      applyImdbRatingsToEpisodes(s.episodes, s.imdbChart, s);
    }
    s.updatedAt = Date.now();
    this.save();
  }

  setUnitSkipTimes(sid,eid,skipTimes) {
    const unit=this.getEpisode(sid,eid);
    if(!unit || !Array.isArray(skipTimes))return false;
    if(JSON.stringify(unit.skipTimes)===JSON.stringify(skipTimes))return true;
    unit.skipTimes=skipTimes;unit.updatedAt=Date.now();this.save();return true;
  }

  refreshSeriesMetadata(sid, fields, list = []) {
    const s = this.getSeries(sid);
    if (!s) throw new Error('Serie non trovata');
    this._applyDescriptionFields(s,fields);
    const allowed = ['title', 'altTitle', 'titleAliases', 'averageDuration', 'cover', 'banner', 'genres', 'cast', 'related','relationTags', 'score', 'scoreSource', 'year', 'format', 'episodeCount', 'status', 'nextAiringAt', 'nextEpisode', 'malId', 'kitsuId', 'anilistId', 'imdbId', 'imdbChart', 'imdbSelection', 'introDuration', 'outroDuration', 'personalRating'];
    for (const key of allowed) if (key in fields && fields[key] !== undefined) {
      if (['cover','banner'].includes(key) && !fields[key]) continue;
      if (key==='titleAliases') s[key]=[...new Set([...(s[key]||[]),...(fields[key]||[])])];
      else s[key] = fields[key];
    }
    s.introDuration = nonNegativeSeconds(s.introDuration);
    s.outroDuration = nonNegativeSeconds(s.outroDuration);
    s.personalRating = personalRating(s.personalRating);
    if (Franchise.singleWork(s)) this.migrateParts(s);
    const retainEpisode = (ep) => ep.sources.length > 0 || ep.progress.pos > 0 || ep.progress.duration > 0 || ep.progress.watched || ep.progress.updatedAt > 0;
    if (!Franchise.singleWork(s) && Number.isInteger(s.episodeCount) && s.episodeCount > 0 && s.episodeCount <= 300) {
      for (let n = 1; n <= s.episodeCount; n++) if(!this.episodeNumberDeleted(sid,n))this.ensureEpisode(s, n);
      s.episodes = s.episodes.filter((ep) => ep.number <= s.episodeCount || retainEpisode(ep));
    }
    for (const m of list) {
      if (Franchise.singleWork(s)) break;
      if (!Number.isInteger(m.number) || m.number < 0) continue;
      if(this.episodeNumberDeleted(sid,m.number))continue;
      if (s.episodeCount > 0 && m.number > s.episodeCount) {
        const existing = s.episodes.find((e) => e.number === m.number);
        if (!existing || !retainEpisode(existing)) continue;
      }
      const ep = this.ensureEpisode(s, m.number);
      const before = JSON.stringify(ep);
      if (m.title) ep.title = m.title;
      if (m.thumb) ep.thumb = m.thumb;
      this.mergeDuration(ep,m);
      if (Array.isArray(m.skipTimes)) ep.skipTimes = m.skipTimes;
      if (m.rating != null && Number.isFinite(Number(m.rating))) { ep.rating = Number(m.rating); ep.ratingSource = m.ratingSource || 'IMDb'; }
      if (JSON.stringify(ep) !== before) ep.updatedAt = Date.now();
    }
    if (s.imdbChart && Array.isArray(s.imdbChart.seasons) && s.imdbChart.seasons.length > 0) {
      const { applyImdbRatingsToEpisodes } = require('./metadata');
      applyImdbRatingsToEpisodes(s.episodes, s.imdbChart, s);
    }
    if (Number.isInteger(s.episodeCount) && s.episodeCount > 0 && s.episodeCount <= 300) {
      s.episodes = s.episodes.filter((ep) => ep.number <= s.episodeCount || retainEpisode(ep));
    }
    s.updatedAt = Date.now();
    this.save();
    return s;
  }

  _applyDescriptionFields(series,fields={}){
    const provided=Object.hasOwn(fields,'descriptionOriginal')||Object.hasOwn(fields,'description');
    if(!provided)return;
    const original=String(fields.descriptionOriginal ?? fields.description ?? '');
    const prior=Descriptions.descriptionFields(series),incoming=Descriptions.descriptionFields({...series,...fields,descriptionOriginal:original});
    series.description=original;series.descriptionOriginal=original;
    series.descriptionLanguage=Object.hasOwn(fields,'descriptionLanguage')?incoming.descriptionLanguage:prior.descriptionLanguage;
    series.descriptionSource=Object.hasOwn(fields,'descriptionSource')?incoming.descriptionSource:prior.descriptionSource;
    const combined={...prior.descriptionTranslations,...incoming.descriptionTranslations};
    series.descriptionTranslations=Descriptions.descriptionFields({descriptionOriginal:original,descriptionTranslations:combined}).descriptionTranslations;
  }

  setDescriptionTranslation(id,language,translation){
    const series=this.getSeries(id);if(!series||!['en','it'].includes(language))return false;
    const original=String(series.descriptionOriginal ?? series.description ?? '');
    if(!translation||typeof translation.text!=='string'||!translation.text.trim()||typeof translation.provider!=='string'
      ||translation.originalHash!==Descriptions.hashDescription(original))return false;
    const entry={text:translation.text,provider:translation.provider,originalHash:translation.originalHash,updatedAt:Math.max(0,Number(translation.updatedAt)||Date.now())};
    series.descriptionTranslations={...Descriptions.descriptionFields(series).descriptionTranslations,[language]:entry};
    series.updatedAt=Date.now();this.save();return true;
  }

  statistics() {
    const activity = [];
    let watchedEpisodes = 0;
    let watchTime = 0;
    let completedSeries = 0;
    let episodesTotal = 0;
    const perSeries = [];
    for (const s of this.data.series) {
      const units=Franchise.units(s);
      const totalEpisodes = units.length;
      const watched = units.filter((e) => e.progress.watched);
      const seriesWatchTime = units.reduce((sum, e) => {
        if (e.progress.watched && e.progress.duration > 0) return sum + e.progress.duration;
        return sum + (!e.progress.watched && e.progress.pos > 0 ? e.progress.pos : 0);
      }, 0);
      const lastActivity = Math.max(s.lastWatchedAt || 0, ...units.map((e) => e.progress.updatedAt || 0));
      episodesTotal += totalEpisodes;
      watchedEpisodes += watched.length;
      watchTime += seriesWatchTime;
      for (const e of units) {
        if (e.progress.updatedAt) activity.push({
          seriesId: s.id, seriesTitle: s.title, episodeId: e.id, episodeNumber: e.number,
          title: e.title || (e.kind==='part'?s.title:`Episodio ${e.number}`), kind:e.kind, watched: e.progress.watched,
          updatedAt: e.progress.updatedAt,
        });
      }
      if (totalEpisodes > 0 && watched.length >= totalEpisodes) completedSeries++;
      perSeries.push({
        seriesId: s.id,
        title: s.title,
        cover: s.cover || null,
        watchedEpisodes: watched.length,
        totalEpisodes,
        completion: totalEpisodes ? Math.min(100, (watched.length / totalEpisodes) * 100) : 0,
        watchTime: seriesWatchTime,
        lastActivity,
        genres: Array.isArray(s.genres) ? s.genres : [],
        year: s.year || null,
        format: s.format || null,
        score: Number.isFinite(Number(s.score)) ? Number(s.score) : null,
      });
    }
    activity.sort((a, b) => b.updatedAt - a.updatedAt);
    perSeries.sort((a, b) => (b.lastActivity - a.lastActivity) || a.title.localeCompare(b.title));
    return {
      seriesCount: this.data.series.length,
      episodesTotal,
      watchedEpisodes,
      watchTime,
      completedSeries,
      inProgressSeries: perSeries.filter((s) => s.watchedEpisodes > 0 && s.watchedEpisodes < s.totalEpisodes).length,
      latestActivity: activity.slice(0, 12),
      perSeries,
    };
  }
}

module.exports = { Store, DEFAULT_SETTINGS, validateLibraryData };
