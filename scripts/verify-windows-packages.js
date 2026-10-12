'use strict';
// Extract only into the checkout; never execute the installer or portable.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert');
const {execFileSync}=require('child_process'),asar=require('@electron/asar');
async function main(){
const zip=await require('app-builder-lib/out/toolsets/7zip').getPath7za(),root=path.resolve(__dirname,'..');
const manifest=require('../package.json'),version=manifest.version,output=path.join(root,manifest.build.directories.output);
const expectedConfig=process.argv[3]?JSON.parse(fs.readFileSync(path.resolve(process.argv[3]),'utf8')):{};
if(process.argv[3]){
 assert.deepEqual(Object.keys(expectedConfig).sort(),['publishableKey','url']);
 const checked=require('../src/cloud').readConfig({},path.resolve(process.argv[3]));
 assert.ok(checked.configured,'expected public config is invalid');
 assert.equal(checked.url,expectedConfig.url);assert.equal(checked.key,expectedConfig.publishableKey);
}
const scratch=path.join(root,'.build-resources','verification-'+Date.now());fs.mkdirSync(scratch,{recursive:true});
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
// @electron/asar walks directory components using the host's path.sep.
// Normalize portable manifest paths before inspecting nested source folders.
const readArchive=(archive,name)=>asar.extractFile(archive,path.normalize(name));
const extract=(file,dir)=>{fs.mkdirSync(dir,{recursive:true});execFileSync(zip,['x','-y',file,'-o'+dir],{stdio:'pipe',windowsHide:true});};
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{const file=path.join(dir,entry.name);return entry.isDirectory()?walk(file):[file];});}
const expected=['main.js','preload.js',...['src','renderer'].flatMap(dir=>walk(path.join(root,dir)).map(file=>path.relative(root,file).split(path.sep).join('/')))];
function inspect(dir){
 const archive=walk(dir).find(file=>path.basename(file)==='app.asar');assert.ok(archive,'app.asar missing');
 for(const name of expected)assert.equal(hash(readArchive(archive,name)),hash(fs.readFileSync(path.join(root,name))),name);
 const pkg=JSON.parse(asar.extractFile(archive,'package.json'));assert.equal(pkg.version,version);
 const names=asar.listPackage(archive);assert.ok(!names.some(name=>/(^|[\\/])(?:\.env(?:\..*)?|library\.json|supabase-session\.json|supabase-sync\.json)$/.test(name)),'personal file included');
 for(const name of expected){const text=readArchive(archive,name).toString('utf8');assert.ok(!/sb_secret_[A-Za-z0-9_-]{16,}/.test(text),'private key literal');}
 const resources=path.dirname(archive),config=JSON.parse(fs.readFileSync(path.join(resources,'supabase-config.json')));
 assert.deepEqual(config,expectedConfig,'bundled configuration differs from explicit build input');
 const exe=path.join(resources,'..','Anime Player.exe'),pe=fs.readFileSync(exe),offset=pe.readUInt32LE(0x3c);assert.equal(pe.readUInt16LE(offset+4),0x8664,'payload is not Windows x64');
 let shaders=0;for(const file of walk(path.join(root,'shaders'))){const relative=path.relative(path.join(root,'shaders'),file);assert.equal(hash(fs.readFileSync(file)),hash(fs.readFileSync(path.join(resources,'shaders',relative))),relative);shaders++;}
 return {version,arch:'x64',sourceFiles:expected.length,shaders,config:process.argv[3]?'validated public config':'empty offline config',asarHash:hash(fs.readFileSync(archive))};
}
const files={portable:path.join(output,'AnimePlayer-portable.exe'),nsis:path.join(output,'AnimePlayer-Setup-'+version+'.exe')};
const report={version,packages:{}};
for(const [kind,file] of Object.entries(files)){
 assert.ok(fs.statSync(file).size>1000000,'missing or incomplete package');
 const dir=path.join(scratch,kind);extract(file,dir);
 let payload=dir;
 if(!walk(dir).some(item=>path.basename(item)==='app.asar')){
  const embedded=walk(dir).find(item=>/app-64\.7z$/.test(item));assert.ok(embedded,'x64 payload archive missing');payload=path.join(dir,'payload');extract(embedded,payload);
 }
 report.packages[kind]={file,bytes:fs.statSync(file).size,sha256:hash(fs.readFileSync(file)),...inspect(payload)};
}
assert.equal(report.packages.portable.asarHash,report.packages.nsis.asarHash,'package payloads differ');
const destination=path.resolve(process.argv[2]||path.join(scratch,'package-verification.json'));
fs.writeFileSync(destination,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
