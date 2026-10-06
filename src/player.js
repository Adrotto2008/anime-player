// Collega libreria, preset Anime4K e sessione mpv: riprende, salva il progresso, passa all'episodio dopo.
const fs = require('fs');
const path = require('path');
const { MpvSession, pipePath } = require('./mpv');
const A4K = require('./anime4k');

class PlayerManager {
  // paths: { shaderDir, userData }; notify(channel, payload)
  constructor({ store, paths, notify }) {
    this.store = store; this.paths = paths; this.notify = notify; this.cur = null;
    this.inputConf = path.join(paths.userData, 'input.conf');
  }

  presetFor(series) { return (series && series.preset) || this.store.data.settings.defaultPreset || A4K.DEFAULT_PRESET; }

  _writeInputConf() {
    fs.mkdirSync(this.paths.userData, { recursive: true });
    fs.writeFileSync(this.inputConf, A4K.buildInputConf(this.paths.shaderDir));
  }

  state() {
    if (!this.cur) return { playing: false };
    const { series, ep, presetId } = this.cur;
    return { playing: true, seriesId: series && series.id, episodeId: ep && ep.id, title: this.cur.title, preset: A4K.resolvePreset(presetId).label };
  }

  _emitState() { this.notify('player:state', this.state()); }

  async play(seriesId, episodeId, opts = {}) {
    const series = this.store.getSeries(seriesId);
    const ep = this.store.getEpisode(seriesId, episodeId);
    if (!series || !ep) throw new Error('Episodio non trovato');
    if (!ep.sources.length) throw new Error('Questo episodio non ha ancora link.');
    const title = `${series.title} — Ep. ${ep.number}${ep.title ? ' · ' + ep.title : ''}`;
    const resume = !ep.progress.watched && ep.progress.pos > 0 ? Math.max(0, ep.progress.pos) : 0;
    this.store.setProgress(seriesId, episodeId, {}); // aggiorna "ultima visione"
    return this._launch({ series, ep, url: ep.sources[opts.sourceIndex || 0].url, sourceIndex: opts.sourceIndex || 0, title, start: resume, referer: series.referer, presetId: this.presetFor(series) });
  }

  async playUrl(url, presetId) {
    const title = url.split('/').pop() || url;
    return this._launch({ series: null, ep: null, url, sourceIndex: 0, title, start: 0, referer: '', presetId: presetId || this.store.data.settings.defaultPreset });
  }

  async _launch(c) {
    const settings = this.store.data.settings;
    if (!settings.mpvPath) throw new Error('mpv non configurato: imposta il percorso in Impostazioni.');
    await this.stop();
    this._writeInputConf();
    const pipe = pipePath();
    const args = A4K.buildArgs({ settings, presetId: c.presetId, startPos: c.start, title: c.title, referer: c.referer, url: c.url, inputConf: this.inputConf, pipe, shaderDir: this.paths.shaderDir });
    const session = new MpvSession({ mpvPath: settings.mpvPath, args, pipe });
    this.cur = { ...c, session, pos: c.start || 0, dur: 0, lastSave: 0, saveTimer: null, nav: null, stopping: false };
    const cur = this.cur;

    const flushProgress = () => {
      if (!cur.ep || cur.ep.progress.watched) return;
      clearTimeout(cur.saveTimer);
      cur.saveTimer = null;
      this.store.setProgress(cur.series.id, cur.ep.id, { pos: Math.max(0, cur.pos), duration: Math.max(0, cur.dur), watched: false });
      cur.lastSave = Date.now();
    };
    session.on('time', (t) => {
      cur.pos = t;
      if (cur.ep && !cur.ep.progress.watched) {
        clearTimeout(cur.saveTimer);
        cur.saveTimer = setTimeout(flushProgress, 750);
      }
    });
    session.on('duration', (d) => { cur.dur = d; });
    session.on('nav', (dir) => { cur.nav = dir; session.quit(); });
    session.on('spawn-error', (e) => {
      this.cur = null; this._emitState();
      this.notify('player:error', e.code === 'ENOENT' ? `mpv non trovato in "${settings.mpvPath}". Controlla il percorso in Impostazioni.` : `Impossibile avviare mpv: ${e.message}`);
    });
    session.on('exit', (r) => this._onExit(cur, r));
    session.start();
    this._emitState();
  }

  _onExit(cur, { eof, error }) {
    if (this.cur !== cur) return; // già sostituita da un'altra sessione
    this.cur = null;
    if (cur.ep) {
      clearTimeout(cur.saveTimer);
      const { pos, dur } = cur;
      const watched = eof || (dur > 0 && pos / dur >= 0.92);
      if (cur.ep.progress.watched) this.store.setProgress(cur.series.id, cur.ep.id, { watched: true, pos: 0, duration: dur });
      else this.store.setProgress(cur.series.id, cur.ep.id, watched ? { watched: true, pos: 0, duration: dur } : { watched: false, pos: Math.max(0, pos), duration: Math.max(0, dur) });
      this.store.save(true);
    }
    this._emitState();
    this.notify('lib:changed', this.store.snapshot());
    if (cur.stopping) return;

    if (cur.ep && error && !eof) {
      const next = cur.sourceIndex + 1;
      if (next < cur.ep.sources.length) {
        this.notify('player:error', `Link non riproducibile (${error}). Provo la sorgente ${next + 1}…`);
        this.play(cur.series.id, cur.ep.id, { sourceIndex: next }).catch((e) => this.notify('player:error', e.message));
      } else this.notify('player:error', `Impossibile riprodurre il link: ${error}`);
      return;
    }
    if (!cur.ep) return;
    const eps = cur.series.episodes;
    const i = eps.findIndex((e) => e.id === cur.ep.id);
    let target = null;
    if (cur.nav === 'next' || (eof && this.store.data.settings.autoplayNext)) target = eps.slice(i + 1).find((e) => e.sources.length);
    else if (cur.nav === 'prev') target = eps.slice(0, i).reverse().find((e) => e.sources.length);
    if (target) this.play(cur.series.id, target.id).catch((e) => this.notify('player:error', e.message));
  }

  setPreset(presetId) {
    if (!this.cur) return;
    this.cur.presetId = presetId;
    const p = A4K.resolvePreset(presetId);
    this.cur.session.setShaders(A4K.shaderList(presetId, this.paths.shaderDir), p.label);
    this._emitState();
  }

  skipIntro() {
    if (!this.cur || !this.cur.series || !this.cur.series.introDuration) return false;
    this.cur.session.seekAbsolute(this.cur.series.introDuration);
    return true;
  }

  seekRelative(seconds) {
    if (!this.cur) return false;
    this.cur.session.seekRelative(seconds);
    return true;
  }

  seekAbsolute(seconds) {
    if (!this.cur) return false;
    this.cur.session.seekAbsolute(seconds);
    return true;
  }

  skipEnding() {
    if (!this.cur || !this.cur.series || !this.cur.series.outroDuration || !this.cur.dur) return false;
    this.cur.session.seekAbsolute(Math.max(0, this.cur.dur - this.cur.series.outroDuration));
    return true;
  }

  async stop() {
    const cur = this.cur;
    if (!cur) return;
    await new Promise((resolve) => {
      cur.session.once('exit', resolve);
      cur.session.once('spawn-error', resolve);
      cur.stopping = true; cur.nav = null;
      cur.session.quit();
    });
  }
}

module.exports = { PlayerManager };
