const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMpvManager, INSTALL_GUIDE, MIN_VERSION } = require('../src/mpv-manager');
const { Store } = require('../src/store');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-player-mpv-test-'));
const executableName = process.platform === 'win32' ? 'mpv.exe' : 'mpv';
const writeFake = (folder) => {
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, executableName);
  fs.writeFileSync(file, 'fake mpv');
  return file;
};
const ok = (name) => console.log('  ok mpv:', name);

(async () => {
  try {
    const pathDir = path.join(tmp, 'path-bin');
    const pathMpv = writeFake(pathDir);
    const manager = createMpvManager({
      platform: process.platform,
      arch: process.arch,
      env: { PATH: pathDir, PATHEXT: '.EXE;.CMD' },
      userDataPath: path.join(tmp, 'user-data'),
      run: async (file) => ({ code: 0, stdout: `mpv 0.40.0-2-gabc\n${file}` }),
      home: tmp,
    });
    let result = await manager.find('');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.source, 'path');
    assert.strictEqual(path.resolve(result.path).toLowerCase(), path.resolve(pathMpv).toLowerCase());
    ok('mpv nel PATH e verifica versione');

    const custom = writeFake(path.join(tmp, 'custom'));
    result = await manager.find(custom);
    assert.strictEqual(result.path, custom);
    assert.strictEqual(result.source, 'custom');
    ok('percorso personalizzato salvato ha priorità');

    const managed = writeFake(path.dirname(manager.managedPath));
    result = await manager.find('');
    assert.strictEqual(result.path, managed);
    assert.strictEqual(result.source, 'managed');
    assert.ok(manager.managedPath.includes(`${process.platform}-${process.arch}`));
    const upgradedManager = createMpvManager({ platform: process.platform, arch: process.arch, userDataPath: path.join(tmp, 'user-data') });
    assert.strictEqual(upgradedManager.managedPath, manager.managedPath);
    ok('copia persistente gestita precede PATH e non dipende dalla versione app');

    const missing = createMpvManager({ platform: process.platform, arch: process.arch, env: { PATH: '' }, userDataPath: path.join(tmp, 'empty'), run: async () => ({ code: 0, stdout: 'mpv 0.40.0' }), home: tmp });
    result = await missing.find('');
    assert.strictEqual(result.status, 'not-found');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(INSTALL_GUIDE, 'https://mpv.io/installation/');
    ok('mpv assente produce stato non configurato e guida ufficiale');

    const conventional = [
      ['win32', 'x64', 'C:\\Program Files\\mpv\\mpv.exe'],
      ['darwin', 'arm64', '/opt/homebrew/bin/mpv'],
      ['linux', 'x64', '/usr/bin/mpv'],
    ];
    for (const [platform, arch, expected] of conventional) {
      const osManager = createMpvManager({
        platform, arch, env: { PATH: '' }, userDataPath: path.join(tmp, `user-${platform}`), home: tmp,
        fileSystem: { statSync: (candidate) => { if (candidate === expected) return { isFile: () => true }; throw new Error('missing'); } },
        run: async () => ({ code: 0, stdout: 'mpv 0.40.0' }),
      });
      result = await osManager.find('');
      assert.strictEqual(result.path, expected, `${platform} searches a conventional executable path`);
    }
    ok('percorsi convenzionali Windows, macOS e Linux');

    const laterStoreFile = path.join(tmp, 'later', 'library.json');
    const laterStore = new Store(laterStoreFile);
    laterStore.setSettings({ onboardingComplete: true });
    laterStore.save(true);
    assert.strictEqual(new Store(laterStoreFile).needsOnboarding(), false);
    ok('configurazione rimandata non riapre il primo avvio');

    const broken = writeFake(path.join(tmp, 'broken'));
    const brokenManager = createMpvManager({ platform: process.platform, env: { PATH: '' }, userDataPath: path.join(tmp, 'broken-data'), run: async () => { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error; }, home: tmp });
    result = await brokenManager.validate(broken);
    assert.strictEqual(result.status, 'unlaunchable');
    ok('eseguibile presente ma non avviabile');

    const oldManager = createMpvManager({ platform: process.platform, env: { PATH: '' }, userDataPath: path.join(tmp, 'old-data'), run: async () => ({ code: 0, stdout: 'mpv 0.20.0' }), home: tmp });
    result = await oldManager.validate(broken);
    assert.strictEqual(result.status, 'incompatible');
    assert.deepStrictEqual(MIN_VERSION, [0, 30, 0]);
    ok('versione troppo vecchia rifiutata');

    const timeoutManager = createMpvManager({ platform: process.platform, env: { PATH: '' }, userDataPath: path.join(tmp, 'timeout-data'), run: async () => { const error = new Error('timeout'); error.code = 'ETIMEDOUT'; throw error; }, home: tmp });
    result = await timeoutManager.validate(broken);
    assert.strictEqual(result.status, 'temporary-error');
    ok('timeout classificato come errore temporaneo');

    const unsupported = createMpvManager({ platform: 'unsupported-os', arch: 'unsupported-arch', env: { PATH: '' }, userDataPath: path.join(tmp, 'unsupported'), run: async () => ({ code: 0, stdout: 'mpv 0.40.0' }), home: tmp });
    result = await unsupported.find('');
    assert.strictEqual(result.status, 'unsupported-platform');
    ok('sistema e architettura non supportati sono distinti da mpv assente');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
