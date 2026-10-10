// Controller di una sessione mpv tramite JSON IPC (named pipe su Windows, socket su Unix).
const { spawn } = require('child_process');
const net = require('net');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { redact } = require('./source-state');

function pipePath() {
  const name = `anime-player-mpv-${process.pid}-${Date.now()}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), name + '.sock');
}

class MpvSession extends EventEmitter {
  constructor({ mpvPath, args, pipe }) {
    super();
    this.mpvPath = mpvPath; this.args = args; this.pipe = pipe;
    this.closed = false; this.eof = false; this.error = null; this.sock = null; this.buf = '';
  }

  start() {
    this.stderr = '';
    this.stdout = '';
    // Keep the mpv video window visible on Windows; windowsHide also hides GUI child processes.
    this.proc = spawn(this.mpvPath, this.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc.stderr.on('data', data => { this.stderr = (this.stderr + data.toString()).slice(0,65536); });
    this.proc.stdout.on('data', data => { this.stdout = (this.stdout + data.toString()).slice(0,65536); });
    this.startupTimer = setTimeout(() => {
      this.error = 'Timeout durante il caricamento della sorgente'; this.quit();
    }, 30000);
    this.proc.on('error', (e) => { this.closed = true; clearTimeout(this.startupTimer); this.emit('spawn-error', e); });
    this.proc.on('exit', (code, signal) => {
      this.closed = true;
      clearTimeout(this.startupTimer);
      if (this.sock) this.sock.destroy();
      // Se il link fallisce subito mpv esce prima che l'IPC sia connesso: si usa il codice di uscita (2 = file non riproducibile)
      const error = this.error || (code === 2 || code === 3 ? 'impossibile aprire il link o il file' : code === 1 ? 'errore di avvio di mpv' : code != null && ![0,4].includes(code) ? `mpv terminato con codice ${code}` : null);
      this.emit('exit', { code, signal, eof: this.eof, error: error ? redact(error) : null, stderr: redact(this.stderr).slice(-4000), stdout: redact(this.stdout).slice(-4000) });
    });
    this._connect(0);
  }

  _connect(tries) {
    if (this.closed) return;
    const sock = net.connect(this.pipe);
    let connected = false;
    sock.on('connect', () => {
      connected = true; this.sock = sock;
      this.send(['observe_property', 1, 'time-pos']);
      this.send(['observe_property', 2, 'duration']);
      this.send(['observe_property', 3, 'pause']);
      this.send(['observe_property', 4, 'track-list']);
      this.emit('connected');
    });
    sock.on('data', (d) => this._onData(d));
    sock.on('error', () => { if (!connected && tries < 60) setTimeout(() => this._connect(tries + 1), 150); });
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
    if (m.event === 'file-loaded') { clearTimeout(this.startupTimer); this.emit('loaded'); }
    if (m.event === 'property-change') {
      if (m.name === 'time-pos' && typeof m.data === 'number') { clearTimeout(this.startupTimer); this.emit('time', m.data); }
      else if (m.name === 'duration' && typeof m.data === 'number') this.emit('duration', m.data);
      else if (m.name === 'pause') this.emit('pause', !!m.data);
      else if (m.name === 'track-list' && Array.isArray(m.data)) this.emit('tracks', m.data);
    } else if (m.event === 'end-file') {
      if (m.reason === 'eof') this.eof = true;
      else if (m.reason === 'error') { this.error = redact(m.file_error || 'errore di riproduzione'); this.quit(); }
    } else if (m.event === 'client-message' && Array.isArray(m.args)) {
      if (m.args[0] === 'ap-next') this.emit('nav', 'next');
      else if (m.args[0] === 'ap-prev') this.emit('nav', 'prev');
      else if (m.args[0] === 'ap-skip-intro') this.emit('skip', 'intro');
      else if (m.args[0] === 'ap-skip-ending') this.emit('skip', 'ending');
    }
  }

  send(command) {
    if (this.sock && !this.sock.destroyed) this.sock.write(JSON.stringify({ command }) + '\n');
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

  quit() {
    clearTimeout(this.startupTimer);
    this.send(['quit']);
    setTimeout(() => { if (!this.closed && this.proc) this.proc.kill(); }, 1500);
  }
}

module.exports = { MpvSession, pipePath };
