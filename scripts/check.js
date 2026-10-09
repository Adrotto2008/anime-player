const { execFileSync, execSync } = require('child_process');
for (const file of ['main.js', 'preload.js', 'scripts/build.js', 'src/store.js', 'src/cloud.js', 'src/animeworld.js', 'src/mpv-manager.js', 'renderer/app.js', 'renderer/i18n.js']) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
execFileSync(process.execPath, ['test/animeworld.js'], { stdio: 'inherit' });
execFileSync(process.execPath, ['test/mpv-manager.js'], { stdio: 'inherit' });
execFileSync(process.execPath, ['test/run.js'], { stdio: 'inherit' });
execSync('git diff --check', { stdio: 'inherit' });
console.log('All checks passed.');
