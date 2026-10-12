'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('node:assert/strict'),yaml=require('js-yaml');
function verify(dir,platform,version){
  const name={win32:'latest.yml',linux:'latest-linux.yml',darwin:'latest-mac.yml'}[platform];assert.ok(name,'unknown platform');
  const info=yaml.load(fs.readFileSync(path.join(dir,name),'utf8'));assert.equal(info.version,version);
  require('../src/updates').validateInfo(info,'0.0.0');
  const required={win32:/Setup-.*\.exe$/,linux:/\.AppImage$/,darwin:/\.zip$/}[platform];assert.ok(info.files.some(f=>required.test(f.url)),'required update target missing');
  for(const file of info.files){const bytes=fs.readFileSync(path.join(dir,file.url));assert.equal(bytes.length,file.size);assert.equal(crypto.createHash('sha512').update(bytes).digest('base64'),file.sha512,'artifact hash mismatch');}
  if(platform==='win32'){assert.ok(fs.statSync(path.join(dir,`AnimePlayer-Setup-${version}.exe.blockmap`)).size>0);assert.ok(fs.statSync(path.join(dir,'AnimePlayer-portable.exe')).size>1000000);}
  if(platform==='linux')assert.ok(fs.readdirSync(dir).some(f=>f.endsWith('.deb')),'DEB missing');
  if(platform==='darwin')assert.ok(fs.readdirSync(dir).some(f=>f.endsWith('.dmg')),'DMG missing');
  console.log('Release artifacts verified:',platform,version);return info;
}
if(require.main===module)verify(path.resolve(process.argv[2]||require('../package.json').build.directories.output),process.argv[3]||process.platform,require('../package.json').version);
module.exports={verify};
