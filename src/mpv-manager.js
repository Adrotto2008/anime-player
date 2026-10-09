// Rilevamento e verifica dell'eseguibile mpv, separati dall'avvio delle sessioni.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const MIN_VERSION = [0, 30, 0];
const INSTALL_GUIDE = 'https://mpv.io/installation/';
const ARCHITECTURES = { win32: ['x64', 'arm64', 'ia32'], darwin: ['x64', 'arm64'], linux: ['x64', 'arm64', 'arm'] };

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const delta = (a[i] || 0) - (b[i] || 0);
    if (delta) return Math.sign(delta);
  }
  return 0;
}

function createMpvManager({ platform = process.platform, arch = process.arch, env = process.env, userDataPath, fileSystem = fs, run = runVersionCheck, home = os.homedir() } = {}) {
  const executableName = platform === 'win32' ? 'mpv.exe' : 'mpv';
  const managedPath = userDataPath && path.join(userDataPath, 'mpv', `${platform}-${arch}`, executableName);
  const supported = Boolean(ARCHITECTURES[platform] && ARCHITECTURES[platform].includes(arch));

  function conventionalPaths() {
    if (platform === 'win32') {
      const roots = [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData, env.USERPROFILE && path.join(env.USERPROFILE, 'scoop', 'apps', 'mpv', 'current')].filter(Boolean);
      return [
        ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', executableName), path.join(env.LOCALAPPDATA, 'Programs', 'mpv', executableName)] : []),
        ...roots.flatMap((root) => [path.join(root, 'mpv', executableName), path.join(root, 'mpv', 'bin', executableName)]),
        'C:\\Program Files\\mpv\\mpv.exe', 'C:\\Program Files (x86)\\mpv\\mpv.exe',
      ];
    }
    if (platform === 'darwin') return [
      '/opt/homebrew/bin/mpv', '/usr/local/bin/mpv', '/opt/local/bin/mpv',
      path.join(home, '.local', 'bin', 'mpv'), '/Applications/mpv.app/Contents/MacOS/mpv',
    ];
    if (platform === 'linux') return [
      '/usr/bin/mpv', '/usr/local/bin/mpv', '/bin/mpv', '/snap/bin/mpv',
      path.join(home, '.local', 'bin', 'mpv'), '/var/lib/flatpak/exports/bin/io.mpv.Mpv',
    ];
    return [];
  }

  function isFile(candidate) {
    if (!candidate) return false;
    try { return fileSystem.statSync(candidate).isFile(); } catch { return false; }
  }

  async function validate(candidate) {
    if (!candidate || !isFile(candidate)) return { ok: false, status: 'not-found', path: candidate || null };
    try {
      const result = await run(candidate, { platform });
      if (result.code !== 0) return { ok: false, status: 'unlaunchable', path: candidate, error: `mpv --version è terminato con codice ${result.code}.` };
      const text = `${result.stdout || ''}\n${result.stderr || ''}`;
      const match = text.match(/\bmpv\s+(?:v)?(\d+)\.(\d+)(?:\.(\d+))?/i);
      if (!match) return { ok: false, status: 'incompatible', path: candidate, error: 'Versione mpv non riconosciuta.' };
      const version = match.slice(1).map((part) => Number(part || 0));
      if (compareVersions(version, MIN_VERSION) < 0) {
        return { ok: false, status: 'incompatible', path: candidate, version: version.join('.'), error: `mpv ${version.join('.')} è troppo vecchio; serve almeno ${MIN_VERSION.join('.')}.` };
      }
      return { ok: true, status: 'ready', path: candidate, version: version.join('.'), output: text.trim() };
    } catch (error) {
      if (error.code === 'ETIMEDOUT') return { ok: false, status: 'temporary-error', path: candidate, error: 'mpv non ha risposto entro 4 secondi.' };
      if (error.code === 'ENOENT') return { ok: false, status: 'unlaunchable', path: candidate, error: 'Il file mpv non è avviabile o manca una dipendenza.' };
      return { ok: false, status: 'unlaunchable', path: candidate, error: error.message };
    }
  }

  async function find(customPath = '') {
    if (!supported) return { ok: false, status: 'unsupported-platform', path: null, source: null, managedPath, error: `mpv non è supportato automaticamente per ${platform}/${arch}.`, installGuide: INSTALL_GUIDE };
    const ordered = [];
    const add = (candidate, source) => {
      const key = (value) => platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
      if (candidate && !ordered.some((item) => key(item.path) === key(candidate))) ordered.push({ path: candidate, source });
    };
    add(customPath, 'custom');
    add(managedPath, 'managed');
    const suffixes = platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
    for (const directory of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
      for (const suffix of suffixes) add(path.join(directory, `mpv${suffix}`), 'path');
    }
    for (const candidate of conventionalPaths()) add(candidate, 'conventional');
    const failures = [];
    for (const item of ordered) {
      if (!isFile(item.path)) continue;
      const check = await validate(item.path);
      if (check.ok) return { ...check, source: item.source, managedPath };
      failures.push({ ...check, source: item.source });
    }
    const existing = failures[0];
    return existing
      ? { ...existing, managedPath, failures }
      : { ok: false, status: 'not-found', path: null, source: null, managedPath, error: 'mpv non è installato o non è stato trovato.' };
  }

  return { platform, arch, supported, managedPath, installGuide: INSTALL_GUIDE, validate, find };
}

function runVersionCheck(executable, { platform = process.platform } = {}) {
  return new Promise((resolve, reject) => {
    execFile(executable, ['--version'], { timeout: 4000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); return; }
      resolve({ code: 0, stdout, stderr, platform });
    });
  });
}

module.exports = { createMpvManager, INSTALL_GUIDE, MIN_VERSION, ARCHITECTURES, compareVersions };
