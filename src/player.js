// Collega libreria, preset Anime4K e sessione mpv: riprende, salva il progresso, passa all'episodio dopo.
const fs = require('fs');
const path = require('path');
const { MpvSession, pipePath } = require('./mpv');
const A4K = require('./anime4k');
const { urlLifetime, redact } = require('./source-state');

class PlayerManager {
  // paths: { shaderDir, userData }; notify(channel, payload)
  constructor({ store, paths, notify, resolveAutomaticSource }) {
    this.store = store; this.paths = paths; this.notify = notify; this.cur = null;
    this.resolveAutomaticSource = resolveAutomaticSource;
    this.playRequestId = 0;
    this.inputConf = path.join(paths.userData, 'input.conf');
  }

  presetFor(series) { return (series && series.preset) || this.store.data.settings.defaultPreset || A4K.DEFAULT_PRESET; }

  _writeInputConf() {
    fs.mkdirSync(this.paths.userData, { recursive: true });
    fs.writeFileSync(this.inputConf, A4K.buildInputConf(this.paths.shaderDir, this.store.data.settings.shortcuts));
  }

  state() {
    if (!this.cur) return { playing: false };
    const { series, ep, presetId } = this.cur;
    return { playing: true, seriesId: series && series.id, episodeId: ep && ep.id, title: this.cur.title, preset: A4K.resolvePreset(presetId).label };
  }

  _emitState() { this.notify('player:state', this.state()); }

  async play(seriesId, episodeId, opts = {}) {
    const requestId = opts.requestId ?? ++this.playRequestId;
    const series = this.store.getSeries(seriesId);
    const ep = this.store.getEpisode(seriesId, episodeId);
    if (!series || !ep) throw new Error('Episodio non trovato');
    if (!ep.sources.length) throw new Error('Questo episodio non ha ancora link.');
    const title = `${series.title} — Ep. ${ep.number}${ep.title ? ' · ' + ep.title : ''}`;
    const resume = !ep.progress.watched && ep.progress.pos > 0 ? Math.max(0, ep.progress.pos) : 0;
    this.store.setProgress(seriesId, episodeId, {}); // aggiorna "ultima visione"
    const sourceIndex = opts.sourceIndex ?? 0;
    const source = ep.sources[sourceIndex];
    if (!source) throw new Error('Sorgente non trovata');
    const attempted = new Set(opts.attempted || []); attempted.add(source);
    if (source.provider && (urlLifetime(source.url).temporary || source.resolutionState === 'found')) {
      try {
        if (!this.resolveAutomaticSource) {
          const expiry = urlLifetime(source.url).expiresAt;
          if (source.resolutionState === 'found' || expiry && expiry <= Date.now()) throw new Error('Sorgente temporanea scaduta o URL multimediale non risolto');
        } else {
          const fresh = await this.resolveAutomaticSource(source, series, ep);
          if (requestId !== this.playRequestId) return;
          if (!fresh || fresh.resolutionState !== 'resolved') throw new Error('URL multimediale non risolto');
          if (!this.store.getEpisode(seriesId, episodeId)?.sources.includes(source)) return;
          if (!this.store.refreshSource(seriesId, episodeId, source, fresh)) throw new Error('Aggiornamento della sorgente non riuscito');
        }
      } catch (error) {
        if (requestId !== this.playRequestId) return;
        this.store.markSourceFailure(seriesId, episodeId, source.url, {error: error.message});
        return this._fallback({series, ep, sourceIndex, source, attempted, requestId}, redact(error.message));
      }
    }
    return this._launch({ series, ep, url: source.url, sourceIndex:ep.sources.indexOf(source), source, attempted, requestId, title, start: resume, referer: source.referer || series.referer, userAgent: source.userAgent, presetId: this.presetFor(series) });
  }

  async playUrl(url, presetId) {
    const title = url.split('/').pop() || url;
    return this._launch({ series: null, ep: null, url, sourceIndex: 0, requestId:++this.playRequestId, title, start: 0, referer: '', presetId: presetId || this.store.data.settings.defaultPreset });
  }

  async _launch(c) {
    const settings = this.store.data.settings;
    if (!settings.mpvPath) throw new Error('mpv non configurato: imposta il percorso in Impostazioni.');
    await this.stop({invalidate:false});
    if (c.requestId != null && c.requestId !== this.playRequestId) return;
    this._writeInputConf();
    const pipe = pipePath();
    const args = A4K.buildArgs({ settings: { ...settings, userAgent: c.userAgent || settings.userAgent }, presetId: c.presetId, startPos: c.start, title: c.title, referer: c.referer, url: c.url, inputConf: this.inputConf, pipe, shaderDir: this.paths.shaderDir });
    const session = new MpvSession({ mpvPath: settings.mpvPath, args, pipe });
    this.cur = { ...c, session, pos: c.start || 0, dur: 0, playedSeconds: 0, lastReportedPos: c.start || 0, lastSave: 0, saveTimer: null, nav: null, stopping: false, startedAt: Date.now() };
    const cur = this.cur;

    const flushProgress = () => {
      if (!cur.ep || cur.ep.progress.watched) return;
      clearTimeout(cur.saveTimer);
      cur.saveTimer = null;
      this.store.setProgress(cur.series.id, cur.ep.id, { pos: Math.max(0, cur.pos), duration: Math.max(0, cur.dur), watched: false });
      cur.lastSave = Date.now();
    };
    session.on('time', (t) => {
      if(cur.observedTime != null && t > cur.observedTime && cur.dur>0 && cur.ep && !cur.playbackVerified) {
        cur.playbackVerified=true;
        this.store.markSourcePlayback(cur.series.id,cur.ep.id,cur.url);
      }
      cur.observedTime = t;
      const delta = t - cur.lastReportedPos;
      if (delta > 0 && delta <= 5) cur.playedSeconds += delta;
      cur.lastReportedPos = t;
      cur.pos = t;
      if (cur.ep && !cur.ep.progress.watched) {
        clearTimeout(cur.saveTimer);
        cur.saveTimer = setTimeout(flushProgress, 750);
      }
      const skips = cur.ep && Array.isArray(cur.ep.skipTimes) ? cur.ep.skipTimes : [];
      if (this.store.data.settings.skipOpening && !cur.skippedIntro) {
        const segment = skips.find((x) => (x.skipType === 'op' || x.skipType === 'mixed-op') && t >= x.start && t < x.end);
        if (segment) { cur.skippedIntro = true; session.seekAbsolute(segment.end); }
      } else if (!cur.offeredIntro) {
        const segment = skips.find((x) => (x.skipType === 'op' || x.skipType === 'mixed-op') && t >= x.start && t < x.end);
        if (segment) { cur.offeredIntro = true; this.notify('player:skip-offer', { kind: 'intro', end: segment.end }); }
      }
      if (this.store.data.settings.skipEnding && !cur.skippedEnding) {
        const segment = skips.find((x) => (x.skipType === 'ed' || x.skipType === 'mixed-ed' || x.skipType === 'mixed-ending') && t >= x.start && t < x.end);
        if (segment) { cur.skippedEnding = true; session.seekAbsolute(segment.end); }
      } else if (!cur.offeredEnding) {
        const segment = skips.find((x) => (x.skipType === 'ed' || x.skipType === 'mixed-ed' || x.skipType === 'mixed-ending') && t >= x.start && t < x.end);
        if (segment) { cur.offeredEnding = true; this.notify('player:skip-offer', { kind: 'ending', end: segment.end }); }
      }
    });
    session.on('duration', (d) => { cur.dur = d; });
    session.on('nav', (dir) => { cur.nav = dir; session.quit(); });
    session.on('skip', (kind) => this.skipCurrentSegment(kind));
    session.on('spawn-error', (e) => {
      this.cur = null; this._emitState();
      this.notify('player:error', e.code === 'ENOENT' ? `mpv non trovato in "${settings.mpvPath}". Controlla il percorso in Impostazioni.` : `Impossibile avviare mpv: ${e.message}`);
    });
    session.on('exit', (r) => this._onExit(cur, r));
    session.start();
    this._emitState();
  }

  _onExit(cur, { eof, error, code, signal, stderr, stdout }) {
    if (this.cur !== cur) return; // già sostituita da un'altra sessione
    this.cur = null;
    if (cur.ep) {
      clearTimeout(cur.saveTimer);
      const { pos, dur } = cur;
      const watched = !error && (eof || (dur > 0 && pos / dur >= 0.92));
      if (cur.ep.progress.watched) this.store.setProgress(cur.series.id, cur.ep.id, { watched: true, pos: 0, duration: dur }, { forceSync: true });
      else this.store.setProgress(cur.series.id, cur.ep.id, watched ? { watched: true, pos: 0, duration: dur } : { watched: false, pos: Math.max(0, pos), duration: Math.max(0, dur) }, { forceSync: true });
      if (typeof this.onWatchSession === 'function') {
        try {
          this.onWatchSession({
            seriesId: cur.series.id,
            episodeId: cur.ep.id,
            startedAt: cur.startedAt,
            finishedAt: Date.now(),
            watchedSeconds: Math.max(0, cur.playedSeconds),
          });
        } catch (err) { console.warn('Salvataggio cronologia locale fallito:', err.message); }
      }
      this.store.save(true);
    }
    this._emitState();
    this.notify('lib:changed', this.store.snapshot());
    if (cur.stopping) return;

    if (cur.ep && error && !eof) {
      this.store.markSourceFailure(cur.series.id, cur.ep.id, cur.url, {error, code});
      this.notify('player:source-failed', { seriesId:cur.series.id, episodeId:cur.ep.id, provider:(cur.source || cur.ep.sources[cur.sourceIndex])?.provider, code, signal, error:redact(error), stderr:redact(stderr), stdout:redact(stdout) });
      this._fallback(cur, error).catch(e => this.notify('player:error', redact(e.message)));
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

  async _fallback(cur, error) {
    if (cur.requestId != null && cur.requestId !== this.playRequestId) return;
    const source = cur.source || cur.ep.sources[cur.sourceIndex];
    const attempted = new Set(cur.attempted || [source]);
    const provider = source?.provider;
    const remaining = cur.ep.sources.map((source, index) => ({source,index})).filter(item => !attempted.has(item.source));
    // Prefer the other provider over another cached token for the failed one.
    const next = remaining.find(item => item.source.provider !== provider) || remaining[0];
    if (!next) { this.notify('player:error', `Impossibile riprodurre il link: ${redact(error)}`); return; }
    this.notify('player:error', `Link non riproducibile (${redact(error)}). Provo la sorgente ${next.index + 1}…`);
    return this.play(cur.series.id, cur.ep.id, {sourceIndex:next.index, attempted, requestId:cur.requestId});
  }

  setPreset(presetId) {
    if (!this.cur) return;
    this.cur.presetId = presetId;
    const p = A4K.resolvePreset(presetId);
    this.cur.session.setShaders(A4K.shaderList(presetId, this.paths.shaderDir), p.label);
    this._emitState();
  }

  skipIntro() {
    if (!this.cur) return false;
    const skips = Array.isArray(this.cur.ep && this.cur.ep.skipTimes) ? this.cur.ep.skipTimes : [];
    const segment = skips.find((x) => ['op', 'mixed-op'].includes(x.skipType) && this.cur.pos >= x.start && this.cur.pos < x.end);
    if (segment) return this.skipSegment(segment.end);
    if (!this.cur.series || !this.cur.series.introDuration) return false;
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
    if (!this.cur) return false;
    const skips = Array.isArray(this.cur.ep && this.cur.ep.skipTimes) ? this.cur.ep.skipTimes : [];
    const segment = skips.find((x) => ['ed', 'mixed-ed', 'mixed-ending'].includes(x.skipType) && this.cur.pos >= x.start && this.cur.pos < x.end);
    if (segment) return this.skipSegment(segment.end);
    if (!this.cur.series || !this.cur.series.outroDuration || !this.cur.dur) return false;
    this.cur.session.seekAbsolute(Math.max(0, this.cur.dur - this.cur.series.outroDuration));
    return true;
  }

  skipSegment(end) {
    if (!this.cur || !Number.isFinite(Number(end))) return false;
    this.cur.session.seekAbsolute(Number(end));
    return true;
  }

  skipCurrentSegment(kind) {
    if (!this.cur) return false;
    const skips = Array.isArray(this.cur.ep && this.cur.ep.skipTimes) ? this.cur.ep.skipTimes : [];
    const types = kind === 'intro' ? ['op', 'mixed-op'] : ['ed', 'mixed-ed', 'mixed-ending'];
    const segment = skips.find((x) => types.includes(x.skipType) && this.cur.pos >= x.start && this.cur.pos < x.end);
    if (segment) return this.skipSegment(segment.end);
    return kind === 'intro' ? this.skipIntro() : this.skipEnding();
  }

  async stop({invalidate = true} = {}) {
    if (invalidate) this.playRequestId++;
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
