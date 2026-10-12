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
const Shortcuts=require('./playback-shortcuts');
const {decideSkip,NEAR_SECONDS}=require('./skip-decision');
const {PlaybackDiagnostics,exitMessage}=require('./playback-diagnostics');

class PlayerManager {
  // paths: { shaderDir, userData }; notify(channel, payload)
  constructor({ store, paths, notify, resolveAutomaticSource, prepareSource=require('./source-engine').prepareSource,
    progressIntervalMs = 5000, stallTimeoutMs=5000, stallPollMs=1000 }) {
    this.store = store; this.paths = paths; this.notify = notify; this.cur = null;
    this.resolveAutomaticSource = resolveAutomaticSource;
    this.prepareSource=prepareSource;this.stallTimeoutMs=stallTimeoutMs;this.stallPollMs=stallPollMs;
    this.playRequestId = 0;
    this.progressIntervalMs = progressIntervalMs;
    this.diagnostics = new PlaybackDiagnostics(paths.userData);
    const sync=()=>this._syncShortcuts();
    store.on('settings',sync);
    store.on('settings:applied',sync);
  }

  presetFor(series) { return (series && series.preset) || this.store.data.settings.defaultPreset || A4K.DEFAULT_PRESET; }

  _writeShortcutScript() {
    fs.mkdirSync(this.paths.userData,{recursive:true});
    const script=path.join(this.paths.userData,'ap_shortcuts.lua');
    fs.writeFileSync(script,fs.readFileSync(path.join(__dirname,'ap-shortcuts.lua')));
    return script;
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
    this.activeRequest?.controller?.abort();
    const request = {requestId:++this.playRequestId, scope:this.store.scope, seriesId, episodeId};
    request.controller=new AbortController();
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
      : {requestId:opts.requestId, scope:opts.scope ?? this.store.scope, seriesId, episodeId,
        controller:opts.controller || this.activeRequest?.controller || new AbortController()};
    if (!this.isRequestActive(request)) return;
    const {requestId, scope} = request;
    let series = this.store.getSeries(seriesId);
    let ep = this.store.getEpisode(seriesId, episodeId);
    if (!series || !ep) throw new Error('Episodio non trovato');
    if (this.store._deletingFranchises?.has(series.franchiseId)) throw new Error('Eliminazione del franchise in corso.');
    if (!ep.sources.length) throw new Error('Questo episodio non ha ancora link.');
    this.activeRequest = request;
    const title = `${series.title}${ep.kind === 'part' ? ep.title ? ' · '+ep.title : '' : ' — Ep. '+ep.number+(ep.title ? ' · '+ep.title : '')}`;
    const resume = opts.resumePos ?? (!ep.progress.watched && ep.progress.pos > 0 ? Math.max(0, ep.progress.pos) : 0);
    const effectiveMode = opts.effectiveMode || Language.preference(series.videoPreference)?.mode || 'auto';
    const attempted = this._attempted(episodeId,opts.attempted);
    const ranked = Language.rankSources(ep.sources, effectiveMode).filter(item => !attempted.has(Identity.sourceId(episodeId,item.source)));
    const sourceIndex = opts.sourceIndex ?? ranked[0]?.index;
    let source = opts.sourceId?this.store.getSource(seriesId,episodeId,opts.sourceId):ep.sources[sourceIndex];
    if (!source || !Language.eligible(source, effectiveMode)) return this._offerLanguageFallback({series,ep,scope,requestId,attempted,effectiveMode});
    this.store.setProgress(seriesId, episodeId, {}); // aggiorna "ultima visione"
    const sourceId=Identity.sourceId(episodeId,source);
    attempted.add(sourceId);
    const recovery={resumePos:resume,expectedDuration:opts.expectedDuration,renewed:opts.renewed||new Set(),controller:request.controller};
    if (source.provider && (opts.forceRenew || urlLifetime(source.url).temporary || source.resolutionState === 'found')) {
      try {
        if (!this.resolveAutomaticSource) {
          const expiry = urlLifetime(source.url).expiresAt;
          if (source.resolutionState === 'found' || expiry && expiry <= Date.now()) throw new Error('Sorgente temporanea scaduta o URL multimediale non risolto');
        } else {
          const fresh = await this.resolveAutomaticSource(source, series, ep,{signal:request.controller.signal});
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
        return this._fallback({series, ep, scope, sourceIndex, source, attempted, requestId, effectiveMode,...recovery}, redact(error.message));
      }
    }
    if (!Language.eligible(source, effectiveMode)) return this._fallback({series,ep,scope,source,sourceIndex,attempted,requestId,effectiveMode,...recovery}, 'La lingua della sorgente rinnovata non corrisponde');
    let proxy;
    try {proxy=await this.prepareSource(source,{signal:request.controller.signal,audio:effectiveMode==='it'?'it':effectiveMode==='ja-sub-it'?'ja':undefined});}
    catch(error) {
      if(!this.isRequestActive(request))return;
      this.store.markSourceFailure(seriesId,episodeId,source.url,{error:error.message});
      return this._fallback({series,ep,scope,source,sourceIndex,attempted,requestId,effectiveMode,...recovery},redact(error.message));
    }
    if(!this.isRequestActive(request)){await proxy?.close();return;}
    try {return await this._launch({ series, ep, scope, url: source.url, playbackUrl:proxy?.url,proxy,
      sourceIndex:ep.sources.findIndex(s=>Identity.sourceId(episodeId,s)===sourceId), source, attempted, requestId, effectiveMode,
      ...recovery,title, start: resume, referer: source.referer || series.referer, userAgent: source.userAgent, presetId: this.presetFor(series) });}
    finally {if(proxy && this.cur?.proxy!==proxy)await proxy.close();}
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
    const script=this._writeShortcutScript();
    const pipe = pipePath();
    const args = A4K.buildArgs({ settings: { ...settings, userAgent: c.userAgent || settings.userAgent }, presetId: c.presetId, startPos: c.start, title: c.title, referer: c.proxy?'':c.referer, url: c.playbackUrl || c.url, pipe, shaderDir: this.paths.shaderDir });
    args.splice(args.length-2,0,`--script=${script.replace(/\\/g,'/')}`);
    const strictLanguage = ['it', 'ja-sub-it'].includes(c.effectiveMode);
    if (strictLanguage) args.splice(args.length - 2, 0, '--pause=yes', `--alang=${c.effectiveMode === 'it' ? 'it,ita' : 'ja,jpn'}`, '--slang=it,ita');
    const session = new MpvSession({ mpvPath: settings.mpvPath, args, pipe });
    this.cur = { ...c, session, pos: c.start || 0, dur: 0, playedSeconds: 0, lastReportedPos: c.start || 0, lastSave: 0, saveTimer: null, nav: null, stopping: false, startedAt: Date.now() };
    const cur = this.cur;
    cur.lastAdvanceAt=Date.now();
    cur.stallInterval=setInterval(()=>this._checkStall(cur),this.stallPollMs);cur.stallInterval.unref?.();
    session.once('loaded',()=>{if(this._current(cur))this._syncShortcuts();});
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
    session.on('pause', paused => {cur.paused=paused;cur.lastAdvanceAt=Date.now();if(this.cur===cur && paused) {flushProgress();scheduleCheckpoint();}});
    session.on('seek', () => {cur.seeking=true;cur.seekStartedAt=Date.now();cur.lastAdvanceAt=Date.now();});
    session.on('seeked', () => {if(this.cur===cur && cur.seeking) {cur.seeking=false;scheduleCheckpoint();}});
    session.on('speed',speed=>{cur.speed=speed;cur.lastAdvanceAt=Date.now();});
    session.on('time', (t) => {
      if(this.cur!==cur || !Number.isFinite(t))return;
      if(!this._live(cur)) {session.quit('account-change');return;}
      if(cur.expectedDuration && !cur.durationReady)return;
      if(cur.expectedDuration && !cur.resumeReady) {
        if(Math.abs(t-cur.start)>3){session.error='La nuova sorgente non ha ripreso la posizione richiesta';session.quit('source-error');return;}
        cur.resumeReady=true;
      }
      if(cur.observedTime==null || t!==cur.observedTime)cur.lastAdvanceAt=Date.now();
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
        if (segment) { cur.offeredIntro = true; this.notify('player:skip-offer', { kind: 'intro', end: segment.end,requestId:cur.requestId,seriesId:cur.series.id,episodeId:cur.ep.id }); }
      }
      if (this.store.data.settings.skipEnding && !cur.skippedEnding) {
        const segment = skips.find((x) => (x.skipType === 'ed' || x.skipType === 'mixed-ed' || x.skipType === 'mixed-ending') && t >= x.start && t < x.end);
        if (segment) { cur.skippedEnding = true; session.seekAbsolute(segment.end); }
      } else if (!cur.offeredEnding) {
        const segment = skips.find((x) => (x.skipType === 'ed' || x.skipType === 'mixed-ed' || x.skipType === 'mixed-ending') && t >= x.start && t < x.end);
        if (segment) { cur.offeredEnding = true; this.notify('player:skip-offer', { kind: 'ending', end: segment.end,requestId:cur.requestId,seriesId:cur.series.id,episodeId:cur.ep.id }); }
      }
    });
    session.on('duration', (d) => {
      if(this.cur!==cur || !Number.isFinite(d))return;
      if(cur.expectedDuration && d>0 && Math.abs(d-cur.expectedDuration)>Math.max(3,cur.expectedDuration*0.01)) {
        session.error='Durata diversa: cambio automatico sospeso per evitare un altro montaggio';session.quit('source-error');return;
      }
      cur.durationReady=d>0;cur.dur=d;
    });
    session.on('nav', (dir) => { if(cur.requestId!==this.playRequestId)return;cur.nav = dir; session.quit('navigation'); });
    session.on('skip', (kind) => {if(this.cur===cur && cur.requestId===this.playRequestId)this.skipCurrentSegment(kind).catch(()=>{});});
    session.on('spawn-error', (e) => {
      clearTimeout(cur.languageTimer);
      clearInterval(cur.stallInterval);cur.proxy?.close().catch(()=>{});
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
    if(result.eof && !cur.stopping && cur.playbackVerified && cur.dur>0
      && cur.pos<cur.dur-Math.max(3,cur.dur*0.01))
      result={...result,eof:false,reason:'network-error',error:'La sorgente è terminata prima della durata prevista'};
    const { eof, error, code, signal, stderr, stdout } = result;
    clearTimeout(cur.languageTimer);
    clearInterval(cur.stallInterval);cur.proxy?.close().catch(()=>{});
    clearInterval(cur.saveInterval);clearTimeout(cur.saveTimer);
    this._recordDiagnostic(cur,result);
    if (this.cur !== cur) return; // già sostituita da un'altra sessione
    const live=this._live(cur);
    this.cur = null;
    if (this.activeRequest?.requestId === cur.requestId && !error && !cur.stopping) this.activeRequest = null;
    if (cur.ep && live) {
      this._flushProgress(cur,{final:true,eof,error:error || (cur.stopping?'interrupted':null)});
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
      if(this.activeRequest?.requestId===cur.requestId){this.activeRequest.controller?.abort();this.activeRequest=null;}
      this.notify('player:error',exitMessage(result));return;
    }

    if (cur.ep && error && !eof) {
      this.store.markSourceFailure(cur.series.id, cur.ep.id, cur.url, {error, code});
      this.notify('player:source-failed', { seriesId:cur.series.id, episodeId:cur.ep.id, provider:(cur.source || cur.ep.sources[cur.sourceIndex])?.provider, code, signal, error:redact(error), stderr:redact(stderr), stdout:redact(stdout) });
      this._fallback({...cur,failureReason:result.reason}, error).catch(e => this.notify('player:error', redact(e.message)));
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
    let effectiveMode = cur.effectiveMode || Language.preference(cur.series.videoPreference)?.mode || 'auto';
    if(effectiveMode==='auto' && cur.playbackVerified) {
      const audio=Language.classification(source?.language)?.audio;
      if(audio==='it')effectiveMode='it';
      else if(audio==='ja' && Language.modesFor(source).includes('ja-sub-it'))effectiveMode='ja-sub-it';
    }
    const resumePos=cur.pos ?? cur.resumePos ?? cur.ep.progress.pos;
    const expectedDuration=cur.expectedDuration || cur.dur || undefined;
    const renewed=cur.renewed || new Set(),sourceId=source&&Identity.sourceId(cur.ep.id,source);
    if(source?.provider && source.providerEpisodeId && this.resolveAutomaticSource && cur.playbackVerified
      && cur.failureReason==='network-error' && !renewed.has(sourceId)) {
      renewed.add(sourceId);
      this.notify('player:recovering',{seriesId:cur.series.id,episodeId:cur.ep.id,position:resumePos,provider:source.provider,phase:'renewing'});
      return this.play(cur.series.id,cur.ep.id,{sourceId,attempted,requestId:cur.requestId,scope:cur.scope,effectiveMode,
        resumePos,expectedDuration,renewed,controller:cur.controller,forceRenew:true});
    }
    const remaining = Language.rankSources(cur.ep.sources, effectiveMode).filter(item => !attempted.has(Identity.sourceId(cur.ep.id,item.source)));
    // Prefer the other provider over another cached token for the failed one.
    const next = remaining.find(item => item.source.provider !== provider) || remaining[0];
    if (!next) {
      if (effectiveMode !== 'auto') return this._offerLanguageFallback({...cur,attempted,effectiveMode});
      if(this.activeRequest?.requestId===cur.requestId)this.activeRequest=null;
      this.notify('player:error', `Impossibile riprodurre il link: ${redact(error)}`); return;
    }
    this.notify('player:recovering',{seriesId:cur.series.id,episodeId:cur.ep.id,position:resumePos,provider:next.source.provider||'manual',phase:'fallback'});
    return this.play(cur.series.id, cur.ep.id, {sourceIndex:next.index,sourceId:Identity.sourceId(cur.ep.id,next.source), attempted,
      requestId:cur.requestId, scope:cur.scope, effectiveMode,resumePos,expectedDuration,renewed,controller:cur.controller});
  }

  _checkStall(cur,now=Date.now()) {
    if(!this._current(cur)||!cur.ep||!/^https?:\/\//i.test(cur.url)||!cur.session.loaded||cur.session.requestedReason
      ||cur.paused||cur.speed===0||cur.session.eof)return;
    if(now-cur.lastAdvanceAt<this.stallTimeoutMs)return;
    cur.session.error='La sorgente non avanza da '+Math.round(this.stallTimeoutMs/1000)+' secondi';
    cur.session.quit('source-stalled');
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
    if (!choices.length) {
      if(this.activeRequest?.requestId===cur.requestId)this.activeRequest=null;
      this.notify('player:error','Nessuna sorgente riproducibile per la versione richiesta. Cerca nuovi link o aggiungi una sorgente.'); return;
    }
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
    return this.play(series.id,pending.ep.id,{requestId:pending.requestId,scope:pending.scope,attempted:pending.attempted,effectiveMode:mode,
      resumePos:pending.pos??pending.resumePos,expectedDuration:pending.expectedDuration||pending.dur,renewed:pending.renewed,controller:pending.controller});
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

  _current(cur) {return this.cur===cur && !cur.stopping && cur.requestId===this.playRequestId && this._live(cur);}
  _syncShortcuts() {
    const cur=this.cur;
    if(!cur || !cur.session.loaded || !this._current(cur))return;
    const raw=this.store.data.settings.shortcuts,signature=JSON.stringify(raw);
    if(cur.shortcutSignature===signature)return;
    cur.shortcutSignature=signature;
    this.applyShortcuts(raw).catch(error=>{if(this._current(cur))this.notify('player:error',error.message);});
  }
  async applyShortcuts(raw) {
    const target=this.cur,keys=Shortcuts.parse(raw);
    const apply=async()=>{
      const cur=target;
      if(!cur)return {applied:false,nextLaunch:true};
      if(!this._current(cur))throw Error('Sessione cambiata: riprova / Session changed: retry');
      if(!cur.session.loaded)return {applied:false,nextLaunch:true};
      const presets=A4K.buildInputConf(this.paths.shaderDir,{},false).trim().split('\n').map(line=>{const i=line.indexOf(' ');return {key:Shortcuts.normalize(line.slice(0,i)),command:line.slice(i+1)};});
      const result=await cur.session.configureShortcuts(keys,presets);
      if(!this._current(cur))throw Error('Sessione cambiata: riprova / Session changed: retry');
      if(!result.ok)throw Error('Conflitto mpv: '+result.conflicts.join('; '));
      cur.shortcutKeys=keys;return {applied:true,nextLaunch:false};
    };
    const pending=(this.shortcutQueue||Promise.resolve()).catch(()=>{}).then(apply);
    this.shortcutQueue=pending;return pending;
  }
  skipIntro() {return this.skipCurrentSegment('intro');}
  skipEnding() {return this.skipCurrentSegment('ending');}
  seekRelative(seconds) {if(!this.cur)return false;this.cur.session.seekRelative(seconds);return true;}
  seekAbsolute(seconds) {if(!this.cur)return false;this.cur.session.seekAbsolute(seconds);return true;}
  skipSegment(end) {
    // A stale UI offer must never seek to a timestamp belonging to an earlier episode.
    const cur=this.cur,segment=cur?.ep?.skipTimes?.find(x=>x.end===end);
    if(!segment)return Promise.resolve(false);
    return this.skipCurrentSegment(segment && ['op','mixed-op'].includes(segment.skipType)?'intro':'ending');
  }
  async skipCurrentSegment(kind,expected) {
    const cur=this.cur;
    if(!cur || !this._current(cur) || cur.skipBusy || Date.now()<(cur.skipCooldown||0))return false;
    if(expected && (expected.requestId!==cur.requestId || expected.seriesId!==cur.series?.id || expected.episodeId!==cur.ep?.id))return false;
    cur.skipBusy=true;
    try {
      const time=await cur.session.request(['get_property','time-pos']);
      const duration=await cur.session.request(['get_property','duration']);
      if(!this._current(cur))return false;
      const previous=cur.lastManualSkip;
      const decision=previous?.kind===kind && time>=previous.target && time<=previous.target+NEAR_SECONDS
        ? {ok:false,reason:'repeat-destination'} : decideSkip({episode:cur.ep,time,duration,kind});
      if(decision.ok){
        await cur.session.request(['seek',decision.target,'absolute+exact']);
        if(!this._current(cur))return false;
        cur.skipCooldown=Date.now()+1200;
        cur.lastManualSkip={kind,target:decision.target};
      }
      const now=Date.now(),label=kind==='intro'?'Opening':'Ending',it=this.store.data.settings.language==='it';
      if(now-(cur.lastSkipOsd||0)>1500){cur.session.send(['show-text',`${label} ${it?(decision.ok?'saltata':'non disponibile'):(decision.ok?'skipped':'unavailable')}`,1200]);cur.lastSkipOsd=now;}
      return decision.ok;
    }catch{return false;}finally{cur.skipBusy=false;}
  }

  async stop({invalidate = true,reason = 'app-stop'} = {}) {
    if (invalidate) { this.playRequestId++; this.activeRequest?.controller?.abort();this.activeRequest = null; this._clearLanguageFallback(); }
    const cur = this.cur;
    if (!cur) return;
    if(cur.stopPromise)return cur.stopPromise;
    clearTimeout(cur.languageTimer);
    clearInterval(cur.stallInterval);
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
