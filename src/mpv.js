// Controller di una sessione mpv tramite JSON IPC (named pipe su Windows, socket su Unix).
const { spawn } = require('child_process');
const net = require('net');
const os = require('os');
const path = require('path');
const {randomUUID}=require('crypto');
const { EventEmitter } = require('events');
const { redact } = require('./source-state');

function pipePath({ platform=process.platform, tempDir=os.tmpdir(), pid=process.pid, id=randomUUID() }={}) {
  if(platform==='win32')return `\\\\.\\pipe\\anime-player-mpv-${pid}-${id}`;
  if(platform==='darwin'){
    // macOS sockaddr_un.sun_path is only 104 bytes, including its terminator.
    const basename=`ap-${pid}-${id.slice(0,16)}.sock`;
    const candidate=path.posix.join(tempDir,basename);
    return Buffer.byteLength(candidate)<104?candidate:path.posix.join('/tmp',basename);
  }
  return path.join(tempDir,`anime-player-mpv-${pid}-${id}.sock`);
}

class MpvSession extends EventEmitter {
  constructor({ mpvPath, args, pipe, ipcTimeoutMs=10000, loadTimeoutMs=30000, quitTimeoutMs=1500, heartbeatMs=5000, responseTimeoutMs=5000 }) {
    super();
    this.mpvPath = mpvPath; this.args = args; this.pipe = pipe;
    this.closed = false; this.eof = false; this.error = null; this.sock = null; this.buf = '';
    this.ipcTimeoutMs=ipcTimeoutMs;this.loadTimeoutMs=loadTimeoutMs;this.quitTimeoutMs=quitTimeoutMs;
    this.connected=false;this.loaded=false;this.endReason=null;this.requestedReason=null;this.forced=false;
    this.heartbeatMs=heartbeatMs;this.responseTimeoutMs=responseTimeoutMs;this.nextCommandId=100;this.requests=new Map();this.bindingRequests=new Map();
  }

  start() {
    this.stderr = '';
    this.stdout = '';
    // Keep the mpv video window visible on Windows; windowsHide also hides GUI child processes.
    this.proc = spawn(this.mpvPath, this.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc.stderr.on('data', data => { this.stderr = (this.stderr + data.toString()).slice(-65536); });
    this.proc.stdout.on('data', data => { this.stdout = (this.stdout + data.toString()).slice(-65536); });
    this.ipcTimer=setTimeout(()=>{this.error='Timeout della connessione IPC con mpv';this.quit('ipc-timeout');},this.ipcTimeoutMs);
    this.startupTimer = setTimeout(() => {
      this.error = 'Timeout durante il caricamento della sorgente'; this.quit('load-timeout');
    }, this.loadTimeoutMs);
    this.proc.on('error', (e) => { this.closed = true; this._cleanup(); this.emit('spawn-error', e); });
    this.proc.on('exit',()=>{this.processExited=true;clearTimeout(this.startupTimer);clearTimeout(this.ipcTimer);clearInterval(this.heartbeatTimer);clearTimeout(this.responseTimer);});
    // close follows exit after stdout/stderr have drained; retain the final loading/crash evidence.
    this.proc.on('close', (code, signal) => {
      if(this.closed)return;
      this.closed = true;
      this._cleanup();
      // Se il link fallisce subito mpv esce prima che l'IPC sia connesso: si usa il codice di uscita (2 = file non riproducibile)
      const networkEvidence=redact(((this.stderr || '')+'\n'+(this.stdout || '')).match(/[^\r\n]*(?:HTTP error \d{3}|Server returned \d{3}|Connection refused|Connection timed out|Failed to resolve|TLS handshake failed)[^\r\n]*/i)?.[0] || '').slice(-1000);
      let reason=this.requestedReason || (this.endReason==='error' || code===2 || code===3 ? 'source-error'
        : this.eof ? 'eof' : (this.endReason==='quit' || this.endReason==='stop') && !signal && code===0 ? 'user-close'
        : signal || code!==0 ? 'abnormal' : 'unknown-exit');
      if(reason==='source-error' && networkEvidence)reason='network-error';
      const expected=['app-stop','replaced','account-change','deleted','shutdown','navigation','user-close','eof'].includes(reason);
      const error = this.error || (!expected ? code===2 || code===3 ? 'impossibile aprire il link o il file'
        : code===1 ? 'errore di avvio di mpv' : `mpv terminato${signal?' dal segnale '+signal:code?' con codice '+code:' senza motivo comunicato'}` : null);
      this.emit('exit', { code, signal, eof: this.eof, reason,requestedReason:this.requestedReason,endReason:this.endReason,
        connected:this.connected,loaded:this.loaded,forced:this.forced,networkEvidence,error: error ? redact(error) : null,
        stderr: redact(this.stderr).slice(-4000), stdout: redact(this.stdout).slice(-4000) });
    });
    this._connect(0);
  }

  _connect(tries) {
    if (this.closed || this.requestedReason) return;
    const sock = net.connect(this.pipe);
    this.connectingSocket=sock;
    let connected = false;
    sock.on('connect', () => {
      if(this.closed || this.requestedReason) {sock.destroy();return;}
      connected = true; this.connected=true;this.sock = sock;clearTimeout(this.ipcTimer);
      this.send(['observe_property', 1, 'time-pos']);
      this.send(['observe_property', 2, 'duration']);
      this.send(['observe_property', 3, 'pause']);
      this.send(['observe_property', 4, 'track-list']);
      this.send(['observe_property', 5, 'speed']);
      this.send(['observe_property', 6, 'paused-for-cache']);
      this.heartbeatTimer=setInterval(()=>{
        if(this.closed || this.requestedReason || !this.loaded || this.pendingCommandId)return;
        this.pendingCommandId=++this.nextCommandId;
        this.send(['get_property','time-pos'],this.pendingCommandId);
        this.responseTimer=setTimeout(()=>{this.error='Timeout della risposta IPC di mpv';this.quit('ipc-timeout');},this.responseTimeoutMs);
      },this.heartbeatMs);
      this.emit('connected');
    });
    sock.on('data', (d) => this._onData(d));
    sock.on('error', () => {sock.destroy();if (!connected && !this.closed && !this.requestedReason) this.connectTimer=setTimeout(() => this._connect(tries + 1),150);});
    sock.on('close',()=>{
      if(connected && !this.closed && !this.requestedReason && !this.endReason) {
        this.disconnectTimer=setTimeout(()=>{if(!this.closed && !this.endReason && !this.requestedReason) {
          this.error='La connessione IPC con mpv è stata interrotta';this.quit('ipc-disconnected');
        }},150);
      }
    });
  }

  _onData(d) {
    this.buf += d.toString('utf8');
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      this._onMessage(msg);
    }
  }

  _onMessage(m) {
    const pending=this.requests.get(m.request_id);
    if(pending){clearTimeout(pending.timer);this.requests.delete(m.request_id);m.error==='success'?pending.resolve(m.data):pending.reject(new Error(m.error||'mpv command failed'));}
    if(m.request_id===this.pendingCommandId) {clearTimeout(this.responseTimer);this.pendingCommandId=null;}
    if (m.event === 'file-loaded') this._markLoaded();
    if(m.event==='seek')this.emit('seek');
    if(m.event==='playback-restart')this.emit('seeked');
    if (m.event === 'property-change') {
      if (m.name === 'time-pos' && typeof m.data === 'number') { this._markLoaded(); this.emit('time', m.data); }
      else if (m.name === 'duration' && typeof m.data === 'number') this.emit('duration', m.data);
      else if (m.name === 'pause') this.emit('pause', !!m.data);
      else if (m.name === 'track-list' && Array.isArray(m.data)) this.emit('tracks', m.data);
      else if (m.name === 'speed' && typeof m.data === 'number') this.emit('speed', m.data);
      else if (m.name === 'paused-for-cache') this.emit('buffering', !!m.data);
    } else if (m.event === 'end-file') {
      this.endReason=m.reason;
      if (m.reason === 'eof') this.eof = true;
      else if (m.reason === 'error') { this.error = redact(m.file_error || 'errore di riproduzione'); this.quit('source-error'); }
    } else if (m.event === 'client-message' && Array.isArray(m.args)) {
      if(m.args[0]==='ap-bindings-result'){const pending=this.bindingRequests.get(Number(m.args[1]));if(pending){clearTimeout(pending.timer);this.bindingRequests.delete(Number(m.args[1]));try{pending.resolve(JSON.parse(m.args[2]));}catch(error){pending.reject(error);}}}
      else if (m.args[0] === 'ap-next') this.emit('nav', 'next');
      else if (m.args[0] === 'ap-prev') this.emit('nav', 'prev');
      else if (m.args[0] === 'ap-skip-intro') this.emit('skip', 'intro');
      else if (m.args[0] === 'ap-skip-ending') this.emit('skip', 'ending');
      else if (m.args[0] === 'ap-party-status') this.emit('party-status');
      else if (m.args[0] === 'ap-party-resync') this.emit('party-resync');
      else if (m.args[0] === 'ap-party-resync-all') this.emit('party-resync-all');
    }
  }

  send(command,requestId) {
    if (this.sock && !this.sock.destroyed && !this.processExited) {
      try {this.sock.write(JSON.stringify({command,...(requestId ? {request_id:requestId} : {})})+'\n',()=>{});return true;}catch{return false;}
    }
    return false;
  }

  _markLoaded() {if(!this.loaded){this.loaded=true;clearTimeout(this.startupTimer);this.emit('loaded');}}

  request(command) {return this._pending(this.requests,id=>this.send(command,id));}
  configureShortcuts(keys,presets=[]) {return this._pending(this.bindingRequests,id=>this.send(['script-message-to','ap_shortcuts','configure',String(id),JSON.stringify({keys,presets})]));}
  _pending(map,send) {
    if(this.closed || this.requestedReason || !this.sock || this.sock.destroyed)return Promise.reject(new Error('mpv non connesso'));
    return new Promise((resolve,reject)=>{
      const id=++this.nextCommandId;
      const timer=setTimeout(()=>{map.delete(id);reject(new Error('Timeout risposta mpv'));},3000);
      map.set(id,{resolve,reject,timer});
      if(!send(id)){clearTimeout(timer);map.delete(id);reject(new Error('mpv non connesso'));}
    });
  }
  setShaders(chainString, label) {
    if (chainString) this.send(['change-list', 'glsl-shaders', 'set', chainString]);
    else this.send(['change-list', 'glsl-shaders', 'clr', '']);
    this.send(['show-text', `Anime4K: ${label}`, 2000]);
  }

  seekRelative(seconds) {
    const value = Number(seconds);
    if (Number.isFinite(value) && value !== 0) this.send(['seek', value, 'relative']);
  }

  seekAbsolute(seconds) {
    const value = Number(seconds);
    if (Number.isFinite(value) && value >= 0) this.send(['seek', value, 'absolute']);
  }

  _cleanup() {
    clearTimeout(this.startupTimer);
    clearTimeout(this.ipcTimer);clearTimeout(this.connectTimer);clearTimeout(this.killTimer);
    clearInterval(this.heartbeatTimer);clearTimeout(this.responseTimer);clearTimeout(this.disconnectTimer);
    for(const map of [this.requests,this.bindingRequests]){for(const pending of map.values()){clearTimeout(pending.timer);pending.reject(new Error('Sessione mpv terminata'));}map.clear();}
    this.connectingSocket?.destroy();
    this.sock?.destroy();
  }

  quit(reason='app-stop') {
    if(this.closed || this.processExited || this.requestedReason)return;
    this.requestedReason=reason;
    clearTimeout(this.startupTimer);clearTimeout(this.ipcTimer);clearTimeout(this.connectTimer);
    clearInterval(this.heartbeatTimer);clearTimeout(this.responseTimer);clearTimeout(this.disconnectTimer);
    this.send(['quit']);
    this.killTimer=setTimeout(() => { if (!this.closed && this.proc) {this.forced=true;this.proc.kill();} },this.quitTimeoutMs);
  }
}

module.exports = { MpvSession, pipePath };
