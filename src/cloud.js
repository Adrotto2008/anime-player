// Supabase integration. The main process owns credentials, auth tokens and sync.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');
const { PRESETS } = require('./anime4k');
const { detectSeasonFromTitle } = require('./metadata');

const PROJECT_REF = 'gbdcdserzrujiuacefca'; // anime-player; deliberately excludes the old haxball2 project.
const CLOUD_SETTINGS = ['theme', 'language', 'defaultPreset', 'autoplayNext', 'skipOpening', 'skipEnding', 'alang', 'slang'];
const uuid = () => crypto.randomUUID();
const nowIso = (value = Date.now()) => new Date(value).toISOString();
function validCloudSetting(key, value) {
  if (key === 'theme') return ['default', 'compact'].includes(value);
  if (key === 'language') return ['en', 'it'].includes(value);
  if (key === 'defaultPreset') return Object.hasOwn(PRESETS, value);
  if (['autoplayNext', 'skipOpening', 'skipEnding'].includes(key)) return typeof value === 'boolean';
  if (['alang', 'slang'].includes(key)) return typeof value === 'string' && value.length <= 256;
  return false;
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
    this.file = path.join(userDataPath, 'supabase-sync.json');
    this.notify = notify;
    this.configFile = path.join(userDataPath, 'supabase-config.json');
    const bundledConfigFile = isPackaged && resourcesPath ? path.join(resourcesPath, 'supabase-config.json') : null;
    this.config = readConfig(env, this.configFile, bundledConfigFile);
    this.state = this._loadState();
    this.client = client;
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
  }

  _loadState() {
    try {
      const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        mappings: loaded.mappings || {}, favorites: loaded.favorites || [], removedFavorites: loaded.removedFavorites || [],
        history: loaded.history || [], settingsUpdatedAt: Number(loaded.settingsUpdatedAt) || 0,
      };
    } catch { return { mappings: {}, favorites: [], removedFavorites: [], history: [], settingsUpdatedAt: 0 }; }
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
    return { user: data.user, needsEmailConfirmation: Boolean(data.user && !data.session) };
  }

  async signIn(email, password) {
    this._requireClient();
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    this.user = data.user;
    await this.ensureProfile(data.user.id);
    this.sync().catch((err) => this._failed(err));
    this._publish();
    return data.user;
  }

  async signOut() {
    this._requireClient();
    const { error } = await this.client.auth.signOut();
    if (error) throw error;
    this.user = null;
    this._publish();
  }

  async getSession() {
    if (!this.client) return this.status();
    const { data, error } = await this.client.auth.getSession();
    if (error) throw error;
    return { ...this.status(), user: data.session && data.session.user ? { id: data.session.user.id, email: data.session.user.email } : null };
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
    this.syncing = this._syncForUser(this.user.id).finally(() => { this.syncing = null; this._publish(); });
    this._publish();
    return this.syncing;
  }

  async _syncForUser(userId) {
    await this.ensureProfile(userId);
    const catalog = await this._resolveCatalog();
    await this._syncProgress(userId, catalog);
    await this._syncHistory(userId, catalog);
    await this._syncFavorites(userId, catalog);
    await this._syncSettings(userId);
    this._saveState();
    this.lastError = null;
    const message = this.pendingCatalogMatches
      ? `Sync utente completata; ${this.pendingCatalogMatches} anime/episodi locali attendono una voce nel catalogo condiviso.`
      : 'Sincronizzazione completata';
    this._publish(message);
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
    const { data, error } = await this.client.from('profiles').select('id,username,display_name,avatar_url,bio').ilike('username', `%${value}%`).limit(20);
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
    const { data, error } = await this.client.from('friend_requests').update({ status, responded_at: nowIso() }).eq('id', requestId).eq(actorColumn, user.id).select().single();
    if (error) throw error;
    if (status === 'accepted') {
      const friendId = data.sender_id;
      const { data: existing, error: selectError } = await this.client.from('friendships').select('friend_id').eq('user_id', user.id).eq('friend_id', friendId).maybeSingle();
      if (selectError) throw selectError;
      if (!existing) {
        const { error: friendshipError } = await this.client.from('friendships').insert({ user_id: user.id, friend_id: friendId });
        if (friendshipError && friendshipError.code !== '23505') throw friendshipError;
      }
    }
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
    const { error } = await this.client.from('friendships').delete().eq('user_id', user.id).eq('friend_id', friendId);
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

module.exports = { CloudService, PROJECT_REF, CLOUD_SETTINGS, readConfig, createSessionStorage };
