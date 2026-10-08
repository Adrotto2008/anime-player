const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const electronInstaller = require.resolve('electron/install.js');
execFileSync(process.execPath, [electronInstaller], { stdio: 'inherit' });

const electronBinary = require('electron');
if (typeof electronBinary !== 'string' || !fs.existsSync(electronBinary)) {
  const packagePath = path.relative(process.cwd(), electronInstaller);
  throw new Error(
    `Binario Electron non disponibile (${packagePath}). Controlla la connessione e reinstalla le dipendenze con "npm ci", poi riprova. ` +
    'Se ELECTRON_SKIP_BINARY_DOWNLOAD è impostato, rimuovilo e ripeti il comando.',
  );
}
