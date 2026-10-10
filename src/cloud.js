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

const PROJECT_REF = 'gbdcdserzrujiuacefca'; // anime-player; deliberately excludes the old haxball2 project.
const CLOUD_SETTINGS = ['theme', 'language', 'defaultPreset', 'autoplayNext', 'skipOpening', 'skipEnding', 'alang', 'slang'];
const DEVICE_SETTINGS = ['mpvPath', 'mpvInstallDirectory', 'onboardingComplete'];
const uuid = () => crypto.randomUUID();
const nowIso = (value = Date.now()) => new Date(value).toISOString();
const EMPTY_LIBRARY = () => ({ settings: {}, series: [], deletedSeries: [], deletedEpisodes: [], updatedAt: 0, cloudDirty: false });

function mergeLibrarySnapshots(localInput, remoteInput) {
  const local = localInput || EMPTY_LIBRARY();
  const remote = remoteInput || EMPTY_LIBRARY();
  const deletedSeries = new Map();
  const deletedEpisodes = new Map();
  for (const item of [...(remote.deletedSeries || []), ...(local.deletedSeries || [])]) {
    deletedSeries.set(item.id, Math.max(deletedSeries.get(item.id) || 0, Number(item.deletedAt) || 0));
  }
  for (const item of [...(remote.deletedEpisodes || []), ...(local.deletedEpisodes || [])]) {
    const key = `${item.seriesId}:${item.id}`;
    deletedEpisodes.set(key, Math.max(deletedEpisodes.get(key) || 0, Number(item.deletedAt) || 0));
  }
  const series = new Map();
  for (const item of [...(remote.series || []), ...(local.series || [])]) {
    const current = series.get(item.id);
    if (!current) { series.set(item.id, { ...item, episodes: [...(item.episodes || [])] }); continue; }
    const winner = (Number(item.updatedAt || item.addedAt) || 0) > (Number(current.updatedAt || current.addedAt) || 0) ? item : current;
    const episodes = new Map((current.episodes || []).map((episode) => [episode.number, episode]));
    for (const episode of item.episodes || []) {
      const old = episodes.get(episode.number);
      if (!old) { episodes.set(episode.number, episode); continue; }
      const oldProgressAt = Number(old.progress?.updatedAt) || 0;
      const newProgressAt = Number(episode.progress?.updatedAt) || 0;
      const winner = (Number(episode.updatedAt || newProgressAt) || 0) > (Number(old.updatedAt || oldProgressAt) || 0) ? episode : old;
      const sources = new Map([...(old.sources || []), ...(episode.sources || [])].map((source) => [source.url, source]));
      const measured = [old,episode].filter(ep=>ep.durationSource==='mpv' && Number(ep.duration)>0)
        .sort((a,b)=>(Number(b.updatedAt)||0)-(Number(a.updatedAt)||0))[0];
      const latestProgress=newProgressAt > oldProgressAt ? episode.progress : old.progress;
      episodes.set(episode.number, {
        ...winner,
        ...(measured ? {duration:measured.duration,durationSource:'mpv'} : {}),
        id: old.id || episode.id,
        sources: [...sources.values()],
        progress: {...latestProgress,duration:Number(latestProgress?.duration)>0 ? latestProgress.duration : Number(old.progress?.duration) || Number(episode.progress?.duration) || 0},
        updatedAt: Math.max(Number(old.updatedAt) || 0, Number(episode.updatedAt) || 0, oldProgressAt, newProgressAt),
      });
    }
    const sourcePattern = item.sourcePattern || current.sourcePattern;
    const older = winner === item ? current : item;
    const franchise = Object.fromEntries(['franchiseId', 'franchiseTitle', 'franchiseOrder', 'franchiseType', 'franchiseSeasonNumber']
      .map((key) => [key, winner[key] != null ? winner[key] : older[key]]).filter(([, value]) => value != null));
    const movieSources = new Map([...(current.movieSources || []), ...(item.movieSources || [])].filter((source) => source?.url).map((source) => [source.url, source]));
    const patternOwner = item.sourcePattern ? item : current;
    series.set(item.id, { ...winner, ...franchise, videoPreference:Language.mergePreference(item.videoPreference, current.videoPreference),
      sourcePatternLanguage:Language.classification(patternOwner.sourcePatternLanguage), cover:winner.cover || older.cover || null, banner:winner.banner || older.banner || null,
      titleAliases:[...new Set([...(current.titleAliases||[]),...(item.titleAliases||[])])],
      movieSources: [...movieSources.values()], ...(sourcePattern ? { sourcePattern: { ...sourcePattern } } : {}), episodes: [...episodes.values()] });
  }
  const resultSeries = [];
  for (const item of series.values()) {
    if ((deletedSeries.get(item.id) || 0) >= (Number(item.updatedAt || item.addedAt) || 0)) continue;
    item.episodes = (item.episodes || []).filter((episode) => {
      const deletedAt = deletedEpisodes.get(`${item.id}:${episode.id}`) || 0;
      if (deletedAt && deletedAt >= (Number(episode.updatedAt || episode.progress?.updatedAt) || 0)) return false;
      return true;
    });
    resultSeries.push(item);
  }
  const localSettingsAt = Number(local.settingsUpdatedAt) || 0;
  const remoteSettingsAt = Number(remote.settingsUpdatedAt) || 0;
  const settings = { ...(remote.settings || {}), ...(localSettingsAt > remoteSettingsAt ? local.settings || {} : {}) };
  return {
    settings, series: resultSeries,
    deletedSeries: [...deletedSeries].map(([id, deletedAt]) => ({ id, deletedAt })),
    deletedEpisodes: [...deletedEpisodes].map(([key, deletedAt]) => { const [seriesId, id] = key.split(':'); return { seriesId, id, deletedAt }; }),
    updatedAt: Math.max(Number(local.updatedAt) || 0, Number(remote.updatedAt) || 0), cloudDirty: true,
  };
}
function validCloudSetting(key, value) {
  if (key === 'theme') return ['default', 'compact'].includes(value);
  if (key === 'language') return ['en', 'it'].includes(value);
  if (key === 'defaultPreset') return Object.hasOwn(PRESETS, value);
  if (['autoplayNext', 'skipOpening', 'skipEnding'].includes(key)) return typeof value === 'boolean';
  if (['alang', 'slang'].includes(key)) return typeof value === 'string' && value.length <= 256;
  return false;
}

function compressLibraryForCloud(input) {
  const library = JSON.parse(JSON.stringify(input || EMPTY_LIBRARY()));
  library.series = (library.series || []).map((series) => {
    const episodes = series.episodes || [];
    const candidates = new Map();
    for (const episode of episodes) for (const source of episode.sources || []) {
      if (source.provider === 'animeworld' || source.provider === 'animeunity') continue;
      const detected = detectEpisodeNumber(source.url, episode.number);
      const candidate = detected && detected.candidates.find((item) => item.number === episode.number);
      if (!candidate) continue;
      const urls = candidates.get(candidate.pattern) || new Map();
      urls.set(episode.number, source);
      candidates.set(candidate.pattern, urls);
    }
    const ranked = [...candidates.entries()].map(([pattern, urls]) => ({ pattern, urls }))
      .sort((a, b) => b.urls.size - a.urls.size);
    const best = ranked[0];
    let sourcePattern = null;
    if (best && best.urls.size) {
      const range = episodes.map((episode) => episode.number).filter(Number.isInteger).sort((a, b) => a - b);
      if (range.length) sourcePattern = { pattern: best.pattern, from: range[0], to: range[range.length - 1] };
    }
    const cleanSeries = { ...series };
    delete cleanSeries.sourcePattern;
    delete cleanSeries.sourcePatternLanguage;
    if (sourcePattern) {
      cleanSeries.sourcePattern = sourcePattern;
      const languages = [...best.urls.values()].map(source => Language.classification(source.language));
      // A template may propagate only a consistently declared manual classification.
      if (languages.every(language => language?.origin === 'manual' && JSON.stringify(language) === JSON.stringify(languages[0]))) cleanSeries.sourcePatternLanguage = languages[0];
    }
    cleanSeries.episodes = episodes.map(({ sources, ...episode }) => ({ ...episode }));
    return cleanSeries;
  });
  return library;
}

function expandLibraryFromCloud(input) {
  const library = JSON.parse(JSON.stringify(input || EMPTY_LIBRARY()));
  library.series = (library.series || []).map((series) => {
    const sourcePattern = series.sourcePattern || (series.episodes || []).find((episode) => episode.sourcePattern)?.sourcePattern;
    const next = { ...series };
    delete next.sourcePattern;
    next.episodes = (series.episodes || []).map((episode) => {
      let sources = Array.isArray(episode.sources) ? episode.sources : [];
      if (sourcePattern && Number.isInteger(episode.number) && episode.number >= sourcePattern.from && episode.number <= sourcePattern.to) {
        try {
          const link = expandPattern(sourcePattern.pattern, episode.number, episode.number)[0]?.url;
          if (link) {
            const language = Language.classification(series.sourcePatternLanguage);
            sources = [{ url: link, ...(language?.origin === 'manual' ? {language} : {}) }];
          }
        } catch { /* pattern cloud non valido: conserva eventuali sorgenti locali */ }
      }
      return { ...episode, sources };
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

function createSessionStorage({ safeStorage, file }) {
  const read = () => {
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      const encoded = JSON.parse(fs.readFileSync(file, 'utf8')).session;
      return encoded ? safeStorage.decryptString(Buffer.from(encoded, 'base64')) : null;
    } catch { return null; }
  };
  const write = (session) => {
    if (!safeStorage.isEncryptionAvailable()) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const encrypted = safeStorage.encryptString(session).toString('base64');
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ session: encrypted }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  return {
    getItem: async () => read(),
    setItem: async (_key, value) => write(value),
    removeItem: async () => { try { fs.unlinkSync(file); } catch { /* già rimosso */ } },
  };
}

class CloudService {
  constructor({ store, userDataPath, safeStorage, notify = () => {}, env = process.env, client = null, isPackaged = false, resourcesPath = null }) {
    this.store = store;
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
    if (!this.client && this.config.configured) {
      this.client = createClient(this.config.url, this.config.key, {
        auth: {
          storage: createSessionStorage({ safeStorage, file: path.join(userDataPath, 'supabase-session.json') }),
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: false,
        },
        realtime: { transport: WebSocket },
      });
    }
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

  _loadState() {
    try {
      const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        mappings: loaded.mappings || {}, favorites: loaded.favorites || [], removedFavorites: loaded.removedFavorites || [],
        history: loaded.history || [], settingsUpdatedAt: Number(loaded.settingsUpdatedAt) || 0, libraryRevision: Number(loaded.libraryRevision) || 0,
      };
    } catch { return { mappings: {}, favorites: [], removedFavorites: [], history: [], settingsUpdatedAt: 0, libraryRevision: 0 }; }
  }

  _saveState() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  status() {
    return { configured: this.config.configured, connected: Boolean(this.user), user: this.user ? { id: this.user.id, email: this.user.email } : null, error: this.config.error || null, syncing: Boolean(this.syncing), pendingCatalogMatches: this.pendingCatalogMatches };
  }

  _publish(message = null) { this.notify('sync:state', { ...this.status(), message }); }

  async start() {
    this.store.on('progress', this._onProgress);
    this.store.on('settings', this._onSettings);
    this.store.on('changed', this._onLibraryChanged);
    if (!this.client) { this._publish(); return; }
    const { data: { subscription } } = this.client.auth.onAuthStateChange((_event, session) => {
      this.user = session && session.user || null;
      this._publish();
      if (this.user) setTimeout(() => this.sync().catch((error) => this._failed(error)), 0);
    });
    this.authSubscription = subscription;
    const { data: { session }, error } = await this.client.auth.getSession();
    if (error) this._failed(error);
    this.user = session && session.user || null;
    this._publish();
    if (this.user) this.sync().catch((err) => this._failed(err));
    // Retry local outbox while the app is open; network errors never block local playback.
    this.timer = setInterval(() => { if (this.user) this.sync().catch((err) => this._failed(err)); }, 60000);
  }

  stop() {
    this.stopped = true;
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
    this._saveState();
    this._scheduleSync(1500);
  }

  _scheduleSync(delay) {
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.sync().catch((error) => this._failed(error)), delay);
  }

  async signUp(email, password) {
    this._requireClient();
    const { data, error } = await this.client.auth.signUp({ email, password });
    if (error) throw error;
    if (data.user && data.session) await this.ensureProfile(data.user.id);
    return { user: data.user, needsEmailConfirmation: Boolean(data.user && !data.session), connected: Boolean(data.session) };
  }

  async signIn(email, password) {
    this._requireClient();
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    if (this.syncing) await this.syncing.catch(() => {});
    this.user = data.user;
    await this._activateLibrary(data.user.id);
    await this.ensureProfile(data.user.id);
    this.sync().catch((err) => this._failed(err));
    this._publish();
    return data.user;
  }

  async signOut() {
    this._requireClient();
    if (this.syncing) await this.syncing.catch(() => {});
    const { error } = await this.client.auth.signOut();
    if (error) throw error;
    this.user = null;
    await this._activateLibrary(null);
    this._publish();
  }

  async getSession() {
    if (!this.client) return this.status();
    const { data, error } = await this.client.auth.getSession();
    if (error) throw error;
    this.user = data.session && data.session.user || null;
    return { ...this.status(), user: data.session && data.session.user ? { id: data.session.user.id, email: data.session.user.email, email_confirmed_at: data.session.user.email_confirmed_at || null } : null };
  }

  _requireClient() {
    if (!this.client) throw new Error(this.config.error || 'Supabase non configurato.');
  }

  _requireUser() {
    this._requireClient();
    if (!this.user) throw new Error('Accedi a Supabase per continuare.');
    return this.user;
  }

  async ensureProfile(userId, profile = {}) {
    this._requireClient();
    const { error } = await this.client.from('profiles').upsert({ id: userId, ...profile }, { onConflict: 'id' });
    if (error) throw error;
  }

  async getProfile(userId = null) {
    const user = this._requireUser();
    const { data, error } = await this.client.from('profiles').select('id,username,display_name,avatar_url,bio,created_at,updated_at').eq('id', userId || user.id).maybeSingle();
    if (error) throw error;
    return data;
  }

  async updateProfile(patch) {
    const user = this._requireUser();
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
    const { data, error } = await this.client.from('profiles').upsert({ id: user.id, ...value, updated_at: nowIso() }, { onConflict: 'id' }).select().single();
    if (error) throw error;
    return data;
  }

  recordWatchSession({ seriesId, episodeId, startedAt, finishedAt, watchedSeconds }) {
    this.state.history.push({ id: uuid(), seriesId, episodeId, startedAt: nowIso(startedAt), finishedAt: nowIso(finishedAt), watchedSeconds: Math.max(0, Number(watchedSeconds) || 0), synced: false });
    this._saveState();
    if (this.user) this._scheduleSync(1000);
  }

  async setFavorite(seriesId, favorite) {
    const series = this.store.getSeries(seriesId);
    if (!series) throw new Error('Serie non trovata.');
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
    this.syncing = this._syncForUser(userId).finally(() => { this.syncing = null; this._publish(); if (this.user && this.user.id !== userId) this._scheduleSync(0); });
    this._publish();
    return this.syncing;
  }

  async _syncForUser(userId) {
    await this._activateLibrary(userId);
    await this._syncPrivateLibrary(userId);
    await this.ensureProfile(userId);
    const catalog = await this._resolveCatalog();
    await this._syncProgress(userId, catalog);
    await this._syncHistory(userId, catalog);
    await this._syncFavorites(userId, catalog);
    await this._syncSettings(userId);
    await this._syncPrivateLibrary(userId);
    this._saveState();
    this.lastError = null;
    const message = this.pendingCatalogMatches
      ? `Libreria privata sincronizzata; ${this.pendingCatalogMatches} anime/episodi locali attendono una voce nel catalogo condiviso per la sincronizzazione aggiuntiva.`
      : 'Libreria privata sincronizzata';
    this._publish(message);
  }

  async getMyProfile() {
    const user = this._requireUser();
    const profile = await this.getProfile(user.id);
    return profile || { id: user.id, username: null, display_name: null, avatar_url: null, bio: null };
  }

  _syncFileForUser(userId) { return path.join(path.dirname(this.baseStateFile), `supabase-sync-${userId}.json`); }

  async _activateLibrary(userId) {
    if (this.activeLibraryUserId === userId) return;
    const wasUnclaimed = !fs.existsSync(this.libraryClaimFile);
    let claim = null;
    try { claim = JSON.parse(fs.readFileSync(this.libraryClaimFile, 'utf8')); } catch { /* first login */ }
    const targetFile = userId ? path.join(path.dirname(this.libraryFile), `library-${userId}.json`) : this.libraryFile;
    if (userId && wasUnclaimed && this.legacyOwnerOverrideId && this.legacyOwnerOverrideId !== userId && this.legacyLibrarySnapshot.series.length) {
      throw new Error('Per trasferire la libreria locale, accedi all’account che hai indicato.');
    }
    const legacyOwnerId = claim && claim.userId ? claim.userId : (userId && wasUnclaimed ? userId : null);
    const legacyOwnerFile = legacyOwnerId ? path.join(path.dirname(this.libraryFile), `library-${legacyOwnerId}.json`) : null;
    if (legacyOwnerId && this.legacyLibrarySnapshot.series.length && !fs.existsSync(legacyOwnerFile)) {
      // A saved owner marker keeps the original library assigned to the selected account.
      this.store.writeLibraryFile(legacyOwnerFile, this.legacyLibrarySnapshot);
      const ownerStateFile = this._syncFileForUser(legacyOwnerId);
      if (!fs.existsSync(ownerStateFile)) {
        try { fs.writeFileSync(ownerStateFile, JSON.stringify(this.legacySyncSnapshot, null, 2), { mode: 0o600 }); } catch { /* no previous sync state */ }
      }
    }
    if (userId && wasUnclaimed && !claim) {
      fs.mkdirSync(path.dirname(this.libraryClaimFile), { recursive: true });
      fs.writeFileSync(this.libraryClaimFile, JSON.stringify({ userId }), { mode: 0o600 });
    }
    if (userId && (wasUnclaimed || claim)) {
      // Keep the legacy path empty after transferring its contents to the selected owner.
      this.store.writeLibraryFile(this.libraryFile, EMPTY_LIBRARY());
    }
    this.suppressLibrarySync = true;
    try { this.store.switchFile(targetFile); } finally { this.suppressLibrarySync = false; }
    this.activeLibraryUserId = userId;
    this.file = userId ? this._syncFileForUser(userId) : this.baseStateFile;
    this.state = this._loadState();
    this.legacySyncSnapshot = JSON.parse(JSON.stringify(this.state));
  }

  _privateSnapshot() {
    const library = this.store.snapshot();
    library.settings = Object.fromEntries(Object.entries(library.settings || {}).filter(([key]) => !DEVICE_SETTINGS.includes(key)));
    library.cloudDirty = false;
    return { library: compressLibraryForCloud(library), history: this.state.history, sync: { mappings: this.state.mappings, favorites: this.state.favorites, removedFavorites: this.state.removedFavorites, settingsUpdatedAt: this.state.settingsUpdatedAt } };
  }

  async _syncPrivateLibrary(userId) {
    const { data: remote, error } = await this.client.from('user_library_snapshots').select('snapshot,revision,updated_at').eq('user_id', userId).maybeSingle();
    if (error) throw error;
    const localDirty = Boolean(this.store.data.cloudDirty);
    const localRevision = Number(this.state.libraryRevision) || 0;
    if (!remote) {
      const snapshot = this._privateSnapshot();
      snapshot.library.settings = Object.fromEntries(Object.entries(snapshot.library.settings || {}).filter(([key]) => !DEVICE_SETTINGS.includes(key)));
      const { data, error: insertError } = await this.client.from('user_library_snapshots').insert({ user_id: userId, snapshot, revision: 1, updated_at: nowIso() }).select('revision,updated_at').single();
      if (insertError) { if (insertError.code === '23505') return this._syncPrivateLibrary(userId); throw insertError; }
      this.state.libraryRevision = Number(data.revision) || 1;
      this.store.markCloudSynced(data.updated_at);
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
      this.state = { ...this.state, ...(remoteSnapshot.sync || {}), history: remoteSnapshot.history || this.state.history, libraryRevision: Number(remote.revision) };
      this._saveState();
      return;
    }
    if (!localDirty) return;
    let library = this.store.snapshot();
    if (localRevision !== Number(remote.revision)) library = mergeLibrarySnapshots(library, remote.snapshot?.library || EMPTY_LIBRARY());
    const snapshot = this._privateSnapshot();
    snapshot.library = compressLibraryForCloud(library);
    snapshot.library.settings = Object.fromEntries(Object.entries(snapshot.library.settings || {}).filter(([key]) => !DEVICE_SETTINGS.includes(key)));
    const history = new Map([...(remote.snapshot?.history || []), ...this.state.history].map((record) => [record.id, record]));
    snapshot.history = [...history.values()];
    snapshot.sync = { ...(remote.snapshot?.sync || {}), mappings: this.state.mappings, favorites: this.state.favorites, removedFavorites: this.state.removedFavorites, settingsUpdatedAt: this.state.settingsUpdatedAt };
    const updatedAt = nowIso();
    const { data, error: updateError } = await this.client.from('user_library_snapshots').update({ snapshot, revision: Number(remote.revision) + 1, updated_at: updatedAt }).eq('user_id', userId).eq('revision', remote.revision).select('revision,updated_at').maybeSingle();
    if (updateError) throw updateError;
    if (!data) { this.state.libraryRevision = 0; this._saveState(); this._scheduleSync(1000); return; }
    this.state.libraryRevision = Number(data.revision);
    if (library !== this.store.data) {
      const deviceSettings = Object.fromEntries(DEVICE_SETTINGS.map((key) => [key, this.store.data.settings[key]]));
      this.suppressLibrarySync = true;
      try { this.store.applyCloudData({ ...library, settings: { ...library.settings, ...deviceSettings } }, data.updated_at); } finally { this.suppressLibrarySync = false; }
    } else this.store.markCloudSynced(data.updated_at);
    this._saveState();
  }

  async _resolveCatalog() {
    const series = this.store.data.series.filter((item) => item.anilistId != null);
    const ids = [...new Set(series.flatMap((item) => [String(item.anilistId), `anilist:${item.anilistId}`]))];
    const { data: animeRows, error: animeError } = await this.client.from('anime').select('id,external_id').in('external_id', ids);
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
    const { data: episodeRows, error: episodeError } = await this.client.from('episodes').select('id,anime_id,episode_number,season_number').in('anime_id', remoteAnimeIds);
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
    this.pendingCatalogMatches = unmatchedEpisodes;
    return { episodes: episodeMap, anime: animeMap };
  }

  async _syncProgress(userId, catalog) {
    const { data: remoteRows, error } = await this.client.from('user_progress').select('episode_id,position_seconds,completed,updated_at').eq('user_id', userId);
    if (error) throw error;
    const remoteByEpisode = new Map((remoteRows || []).map((row) => [row.episode_id, row]));
    const localByRemote = new Map([...catalog.episodes].map(([local, remote]) => [remote, local]));
    for (const row of remoteRows || []) {
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
      const { error: upsertError } = await this.client.from('user_progress').upsert(pending, { onConflict: 'user_id,episode_id' });
      if (upsertError) throw upsertError;
    }
  }

  async _syncHistory(userId, catalog) {
    const reverseMap = new Map([...catalog.episodes].map(([local, remote]) => [remote, local]));
    const { data: remoteRows, error: selectError } = await this.client.from('watch_history').select('id,episode_id,started_at,finished_at,watched_seconds').eq('user_id', userId);
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
    const { error } = await this.client.from('watch_history').upsert(pending, { onConflict: 'id' });
    if (error) throw error;
    const sent = new Set(pending.map((record) => record.id));
    for (const record of this.state.history) if (sent.has(record.id)) record.synced = true;
  }

  async _syncFavorites(userId, catalog) {
    const { data: remoteRows, error } = await this.client.from('favorites').select('anime_id').eq('user_id', userId);
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
      const { error: insertError } = await this.client.from('favorites').insert(additions);
      if (insertError) throw insertError;
    }
    const removed = [];
    for (const localId of this.state.removedFavorites) {
      const animeId = catalog.anime.get(localId);
      if (animeId) {
        const { error: deleteError } = await this.client.from('favorites').delete().eq('user_id', userId).eq('anime_id', animeId);
        if (deleteError) throw deleteError;
        removed.push(localId);
      }
    }
    this.state.removedFavorites = this.state.removedFavorites.filter((id) => !removed.includes(id));
  }

  async _syncSettings(userId) {
    const { data: remote, error } = await this.client.from('settings').select('settings,updated_at').eq('user_id', userId).maybeSingle();
    if (error) throw error;
    const localUpdatedAt = this.state.settingsUpdatedAt;
    if (remote && (Date.parse(remote.updated_at) || 0) > localUpdatedAt) {
      const patch = Object.fromEntries(CLOUD_SETTINGS.filter((key) => Object.hasOwn(remote.settings || {}, key) && validCloudSetting(key, remote.settings[key])).map((key) => [key, remote.settings[key]]));
      Object.assign(this.store.data.settings, patch);
      this.store.save();
      this.notify('lib:changed', this.store.snapshot());
      this.state.settingsUpdatedAt = Date.parse(remote.updated_at) || 0;
      return;
    }
    const settings = Object.fromEntries(CLOUD_SETTINGS.filter((key) => Object.hasOwn(this.store.data.settings, key) && validCloudSetting(key, this.store.data.settings[key])).map((key) => [key, this.store.data.settings[key]]));
    const row = { user_id: userId, settings, updated_at: nowIso(localUpdatedAt || Date.now()) };
    const { error: upsertError } = await this.client.from('settings').upsert(row, { onConflict: 'user_id' });
    if (upsertError) throw upsertError;
    if (!localUpdatedAt) this.state.settingsUpdatedAt = Date.now();
  }

  async searchUsers(query) {
    this._requireUser();
    const value = String(query || '').trim();
    if (value.length < 2) return [];
    let result;
    if (value.includes('@') && !value.startsWith('@')) {
      const email = value.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return [];
      result = await this.client.rpc('search_profiles_by_email', { search_email: email });
    } else {
      const nickname = value.replace(/^@+/, '').trim();
      if (nickname.length < 2) return [];
      const escaped = nickname.replace(/[\\%_]/g, (character) => `\\${character}`);
      result = await this.client.from('profiles').select('id,username,display_name,avatar_url,bio').ilike('username', `%${escaped}%`).limit(20);
    }
    const { data, error } = result;
    if (error) throw error;
    return data;
  }

  async sendFriendRequest(receiverId) {
    const user = this._requireUser();
    const { data, error } = await this.client.from('friend_requests').insert({ sender_id: user.id, receiver_id: receiverId }).select().single();
    if (error) throw error;
    return data;
  }

  async listFriendRequests() {
    const user = this._requireUser();
    const { data, error } = await this.client.from('friend_requests').select('*').or(`sender_id.eq.${user.id},receiver_id.eq.${user.id}`).order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  }

  async respondFriendRequest(requestId, status) {
    const user = this._requireUser();
    if (!['accepted', 'rejected', 'cancelled'].includes(status)) throw new Error('Stato richiesta non valido.');
    const actorColumn = status === 'cancelled' ? 'sender_id' : 'receiver_id';
    const { data, error } = await this.client.from('friend_requests')
      .update({ status, responded_at: nowIso() })
      .eq('id', requestId)
      .eq(actorColumn, user.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async listFriends() {
    const user = this._requireUser();
    const { data, error } = await this.client.from('friendships').select('user_id,friend_id,created_at').or(`user_id.eq.${user.id},friend_id.eq.${user.id}`);
    if (error) throw error;
    const ids = data.map((row) => row.user_id === user.id ? row.friend_id : row.user_id);
    if (!ids.length) return [];
    const { data: profiles, error: profileError } = await this.client.from('profiles').select('id,username,display_name,avatar_url,bio').in('id', ids);
    if (profileError) throw profileError;
    return profiles;
  }

  async removeFriend(friendId) {
    const user = this._requireUser();
    const { error } = await this.client.from('friendships').delete().or(`and(user_id.eq.${user.id},friend_id.eq.${friendId}),and(user_id.eq.${friendId},friend_id.eq.${user.id})`);
    if (error) throw error;
  }

  async createWatchRoom({ animeId = null, episodeId = null } = {}) {
    const user = this._requireUser();
    const { data, error } = await this.client.from('watch_rooms').insert({ host_id: user.id, anime_id: animeId, episode_id: episodeId, status: 'waiting' }).select().single();
    if (error) throw error;
    const { error: memberError } = await this.client.from('watch_room_members').upsert({ room_id: data.id, user_id: user.id, role: 'host' }, { onConflict: 'room_id,user_id' });
    if (memberError) throw memberError;
    return data;
  }

  async joinWatchRoom(roomId) {
    const user = this._requireUser();
    const { data: existing, error: selectError } = await this.client.from('watch_room_members').select('role,left_at').eq('room_id', roomId).eq('user_id', user.id).maybeSingle();
    if (selectError) throw selectError;
    if (existing && existing.left_at == null) return;
    const { error } = await this.client.from('watch_room_members').upsert({ room_id: roomId, user_id: user.id, role: existing && existing.role === 'host' ? 'host' : 'member', left_at: null }, { onConflict: 'room_id,user_id' });
    if (error) throw error;
  }

  subscribeWatchRoom(roomId, { onPlayback = () => {}, onPresence = () => {} } = {}) {
    const user = this._requireUser();
    const channel = this.client.channel(`watch-room:${roomId}`, { config: { broadcast: { self: false }, presence: { key: user.id } } });
    channel.on('broadcast', { event: 'playback' }, ({ payload }) => onPlayback(payload));
    channel.on('presence', { event: 'sync' }, () => onPresence(channel.presenceState()));
    channel.subscribe((status) => { if (status === 'SUBSCRIBED') channel.track({ userId: user.id, onlineAt: nowIso() }); });
    return {
      sendPlayback: async (type, details = {}) => {
        if (!['PLAY', 'PAUSE', 'SEEK', 'EPISODE_CHANGED'].includes(type)) throw new Error('Evento playback non valido.');
        return channel.send({ type: 'broadcast', event: 'playback', payload: { type, ...details, sentAt: nowIso() } });
      },
      unsubscribe: () => this.client.removeChannel(channel),
    };
  }
}

module.exports = { CloudService, PROJECT_REF, CLOUD_SETTINGS, readConfig, createSessionStorage, mergeLibrarySnapshots, compressLibraryForCloud, expandLibraryFromCloud };
