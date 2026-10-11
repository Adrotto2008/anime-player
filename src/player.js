// Collega libreria, preset Anime4K e sessione mpv: riprende, salva il progresso, passa all'episodio dopo.
const fs = require('fs');
const path = require('path');
const { MpvSession, pipePath } = require('./mpv');
const A4K = require('./anime4k');
const { urlLifetime, redact } = require('./source-state');
const Language = require('./source-language');
const Franchise = require('./franchise-model');
const { randomUUID } = require('crypto');
const Identity = require('./content-identity');
const {PlaybackDiagnostics,exitMessage}=require('./playback-diagnostics');

class PlayerManager {
  // paths: { shaderDir, userData }; notify(channel, payload)
  constructor({ store, paths, notify, resolveAutomaticSource, progressIntervalMs = 5000 }) {
    this.store = store; this.paths = paths; this.notify = notify; this.cur = null;
    this.resolveAutomaticSource = resolveAutomaticSource;
    this.playRequestId = 0;
    this.progressIntervalMs = progressIntervalMs;
    this.diagnostics = new PlaybackDiagnostics(paths.userData);
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

  _recordDiagnostic(cur,result) {
    if(cur.diagnosticRecorded)return;
    cur.diagnosticRecorded=true;
    try {this.diagnostics.record(cur,result);} catch(error) {console.warn('Diagnostica player non salvata:',redact(error.message));}
  }

  beginRequest(seriesId = null, episodeId = null) {
    const request = {requestId:++this.playRequestId, scope:this.store.scope, seriesId, episodeId};
    this._clearLanguageFallback();
    this.activeRequest = request;
    return request;
  }

  isRequestActive(request) {
    return !this.shuttingDown && request.requestId === this.playRequestId && request.scope === this.store.scope
      && (!request.seriesId || !!this.store.getEpisode(request.seriesId, request.episodeId));
  }

  async play(seriesId, episodeId, opts = {}) {
    const request = opts.requestId == null ? this.beginRequest(seriesId, episodeId)
      : {requestId:opts.requestId, scope:opts.scope ?? this.store.scope, seriesId, episodeId};
    if (!this.isRequestActive(request)) return;
    const {requestId, scope} = request;
    let series = this.store.getSeries(seriesId);
    let ep = this.store.getEpisode(seriesId, episodeId);
    if (!series || !ep) throw new Error('Episodio non trovato');
    if (this.store._deletingFranchises?.has(series.franchiseId)) throw new Error('Eliminazione del franchise in corso.');
    if (!ep.sources.length) throw new Error('Questo episodio non ha ancora link.');
    this.activeRequest = request;
    const title = `${series.title}${ep.kind === 'part' ? ep.title ? ' · '+ep.title : '' : ' — Ep. '+ep.number+(ep.title ? ' · '+ep.title : '')}`;
    const resume = !ep.progress.watched && ep.progress.pos > 0 ? Math.max(0, ep.progress.pos) : 0;
    const effectiveMode = opts.effectiveMode || Language.preference(series.videoPreference)?.mode || 'auto';
    const attempted = this._attempted(episodeId,opts.attempted);
    const ranked = Language.rankSources(ep.sources, effectiveMode).filter(item => !attempted.has(Identity.sourceId(episodeId,item.source)));
    const sourceIndex = opts.sourceIndex ?? ranked[0]?.index;
    let source = opts.sourceId?this.store.getSource(seriesId,episodeId,opts.sourceId):ep.sources[sourceIndex];
    if (!source || !Language.eligible(source, effectiveMode)) return this._offerLanguageFallback({series,ep,scope,requestId,attempted,effectiveMode});
    this.store.setProgress(seriesId, episodeId, {}); // aggiorna "ultima visione"
    const sourceId=Identity.sourceId(episodeId,source);
    attempted.add(sourceId);
    if (source.provider && (urlLifetime(source.url).temporary || source.resolutionState === 'found')) {
      try {
        if (!this.resolveAutomaticSource) {
          const expiry = urlLifetime(source.url).expiresAt;
          if (source.resolutionState === 'found' || expiry && expiry <= Date.now()) throw new Error('Sorgente temporanea scaduta o URL multimediale non risolto');
        } else {
          const fresh = await this.resolveAutomaticSource(source, series, ep);
          if (requestId !== this.playRequestId) return;
          if(scope!==this.store.scope) {this.activeRequest=null;return;}
          if (!fresh || fresh.resolutionState !== 'resolved') throw new Error('URL multimediale non risolto');
          series=this.store.getSeries(seriesId);ep=this.store.getEpisode(seriesId,episodeId);
          source=this.store.getSource(seriesId,episodeId,sourceId);
          if(!series || !ep || !source) {this.activeRequest=null;return;}
          if (!this.store.refreshSource(seriesId, episodeId, sourceId, fresh)) throw new Error('Aggiornamento della sorgente non riuscito');
        }
      } catch (error) {
        if (requestId !== this.playRequestId) return;
        if(scope!==this.store.scope) {this.activeRequest=null;return;}
        this.store.markSourceFailure(seriesId, episodeId, source?.url, {error: error.message});
        return this._fallback({series, ep, scope, sourceIndex, source, attempted, requestId, effectiveMode}, redact(error.message));
      }
    }
    if (!Language.eligible(source, effectiveMode)) return this._fallback({series,ep,scope,source,sourceIndex,attempted,requestId,effectiveMode}, 'La lingua della sorgente rinnovata non corrisponde');
    return this._launch({ series, ep, scope, url: source.url, sourceIndex:ep.sources.findIndex(s=>Identity.sourceId(episodeId,s)===sourceId), source, attempted, requestId, effectiveMode, title, start: resume, referer: source.referer || series.referer, userAgent: source.userAgent, presetId: this.presetFor(series) });
  }

  _attempted(unitId,values=[]) { return new Set([...values].map(value=>typeof value==='string'?value:Identity.sourceId(unitId,value))); }
  _live(cur) {
    if(cur.scope!=null && cur.scope!==this.store.scope)return false;
    if(!cur.ep)return true;
    const series=this.store.getSeries(cur.series.id),ep=this.store.getEpisode(cur.series.id,cur.ep.id);
    if(!series || !ep)return false;
    cur.series=series;cur.ep=ep;
    if(cur.source)cur.source=this.store.getSource(series.id,ep.id,cur.source) || cur.source;
    return true;
  }

  async playUrl(url, presetId, request = this.beginRequest()) {
    if (!this.isRequestActive(request)) return;
    const title = redact(url.split('/').pop() || url).split('?')[0];
    return this._launch({ series: null, ep: null, url, scope:request.scope, sourceIndex: 0, requestId:request.requestId, title, start: 0, referer: '', presetId: presetId || this.store.data.settings.defaultPreset });
  }

  async _launch(c) {
    const settings = this.store.data.settings;
    if (!settings.mpvPath) throw new Error('mpv non configurato: imposta il percorso in Impostazioni.');
    if (this.shuttingDown || c.requestId !== this.playRequestId || !this._live(c)) return;
    await this.stop({invalidate:false,reason:'replaced'});
    if (c.requestId != null && c.requestId !== this.playRequestId) return;
    if(!this._live(c)) {this.activeRequest=null;return;}
    if(c.ep && !this.store.getSource(c.series.id,c.ep.id,c.source)) {this.activeRequest=null;return;}
    this._writeInputConf();
    const pipe = pipePath();
    const args = A4K.buildArgs({ settings: { ...settings, userAgent: c.userAgent || settings.userAgent }, presetId: c.presetId, startPos: c.start, title: c.title, referer: c.referer, url: c.url, inputConf: this.inputConf, pipe, shaderDir: this.paths.shaderDir });
    const strictLanguage = ['it', 'ja-sub-it'].includes(c.effectiveMode);
    if (strictLanguage) args.splice(args.length - 2, 0, '--pause=yes', `--alang=${c.effectiveMode === 'it' ? 'it,ita' : 'ja,jpn'}`, '--slang=it,ita');
    const session = new MpvSession({ mpvPath: settings.mpvPath, args, pipe });
    this.cur = { ...c, session, pos: c.start || 0, dur: 0, playedSeconds: 0, lastReportedPos: c.start || 0, lastSave: 0, saveTimer: null, nav: null, stopping: false, startedAt: Date.now() };
    const cur = this.cur;
    if (strictLanguage) cur.languageTimer = setTimeout(() => {
      session.error = 'Impossibile rilevare le tracce del file'; session.quit('track-timeout');
    }, 15000);
    session.on('tracks', list => {
      if (this.cur !== cur || cur.stopping || !list.length || !this._live(cur)) return;
      if (cur.ep) this.store.recordSourceTracks(cur.series.id, cur.ep.id, cur.source, list);
      if (!strictLanguage || cur.languageReady) return;
      const selection = Language.trackSelection(list, c.effectiveMode, cur.source);
      clearTimeout(cur.languageTimer);
      cur.languageReady = true;
      if (selection.error) { session.error = selection.error; session.quit('source-error'); return; }
      if (selection.warning) this.notify('player:language-warning', selection.warning);
      selection.commands.forEach(command => session.send(command));
      session.send(['set_property', 'pause', false]);
    });

    const flushProgress = () => this._flushProgress(cur);
    const scheduleCheckpoint = () => {
      if (!cur.saveTimer) cur.saveTimer = setTimeout(() => {cur.saveTimer=null;flushProgress();},250);
    };
    cur.saveInterval = setInterval(flushProgress, this.progressIntervalMs);
    cur.saveInterval.unref?.();
    session.on('pause', paused => {if(this.cur===cur && paused) {flushProgress();scheduleCheckpoint();}});
    session.on('seek', () => {cur.seeking=true;});
    session.on('seeked', () => {if(this.cur===cur && cur.seeking) {cur.seeking=false;scheduleCheckpoint();}});
    session.on('time', (t) => {
      if(this.cur!==cur || !Number.isFinite(t))return;
      if(!this._live(cur)) {session.quit('account-change');return;}
      if(cur.observedTime != null && t > cur.observedTime && cur.dur>0 && cur.ep && !cur.playbackVerified) {
        cur.playbackVerified=true;
        this.store.markSourcePlayback(cur.series.id,cur.ep.id,cur.url);
      }
      cur.observedTime = t;
      const delta = t - cur.lastReportedPos;
      if (delta > 0 && delta <= 5) cur.playedSeconds += delta;
      cur.lastReportedPos = t;
      cur.pos = t;
      if (Math.abs(delta) >= 5) scheduleCheckpoint();
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
    session.on('duration', (d) => { if(this.cur===cur && Number.isFinite(d))cur.dur = d; });
    session.on('nav', (dir) => { if(cur.requestId!==this.playRequestId)return;cur.nav = dir; session.quit('navigation'); });
    session.on('skip', (kind) => {if(this.cur===cur && cur.requestId===this.playRequestId)this.skipCurrentSegment(kind);});
    session.on('spawn-error', (e) => {
      clearTimeout(cur.languageTimer);
      clearInterval(cur.saveInterval);clearTimeout(cur.saveTimer);
      if (this.activeRequest?.requestId === cur.requestId) this.activeRequest = null;
      this._recordDiagnostic(cur,{reason:'spawn-error',error:redact(e.message),code:e.code});
      if(this.cur!==cur)return;
      this.cur = null; this._emitState();
      this.notify('player:error', e.code === 'ENOENT' ? `mpv non trovato in "${settings.mpvPath}". Controlla il percorso in Impostazioni.` : `Impossibile avviare mpv: ${redact(e.message)}`);
    });
    session.on('exit', (r) => this._onExit(cur, r));
    session.start();
    this._emitState();
  }

  _flushProgress(cur, {final=false,eof=false,error=null} = {}) {
    if (!cur.ep || !this._live(cur) || (!final && cur.ep.progress.watched)) return;
    const previous=cur.ep.progress;
    const watched=previous.watched || (final && !error && (eof || (cur.dur>0 && cur.pos/cur.dur>=0.92)));
    const progress={pos:watched?0:Math.max(0,cur.pos),duration:Math.max(0,cur.dur || previous.duration || 0),watched:!!watched};
    const key=JSON.stringify(progress);
    if(cur.lastCheckpoint===key && !cur.saveError && previous.pos===progress.pos && previous.duration===progress.duration && previous.watched===progress.watched)return;
    if(previous.pos!==progress.pos || previous.duration!==progress.duration || previous.watched!==progress.watched)
      this.store.setProgress(cur.series.id,cur.ep.id,progress,{forceSync:final});
    try {
      // setProgress owns the local revision. Flushing its write must not create another revision or clear cloudDirty.
      this.store.save(true,true,{cloud:true});
      cur.lastCheckpoint=key;cur.lastSave=Date.now();cur.saveError=false;
    } catch(error) {
      if(!cur.saveError)this.notify('player:error',`Impossibile salvare il progresso: ${redact(error.message)}`);
      cur.saveError=true;
    }
  }

  _onExit(cur, result) {
    const { eof, error, code, signal, stderr, stdout } = result;
    clearTimeout(cur.languageTimer);
    clearInterval(cur.saveInterval);clearTimeout(cur.saveTimer);
    this._recordDiagnostic(cur,result);
    if (this.cur !== cur) return; // già sostituita da un'altra sessione
    const live=this._live(cur);
    this.cur = null;
    if (this.activeRequest?.requestId === cur.requestId) this.activeRequest = null;
    if (cur.ep && live) {
      this._flushProgress(cur,{final:true,eof,error});
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
      if(typeof this.onWatchSession==='function')this.store.save(true,false,{cloud:true});
    }
    this._emitState();
    this.notify('lib:changed', this.store.snapshot());
    if (cur.stopping || !live || this.shuttingDown || (cur.requestId!=null && cur.requestId!==this.playRequestId)) return;

    if(error && (!cur.ep || ['ipc-timeout','ipc-disconnected','abnormal','unknown-exit'].includes(result.reason))) {
      this.notify('player:error',exitMessage(result));return;
    }

    if (cur.ep && error && !eof) {
      this.store.markSourceFailure(cur.series.id, cur.ep.id, cur.url, {error, code});
      this.notify('player:source-failed', { seriesId:cur.series.id, episodeId:cur.ep.id, provider:(cur.source || cur.ep.sources[cur.sourceIndex])?.provider, code, signal, error:redact(error), stderr:redact(stderr), stdout:redact(stdout) });
      this._fallback(cur, error).catch(e => this.notify('player:error', redact(e.message)));
      return;
    }
    if (!cur.ep) return;
    const eps = cur.ep.kind === 'part' ? (cur.series.mediaParts || []).filter(p=>p.layout === cur.ep.layout).sort((a,b)=>Franchise.partOrder(a)-Franchise.partOrder(b)) : cur.series.episodes;
    const i = eps.findIndex((e) => e.id === cur.ep.id);
    let target = null;
    if (cur.nav === 'next' || (eof && this.store.data.settings.autoplayNext)) target = eps.slice(i + 1).find((e) => e.sources.length);
    else if (cur.nav === 'prev') target = eps.slice(0, i).reverse().find((e) => e.sources.length);
    if (target) this.play(cur.series.id, target.id).catch((e) => this.notify('player:error', e.message));
  }

  async _fallback(cur, error) {
    if (cur.requestId != null && cur.requestId !== this.playRequestId) return;
    if(!this._live(cur)) {this.activeRequest=null;return;}
    const source = cur.source || cur.ep.sources[cur.sourceIndex];
    const attempted = this._attempted(cur.ep.id,cur.attempted || [source]);
    const provider = source?.provider;
    const effectiveMode = cur.effectiveMode || Language.preference(cur.series.videoPreference)?.mode || 'auto';
    const remaining = Language.rankSources(cur.ep.sources, effectiveMode).filter(item => !attempted.has(Identity.sourceId(cur.ep.id,item.source)));
    // Prefer the other provider over another cached token for the failed one.
    const next = effectiveMode === 'auto' ? remaining.find(item => item.source.provider !== provider) || remaining[0] : remaining[0];
    if (!next) {
      if (effectiveMode !== 'auto') return this._offerLanguageFallback({...cur,attempted,effectiveMode});
      this.notify('player:error', `Impossibile riprodurre il link: ${redact(error)}`); return;
    }
    this.notify('player:error', `Link non riproducibile (${redact(error)}). Provo la sorgente ${next.index + 1}…`);
    return this.play(cur.series.id, cur.ep.id, {sourceIndex:next.index,sourceId:Identity.sourceId(cur.ep.id,next.source), attempted, requestId:cur.requestId, scope:cur.scope, effectiveMode});
  }

  _clearLanguageFallback() {
    if (this.pendingLanguageFallback) this.notify('player:language-fallback', {token:this.pendingLanguageFallback.token,cancelled:true});
    this.pendingLanguageFallback = null;
  }

  async _offerLanguageFallback(cur) {
    if (cur.requestId !== this.playRequestId || !this._live(cur)) return;
    await this.stop({invalidate:false,reason:'replaced'});
    if (cur.requestId !== this.playRequestId || !this._live(cur)) return;
    cur.attempted=this._attempted(cur.ep.id,cur.attempted);
    const remaining = cur.ep.sources.filter(source => !cur.attempted.has(Identity.sourceId(cur.ep.id,source)));
    const choices = ['it','ja-sub-it','unknown'].filter(mode => mode !== cur.effectiveMode && remaining.some(source => Language.usable(source) && Language.eligible(source,mode)));
    if (!choices.length) { this.notify('player:error','Nessuna sorgente riproducibile per la versione richiesta. Cerca nuovi link o aggiungi una sorgente.'); return; }
    this._clearLanguageFallback();
    const token = randomUUID();
    this.pendingLanguageFallback = {...cur,token,choices,preferenceAt:cur.series.videoPreference?.updatedAt || 0,preferenceMode:cur.series.videoPreference?.mode || 'auto'};
    this.notify('player:language-fallback',{token,seriesId:cur.series.id,episodeId:cur.ep.id,requested:cur.effectiveMode,choices});
  }

  acceptLanguageFallback(token, mode) {
    const pending = this.pendingLanguageFallback;
    if (!pending || pending.token !== token) return false;
    this._clearLanguageFallback();
    if (mode == null) return false;
    const series = this.store.getSeries(pending.series.id);
    if (!this._live(pending) || pending.requestId !== this.playRequestId || !series || (series.videoPreference?.updatedAt || 0) !== pending.preferenceAt
      || (series.videoPreference?.mode || 'auto') !== pending.preferenceMode || !pending.choices.includes(mode)) return false;
    return this.play(series.id,pending.ep.id,{requestId:pending.requestId,scope:pending.scope,attempted:pending.attempted,effectiveMode:mode});
  }

  async changeVideoPreference(seriesId, mode) {
    const episodeId = this.cur?.series?.id === seriesId ? this.cur.ep?.id : this.activeRequest?.seriesId === seriesId ? this.activeRequest.episodeId : null;
    this.store.setVideoPreference(seriesId,mode);
    const stopped = this.stopIfSeries(seriesId,{reason:'replaced'}); const requestId = this.playRequestId;
    await stopped;
    if (episodeId && requestId === this.playRequestId) return this.play(seriesId,episodeId);
  }

  async stopIfSeries(seriesId,{reason='deleted'}={}) {
    if (this.cur?.series?.id === seriesId || this.pendingLanguageFallback?.series.id === seriesId || this.activeRequest?.seriesId === seriesId) await this.stop({reason});
  }

  async stopIfUnit(seriesId, episodeId) {
    if ((this.cur?.series?.id === seriesId && this.cur.ep?.id === episodeId)
      || (this.activeRequest?.seriesId === seriesId && this.activeRequest.episodeId === episodeId)
      || (this.pendingLanguageFallback?.series.id === seriesId && this.pendingLanguageFallback.ep.id === episodeId)) await this.stop({reason:'deleted'});
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

  async stop({invalidate = true,reason = 'app-stop'} = {}) {
    if (invalidate) { this.playRequestId++; this.activeRequest = null; this._clearLanguageFallback(); }
    const cur = this.cur;
    if (!cur) return;
    if(cur.stopPromise)return cur.stopPromise;
    clearTimeout(cur.languageTimer);
    clearInterval(cur.saveInterval);clearTimeout(cur.saveTimer);cur.saveTimer=null;
    this._flushProgress(cur);
    cur.stopPromise = new Promise((resolve,reject) => {
      const done=()=>{clearTimeout(timer);cur.session.removeListener('exit',done);cur.session.removeListener('spawn-error',done);resolve();};
      const timer=setTimeout(()=>{cur.session.removeListener('exit',done);cur.session.removeListener('spawn-error',done);cur.stopPromise=null;
        this._flushProgress(cur);
        reject(new Error('mpv non ha confermato la chiusura. Controlla il player e la diagnostica.'));},2500);
      cur.session.once('exit', done);
      cur.session.once('spawn-error', done);
      cur.stopping = true; cur.nav = null;
      cur.stopReason=reason;
      cur.session.quit(reason);
    });
    return cur.stopPromise;
  }
}

module.exports = { PlayerManager };
