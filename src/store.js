// Libreria su file JSON, scrittura atomica con debounce.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { hostLabel, isValidSource } = require('./patterns');

const DEFAULT_SETTINGS = {
  mpvPath: '',
  mpvInstallDirectory: '',
  defaultPreset: 'aa-hq',
  theme: 'default',
  language: 'en',
  onboardingComplete: false,
  autoplayNext: true,
  alang: 'jpn,ja,eng,en',
  slang: 'ita,it,eng,en',
  userAgent: '',
  extraArgs: '',
  skipOpening: false,
  skipEnding: false,
  shortcuts: { next: 'PGDWN', previous: 'PGUP', skipIntro: '', skipEnding: '' },
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
    const episodes = rawSeries.episodes.map((rawEpisode) => {
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
          url: source.url,
          label: typeof source.label === 'string' && source.label ? source.label : hostLabel(source.url),
          ...(['animeunity', 'animeworld'].includes(source.provider) ? { provider: source.provider } : {}),
          ...(typeof source.referer === 'string' && /^https?:\/\//i.test(source.referer) ? { referer: source.referer } : {}),
          ...(typeof source.userAgent === 'string' && source.userAgent.length <= 300 ? { userAgent: source.userAgent } : {}),
        };
      });
      const p = rawEpisode.progress || {};
      if (typeof p.watched !== 'boolean' || !Number.isFinite(Number(p.pos || 0)) || !Number.isFinite(Number(p.duration || 0)) || !Number.isFinite(Number(p.updatedAt || 0))) {
        throw new Error(`Progresso non valido nella serie "${rawSeries.title}", episodio ${rawEpisode.number}.`);
      }
      return {
        ...rawEpisode,
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
      return { url: source.url, label: typeof source.label === 'string' && source.label ? source.label : hostLabel(source.url), ...(typeof source.referer === 'string' && /^https?:\/\//i.test(source.referer) ? { referer: source.referer } : {}) };
    }) : [];
    const lastWatchedAt = Number(rawSeries.lastWatchedAt || 0);
    if (!Number.isFinite(lastWatchedAt)) throw new Error(`Data di visione non valida nella serie "${rawSeries.title}".`);
    return {
      ...rawSeries,
      title: rawSeries.title.trim() || 'Senza titolo',
      updatedAt: Math.max(0, Number(rawSeries.updatedAt) || Number(rawSeries.addedAt) || 0),
      episodes,
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
  if (!['default', 'compact'].includes(settings.theme)) settings.theme = DEFAULT_SETTINGS.theme;
  if (!settings.defaultPreset || settings.defaultPreset === 'a-fast') settings.defaultPreset = DEFAULT_SETTINGS.defaultPreset;
  if (!input.settings || input.settings.onboardingComplete == null) {
    try { settings.onboardingComplete = Boolean(settings.mpvPath && fs.statSync(settings.mpvPath).isFile()); } catch { /* onboarding richiesto */ }
  }
  const deletedSeries = Array.isArray(input.deletedSeries) ? input.deletedSeries.filter((item) => item && typeof item.id === 'string' && Number.isFinite(Number(item.deletedAt))).map((item) => ({ id: item.id, deletedAt: Number(item.deletedAt) })) : [];
  const deletedEpisodes = Array.isArray(input.deletedEpisodes) ? input.deletedEpisodes.filter((item) => item && typeof item.seriesId === 'string' && typeof item.id === 'string' && Number.isFinite(Number(item.deletedAt))).map((item) => ({ seriesId: item.seriesId, id: item.id, deletedAt: Number(item.deletedAt) })) : [];
  return { settings, series, deletedSeries, deletedEpisodes, updatedAt: Math.max(0, Number(input.updatedAt) || 0), cloudDirty: Boolean(input.cloudDirty) };
}

class Store extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.data = { settings: { ...DEFAULT_SETTINGS }, series: [], deletedSeries: [], deletedEpisodes: [], updatedAt: 0, cloudDirty: false };
    this._timer = null;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data.series = Array.isArray(raw.series) ? raw.series : [];
      this.data.deletedSeries = Array.isArray(raw.deletedSeries) ? raw.deletedSeries : [];
      this.data.deletedEpisodes = Array.isArray(raw.deletedEpisodes) ? raw.deletedEpisodes : [];
      this.data.updatedAt = Math.max(0, Number(raw.updatedAt) || 0);
      this.data.cloudDirty = raw.cloudDirty == null ? this.data.series.length > 0 : Boolean(raw.cloudDirty);
      this.data.series.forEach((s) => {
        s.updatedAt = Math.max(0, Number(s.updatedAt) || Number(s.addedAt) || 0);
        s.introDuration = nonNegativeSeconds(s.introDuration);
        s.outroDuration = nonNegativeSeconds(s.outroDuration);
        for (const episode of s.episodes || []) episode.updatedAt = Math.max(0, Number(episode.updatedAt) || Number(episode.progress && episode.progress.updatedAt) || s.updatedAt || 0);
      });
      this.data.settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
      if (!['default', 'compact'].includes(this.data.settings.theme)) this.data.settings.theme = DEFAULT_SETTINGS.theme;
      if (raw.settings && raw.settings.language == null) this.data.settings.language = 'it';
      if (!['en', 'it'].includes(this.data.settings.language)) this.data.settings.language = DEFAULT_SETTINGS.language;
      if (!this.data.settings.defaultPreset || this.data.settings.defaultPreset === 'a-fast') this.data.settings.defaultPreset = DEFAULT_SETTINGS.defaultPreset;
      // Librerie create prima dell'onboarding: se erano già configurate,
      // non devono essere bloccate dalla nuova procedura di primo avvio.
      if (!raw.settings || raw.settings.onboardingComplete == null) {
        let configured = false;
        try { configured = this.data.series.length > 0 && fs.statSync(this.data.settings.mpvPath).isFile(); } catch { /* onboarding richiesto */ }
        this.data.settings.onboardingComplete = Boolean(configured);
      }
    } catch { /* primo avvio o file rovinato: si parte da zero */ }
  }

  save(now = false, throwOnError = false, { cloud = false, emit = true } = {}) {
    clearTimeout(this._timer);
    this.data.updatedAt = cloud ? Math.max(this.data.updatedAt || 0, Date.now()) : Date.now();
    if (!cloud) this.data.cloudDirty = true;
    const write = () => {
      try {
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
  importData(input) {
    const next = validateLibraryData(input);
    const previous = this.data;
    this.data = next;
    try { this.save(true, true); } catch (e) { this.data = previous; throw e; }
    return this.snapshot();
  }

  applyCloudData(input, updatedAt) {
    const next = validateLibraryData(input);
    const previous = this.data;
    next.updatedAt = Math.max(0, Date.parse(updatedAt) || Number(input.updatedAt) || 0);
    next.cloudDirty = false;
    this.data = next;
    try { this.save(true, true, { cloud: true, emit: false }); } catch (error) { this.data = previous; throw error; }
    return this.snapshot();
  }

  markCloudSynced(updatedAt) {
    this.data.cloudDirty = false;
    this.data.updatedAt = Math.max(this.data.updatedAt || 0, Date.parse(updatedAt) || Date.now());
    this.save(true, true, { cloud: true, emit: false });
  }

  switchFile(file) {
    if (path.resolve(file) === path.resolve(this.file)) return;
    this.save(true, true);
    const deviceSettings = { mpvPath: this.data.settings.mpvPath || '', onboardingComplete: Boolean(this.data.settings.onboardingComplete) };
    this.file = file;
    this.data = { settings: { ...DEFAULT_SETTINGS, ...deviceSettings }, series: [], deletedSeries: [], deletedEpisodes: [], updatedAt: 0, cloudDirty: false };
    this.load();
    this.data.settings.mpvPath = deviceSettings.mpvPath || this.data.settings.mpvPath || '';
    if (this.data.settings.mpvPath) this.data.settings.onboardingComplete = deviceSettings.onboardingComplete;
    this.save(true, true, { cloud: true, emit: false });
  }

  writeLibraryFile(file, data) {
    const previousFile = this.file;
    const previousData = this.data;
    this.file = file;
    this.data = validateLibraryData(data);
    try { this.save(true, true, { cloud: true, emit: false }); }
    catch (error) { this.file = previousFile; this.data = previousData; throw error; }
    this.file = previousFile;
    this.data = previousData;
  }

  getSeries(id) { return this.data.series.find((s) => s.id === id); }
  getEpisode(sid, eid) { const s = this.getSeries(sid); return s && s.episodes.find((e) => e.id === eid); }

  setSettings(patch) {
    Object.assign(this.data.settings, patch);
    this.save();
    this.emit('settings', { settings: { ...this.data.settings }, updatedAt: Date.now() });
  }

  needsOnboarding() {
    return !this.data.settings.onboardingComplete;
  }

  addSeries(meta = {}) {
    const now = Date.now();
    const s = {
      id: uid(), title: 'Senza titolo', anilistId: null, kitsuId: null, imdbId: null, imdbChart: null, cover: null, banner: null,
      description: '', genres: [], score: null, scoreSource: null, year: null, format: null, episodeCount: null, status: null,
      nextAiringAt: null, nextEpisode: null, malId: null, personalRating: null,
      preset: null, referer: '', addedAt: now, updatedAt: now, lastWatchedAt: 0, episodes: [], ...meta,
    };
    if (!Array.isArray(s.episodes)) s.episodes = [];
    s.introDuration = nonNegativeSeconds(s.introDuration);
    s.outroDuration = nonNegativeSeconds(s.outroDuration);
    s.personalRating = personalRating(s.personalRating);
    this.data.series.push(s);
    this.save();
    return s;
  }

  updateSeries(id, patch) {
    const s = this.getSeries(id);
    if (!s) throw new Error('Serie non trovata');
    const allowed = ['title', 'altTitle', 'preset', 'referer', 'cover', 'banner', 'description', 'genres', 'score', 'scoreSource', 'year', 'format', 'episodeCount', 'status', 'nextAiringAt', 'nextEpisode', 'malId', 'kitsuId', 'anilistId', 'imdbId', 'imdbChart', 'introDuration', 'outroDuration', 'personalRating', 'franchiseId', 'franchiseTitle', 'franchiseOrder', 'franchiseType', 'franchiseSeasonNumber', 'movieSources'];
    for (const k of allowed) if (k in patch) s[k] = patch[k];
    s.updatedAt = Date.now();
    s.introDuration = nonNegativeSeconds(s.introDuration);
    s.outroDuration = nonNegativeSeconds(s.outroDuration);
    s.personalRating = personalRating(s.personalRating);
    this.save();
    return s;
  }

  deleteSeries(id) {
    if (!this.data.series.some((s) => s.id === id)) return;
    this.data.deletedSeries ||= [];
    this.data.deletedSeries.push({ id, deletedAt: Date.now() });
    this.data.series = this.data.series.filter((s) => s.id !== id);
    this.save();
  }

  ensureEpisode(s, number) {
    let ep = s.episodes.find((e) => e.number === number);
    if (!ep) {
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
      const ep = this.ensureEpisode(s, it.number);
      if (it.title && !ep.title) ep.title = it.title;
      const existing = ep.sources.find((source) => source.url === it.url);
      if (existing) {
        if (['animeunity', 'animeworld'].includes(it.provider)) existing.provider = it.provider;
        if (it.referer) existing.referer = it.referer;
        if (it.userAgent) existing.userAgent = it.userAgent;
      } else {
        ep.sources.push({ url: it.url, label: hostLabel(it.url), ...(['animeunity', 'animeworld'].includes(it.provider) ? { provider: it.provider } : {}), ...(it.referer ? { referer: it.referer } : {}), ...(it.userAgent ? { userAgent: it.userAgent } : {}) });
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
    ep.sources = [...new Set(urls)].map((url) => ({ url, label: hostLabel(url) }));
    ep.updatedAt = Date.now();
    const series = this.getSeries(sid); if (series) series.updatedAt = ep.updatedAt;
    this.save();
  }

  deleteEpisode(sid, eid) {
    const s = this.getSeries(sid);
    if (!s || !s.episodes.some((e) => e.id === eid)) return;
    this.data.deletedEpisodes ||= [];
    this.data.deletedEpisodes.push({ seriesId: sid, id: eid, deletedAt: Date.now() });
    s.episodes = s.episodes.filter((e) => e.id !== eid);
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
  mergeEpisodeMeta(sid, list) {
    const s = this.getSeries(sid);
    if (!s) return;
    for (const m of list) {
      const ep = this.ensureEpisode(s, m.number);
      const before = JSON.stringify(ep);
      if (m.title && !ep.title) ep.title = m.title;
      if (m.thumb && !ep.thumb) ep.thumb = m.thumb;
      if (m.duration != null && Number.isFinite(Number(m.duration))) ep.duration = Math.max(0, Number(m.duration) * (Number(m.duration) < 1000 ? 60 : 1));
      if (Array.isArray(m.skipTimes)) ep.skipTimes = m.skipTimes;
      if (m.rating != null && Number.isFinite(Number(m.rating))) { ep.rating = Number(m.rating); ep.ratingSource = m.ratingSource || 'IMDb'; }
      if (JSON.stringify(ep) !== before) ep.updatedAt = Date.now();
    }
    if (s.imdbChart && Array.isArray(s.imdbChart.seasons) && s.imdbChart.seasons.length > 0) {
      const { applyImdbRatingsToEpisodes } = require('./metadata');
      applyImdbRatingsToEpisodes(s.episodes, s.imdbChart, s.title);
    }
    s.updatedAt = Date.now();
    this.save();
  }

  refreshSeriesMetadata(sid, fields, list = []) {
    const s = this.getSeries(sid);
    if (!s) throw new Error('Serie non trovata');
    const allowed = ['title', 'altTitle', 'cover', 'banner', 'description', 'genres', 'cast', 'related', 'score', 'scoreSource', 'year', 'format', 'episodeCount', 'status', 'nextAiringAt', 'nextEpisode', 'malId', 'kitsuId', 'anilistId', 'imdbId', 'imdbChart', 'introDuration', 'outroDuration', 'personalRating'];
    for (const key of allowed) if (key in fields && fields[key] !== undefined) s[key] = fields[key];
    s.introDuration = nonNegativeSeconds(s.introDuration);
    s.outroDuration = nonNegativeSeconds(s.outroDuration);
    s.personalRating = personalRating(s.personalRating);
    const retainEpisode = (ep) => ep.sources.length > 0 || ep.progress.pos > 0 || ep.progress.duration > 0 || ep.progress.watched || ep.progress.updatedAt > 0;
    if (Number.isInteger(s.episodeCount) && s.episodeCount > 0 && s.episodeCount <= 300) {
      for (let n = 1; n <= s.episodeCount; n++) this.ensureEpisode(s, n);
      s.episodes = s.episodes.filter((ep) => ep.number <= s.episodeCount || retainEpisode(ep));
    }
    for (const m of list) {
      if (!Number.isInteger(m.number) || m.number < 0) continue;
      if (s.episodeCount > 0 && m.number > s.episodeCount) {
        const existing = s.episodes.find((e) => e.number === m.number);
        if (!existing || !retainEpisode(existing)) continue;
      }
      const ep = this.ensureEpisode(s, m.number);
      const before = JSON.stringify(ep);
      if (m.title) ep.title = m.title;
      if (m.thumb) ep.thumb = m.thumb;
      if (m.duration != null && Number.isFinite(Number(m.duration))) ep.duration = Math.max(0, Number(m.duration) * (Number(m.duration) < 1000 ? 60 : 1));
      if (Array.isArray(m.skipTimes)) ep.skipTimes = m.skipTimes;
      if (m.rating != null && Number.isFinite(Number(m.rating))) { ep.rating = Number(m.rating); ep.ratingSource = m.ratingSource || 'IMDb'; }
      if (JSON.stringify(ep) !== before) ep.updatedAt = Date.now();
    }
    if (s.imdbChart && Array.isArray(s.imdbChart.seasons) && s.imdbChart.seasons.length > 0) {
      const { applyImdbRatingsToEpisodes } = require('./metadata');
      applyImdbRatingsToEpisodes(s.episodes, s.imdbChart, s.title);
    }
    if (Number.isInteger(s.episodeCount) && s.episodeCount > 0 && s.episodeCount <= 300) {
      s.episodes = s.episodes.filter((ep) => ep.number <= s.episodeCount || retainEpisode(ep));
    }
    s.updatedAt = Date.now();
    this.save();
    return s;
  }

  statistics() {
    const activity = [];
    let watchedEpisodes = 0;
    let watchTime = 0;
    let completedSeries = 0;
    let episodesTotal = 0;
    const perSeries = [];
    for (const s of this.data.series) {
      const totalEpisodes = s.episodes.length;
      const watched = s.episodes.filter((e) => e.progress.watched);
      const seriesWatchTime = s.episodes.reduce((sum, e) => {
        if (e.progress.watched && e.progress.duration > 0) return sum + e.progress.duration;
        return sum + (!e.progress.watched && e.progress.pos > 0 ? e.progress.pos : 0);
      }, 0);
      const lastActivity = Math.max(s.lastWatchedAt || 0, ...s.episodes.map((e) => e.progress.updatedAt || 0));
      episodesTotal += totalEpisodes;
      watchedEpisodes += watched.length;
      watchTime += seriesWatchTime;
      for (const e of s.episodes) {
        if (e.progress.updatedAt) activity.push({
          seriesId: s.id, seriesTitle: s.title, episodeId: e.id, episodeNumber: e.number,
          title: e.title || `Episodio ${e.number}`, watched: e.progress.watched,
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
