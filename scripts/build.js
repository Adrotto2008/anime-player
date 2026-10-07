const { execFileSync } = require('child_process');
const path = require('path');
const root = path.resolve(__dirname, '..');
execFileSync(process.execPath, [path.join(__dirname, 'check.js')], { cwd: root, stdio: 'inherit' });
const target = process.platform === 'win32' ? '--win' : '--linux';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
execFileSync(npm, ['exec', '--', 'electron-builder', target], { cwd: root, stdio: 'inherit' });
