const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { readConfig } = require('../src/cloud');
const root = path.resolve(__dirname, '..');

function defaultUserDataPath() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Anime Player');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Anime Player');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Anime Player');
}

const sourceConfig = process.env.SUPABASE_CONFIG_FILE || path.join(defaultUserDataPath(), 'supabase-config.json');
const config = readConfig(process.env, sourceConfig);
if (!config.configured) throw new Error(`Build Supabase non configurata: ${config.error}`);
const resourceDir = path.join(root, '.build-resources');
fs.mkdirSync(resourceDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(resourceDir, 'supabase-config.json'), JSON.stringify({ url: config.url, publishableKey: config.key }), { mode: 0o600 });

execFileSync(process.execPath, [path.join(__dirname, 'check.js')], { cwd: root, stdio: 'inherit' });
const target = process.platform === 'win32' ? '--win' : '--linux';
const npmArgs = ['exec', '--', 'electron-builder', target];
if (process.platform === 'win32') {
  execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm.cmd ${npmArgs.join(' ')}`], {
    cwd: root,
    stdio: 'inherit',
  });
} else {
  execFileSync('npm', npmArgs, { cwd: root, stdio: 'inherit' });
}
