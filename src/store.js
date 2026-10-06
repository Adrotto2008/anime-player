// Libreria su file JSON, scrittura atomica con debounce.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hostLabel } = require('./patterns');

const DEFAULT_SETTINGS = {
  mpvPath: '',
  defaultPreset: 'aa-hq',
  autoplayNext: true,
  alang: 'jpn,ja,eng,en',
  slang: 'ita,it,eng,en',
  userAgent: '',
  extraArgs: '',
};

const uid = () => crypto.randomUUID();

class Store {
  constructor(file) {
    this.file = file;
    this.data = { settings: { ...DEFAULT_SETTINGS }, series: [] };
    this._timer = null;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data.series = Array.isArray(raw.series) ? raw.series : [];
      this.data.settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
      if (this.data.settings.defaultPreset === 'a-fast') this.data.settings.defaultPreset = DEFAULT_SETTINGS.defaultPreset;
    } catch { /* primo avvio o file rovinato: si parte da zero */ }
  }

  save(now = false) {
    clearTimeout(this._timer);
    const write = () => {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
        fs.renameSync(tmp, this.file);
      } catch (e) { console.error('Salvataggio libreria fallito:', e.message); }
    };
    if (now) write(); else this._timer = setTimeout(write, 400);
  }

  snapshot() { return JSON.parse(JSON.stringify(this.data)); }

  getSeries(id) { return this.data.series.find((s) => s.id === id); }
  getEpisode(sid, eid) { const s = this.getSeries(sid); return s && s.episodes.find((e) => e.id === eid); }

  setSettings(patch) { Object.assign(this.data.settings, patch); this.save(); }

  addSeries(meta = {}) {
    const s = {
      id: uid(), title: 'Senza titolo', anilistId: null, kitsuId: null, cover: null, banner: null,
      description: '', genres: [], score: null, year: null, format: null, episodeCount: null,
      preset: null, referer: '', addedAt: Date.now(), lastWatchedAt: 0, episodes: [], ...meta,
    };
    if (!Array.isArray(s.episodes)) s.episodes = [];
    this.data.series.push(s);
    this.save();
    return s;
  }

  updateSeries(id, patch) {
    const s = this.getSeries(id);
    if (!s) throw new Error('Serie non trovata');
    const allowed = ['title', 'preset', 'referer', 'cover', 'banner', 'description', 'genres', 'score', 'year', 'format', 'episodeCount', 'kitsuId', 'anilistId'];
    for (const k of allowed) if (k in patch) s[k] = patch[k];
    this.save();
    return s;
  }

  deleteSeries(id) { this.data.series = this.data.series.filter((s) => s.id !== id); this.save(); }

  ensureEpisode(s, number) {
    let ep = s.episodes.find((e) => e.number === number);
    if (!ep) {
      ep = { id: uid(), number, title: '', thumb: null, sources: [], progress: { pos: 0, duration: 0, watched: false, updatedAt: 0 } };
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
      if (!ep.sources.some((x) => x.url === it.url)) { ep.sources.push({ url: it.url, label: hostLabel(it.url) }); added++; }
    }
    this.save();
    return added;
  }

  setSources(sid, eid, urls) {
    const ep = this.getEpisode(sid, eid);
    if (!ep) throw new Error('Episodio non trovato');
    ep.sources = [...new Set(urls)].map((url) => ({ url, label: hostLabel(url) }));
    this.save();
  }

  deleteEpisode(sid, eid) { const s = this.getSeries(sid); if (s) { s.episodes = s.episodes.filter((e) => e.id !== eid); this.save(); } }

  markWatched(sid, eid, watched) {
    const ep = this.getEpisode(sid, eid);
    if (!ep) return;
    ep.progress = { ...ep.progress, watched, pos: 0, updatedAt: Date.now() };
    this.save();
  }

  setProgress(sid, eid, p) {
    const s = this.getSeries(sid); const ep = this.getEpisode(sid, eid);
    if (!ep) return;
    ep.progress = { ...ep.progress, ...p, updatedAt: Date.now() };
    s.lastWatchedAt = Date.now();
    this.save();
  }

  // Unisce titoli/miniature trovati online senza toccare link e progresso
  mergeEpisodeMeta(sid, list) {
    const s = this.getSeries(sid);
    if (!s) return;
    for (const m of list) {
      const ep = this.ensureEpisode(s, m.number);
      if (m.title && !ep.title) ep.title = m.title;
      if (m.thumb && !ep.thumb) ep.thumb = m.thumb;
    }
    this.save();
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
