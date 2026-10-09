// Rilevamento e verifica dell'eseguibile mpv, separati dall'avvio delle sessioni.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const https = require('https');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { createWriteStream, createReadStream } = require('fs');

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

function createMpvManager({ platform = process.platform, arch = process.arch, env = process.env, userDataPath, installDirectory = '', fileSystem = fs, run = runVersionCheck, home = os.homedir() } = {}) {
  const executableName = platform === 'win32' ? 'mpv.exe' : 'mpv';
  const configuredInstallDirectory = String(installDirectory || '').trim();
  const managedPath = (configuredInstallDirectory || userDataPath) && path.join(configuredInstallDirectory || userDataPath, 'mpv', `${platform}-${arch}`, executableName);
  const supported = Boolean(ARCHITECTURES[platform] && ARCHITECTURES[platform].includes(arch));

  async function download(url, destination) {
    await new Promise((resolve, reject) => {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !['api.github.com', 'github.com', 'release-assets.githubusercontent.com'].includes(parsed.hostname)) { reject(new Error('La release mpv contiene un URL di download non consentito.')); return; }
      const request = https.get(parsed, { headers: { 'User-Agent': 'AnimePlayer', Accept: 'application/vnd.github+json' } }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          download(response.headers.location, destination).then(resolve, reject);
        } else if (response.statusCode !== 200) {
          response.resume(); reject(new Error(`Download mpv fallito (HTTP ${response.statusCode}).`));
        } else {
          pipeline(response, createWriteStream(destination, { flags: 'wx' })).then(resolve, reject);
        }
      });
      request.setTimeout(30000, () => request.destroy(new Error('Download mpv scaduto.')));
      request.on('error', reject);
    });
  }

  async function install(destinationDirectory = configuredInstallDirectory || userDataPath) {
    if (platform !== 'win32' || !['x64', 'arm64'].includes(arch)) return { ok: false, status: 'unsupported-platform', error: `Installazione automatica non disponibile per ${platform}/${arch}.`, installGuide: INSTALL_GUIDE };
    if (!destinationDirectory) throw new Error('Cartella di installazione non disponibile per mpv.');
    const installRoot = path.resolve(destinationDirectory);
    const destinationManagedPath = path.join(installRoot, 'mpv', `${platform}-${arch}`, executableName);
    const release = await new Promise((resolve, reject) => {
      https.get('https://api.github.com/repos/mpv-player/mpv/releases/latest', { headers: { 'User-Agent': 'AnimePlayer', Accept: 'application/vnd.github+json' } }, (response) => {
        if (response.statusCode !== 200) { response.resume(); reject(new Error(`Impossibile verificare la release ufficiale di mpv (HTTP ${response.statusCode}).`)); return; }
        let body = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { body += chunk; if (body.length > 5 * 1024 * 1024) response.destroy(new Error('Risposta release mpv troppo grande.')); }); response.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('Risposta release mpv non valida.')); } });
      }).on('error', reject);
    });
    const architecture = arch === 'x64' ? 'x86_64' : 'aarch64';
    const asset = (release.assets || []).find((item) => item.name === `mpv-${release.tag_name}-${architecture}-pc-windows-msvc.zip`);
    if (!asset || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest || '') || !asset.browser_download_url || asset.size > 500 * 1024 * 1024) throw new Error('La release ufficiale non espone un archivio Windows di dimensione valida con SHA-256 verificabile.');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-player-mpv-'));
    const archive = path.join(tempDir, 'mpv.zip');
    const staging = `${destinationManagedPath}.installing-${process.pid}`;
    try {
      await download(asset.browser_download_url, archive);
      const hash = crypto.createHash('sha256');
      for await (const chunk of createReadStream(archive)) hash.update(chunk);
      const digest = hash.digest('hex');
      if (digest.toLowerCase() !== asset.digest.slice('sha256:'.length).toLowerCase()) throw new Error('Il controllo SHA-256 del download di mpv non è riuscito.');
      fs.mkdirSync(path.dirname(destinationManagedPath), { recursive: true });
      fs.mkdirSync(staging, { recursive: false });
      execFileSync('tar', ['-xf', archive, '-C', staging], { windowsHide: true, stdio: 'ignore' });
      const found = [];
      const walk = (directory, depth = 0) => {
        if (depth > 3) return;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const child = path.join(directory, entry.name);
          if (entry.isFile() && entry.name.toLowerCase() === executableName.toLowerCase()) found.push(child);
          else if (entry.isDirectory()) walk(child, depth + 1);
        }
      };
      walk(staging);
      if (found.length !== 1) throw new Error('L’archivio ufficiale non contiene un eseguibile mpv riconoscibile.');
      const candidate = found[0];
      const validated = await validate(candidate);
      if (!validated.ok) throw new Error(validated.error || 'La build mpv scaricata non si avvia.');
      const candidateDir = path.dirname(candidate);
      const files = fs.readdirSync(candidateDir, { withFileTypes: true });
      if (!files.some((entry) => entry.name.toLowerCase() === executableName.toLowerCase())) throw new Error('La build ufficiale non contiene tutti i file necessari di mpv.');
      const installDir = path.dirname(destinationManagedPath);
      const nextDir = `${installDir}.new-${process.pid}`;
      const backupDir = `${installDir}.previous-${process.pid}`;
      fs.rmSync(nextDir, { recursive: true, force: true });
      fs.mkdirSync(nextDir, { recursive: true });
      for (const entry of files) {
        if (entry.isFile()) fs.copyFileSync(path.join(candidateDir, entry.name), path.join(nextDir, entry.name));
        else if (entry.isDirectory()) fs.cpSync(path.join(candidateDir, entry.name), path.join(nextDir, entry.name), { recursive: true });
      }
      const nextExecutable = path.join(nextDir, executableName);
      const stagedValidation = await validate(nextExecutable);
      if (!stagedValidation.ok) throw new Error(stagedValidation.error || 'Verifica di mpv installato non riuscita.');
      fs.rmSync(backupDir, { recursive: true, force: true });
      const hadInstall = fs.existsSync(installDir);
      if (hadInstall) fs.renameSync(installDir, backupDir);
      try { fs.renameSync(nextDir, installDir); }
      catch (error) { if (hadInstall) fs.renameSync(backupDir, installDir); throw error; }
      const installed = await validate(destinationManagedPath);
      if (!installed.ok) {
        fs.rmSync(installDir, { recursive: true, force: true });
        if (hadInstall) fs.renameSync(backupDir, installDir);
        throw new Error(installed.error || 'Verifica di mpv installato non riuscita.');
      }
      let startMenuShortcut = null;
      if (platform === 'win32' && env.APPDATA) {
        const startMenu = path.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
        const shortcutPath = path.join(startMenu, 'Anime Player', 'mpv.lnk');
        try {
          fs.mkdirSync(path.dirname(shortcutPath), { recursive: true });
          const ps = `$shell = New-Object -ComObject WScript.Shell; $link = $shell.CreateShortcut('${shortcutPath.replace(/'/g, "''")}'); $link.TargetPath = '${destinationManagedPath.replace(/'/g, "''")}'; $link.WorkingDirectory = '${path.dirname(destinationManagedPath).replace(/'/g, "''")}'; $link.Description = 'mpv media player'; $link.Save()`;
          execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true, stdio: 'ignore' });
          startMenuShortcut = shortcutPath;
        } catch { /* mpv resta utilizzabile direttamente anche senza collegamento Start */ }
      }
      fs.rmSync(backupDir, { recursive: true, force: true });
      return { ...installed, source: 'managed', managedPath: destinationManagedPath, installDirectory: installRoot, startMenuShortcut };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.rmSync(staging, { recursive: true, force: true });
      fs.rmSync(`${path.dirname(destinationManagedPath)}.new-${process.pid}`, { recursive: true, force: true });
    }
  }

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

  return { platform, arch, supported, managedPath, installDirectory: configuredInstallDirectory || userDataPath, installGuide: INSTALL_GUIDE, validate, find, install };
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
