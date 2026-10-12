'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const {Store}=require('../src/store');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anime-release-integrity-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
for(const [name,raw]of [['truncated','{"series": ['],['null','null'],['array','[]'],['series-type','{"series": 4}'],['settings-type','{"series":[],"settings":[]}'],['null-work','{"series":[null]}'],['bad-episodes','{"series":[{"id":"s","title":"Fixture","episodes":{}}]}'],['bad-source','{"series":[{"id":"s","title":"Fixture","episodes":[{"sources":[null]}]}]}']])test('existing '+name+' library is rejected before any write or backup',t=>{
  const dir=fixture(t),file=path.join(dir,'library.json');fs.writeFileSync(file,raw);assert.throws(()=>new Store(file),/originale non modificato/);assert.equal(fs.readFileSync(file,'utf8'),raw);assert.deepEqual(fs.readdirSync(dir),['library.json']);
});
test('first run still creates a library, and a failed account switch cannot overwrite its malformed target',t=>{
  const dir=fixture(t),file=path.join(dir,'library.json'),store=new Store(file);t.after(()=>clearTimeout(store._timer));store.addSeries({title:'Synthetic valid work',format:'TV'});store.save(true,true);
  const before=store.snapshot(),scope=store.scope,target=path.join(dir,'another-account.json'),bad='{"series":';fs.writeFileSync(target,bad);
  assert.throws(()=>store.switchFile(target),/originale non modificato/);assert.equal(store.file,file);assert.deepEqual(store.data.series,before.series);assert.ok(store.scope>scope);store.setSettings({language:'it'});store.save(true,true);assert.equal(fs.readFileSync(target,'utf8'),bad);assert.equal(new Store(file).data.series.length,1);
});
test('directory as library file is rejected, rather than treated as first run',t=>{const dir=fixture(t);assert.throws(()=>new Store(dir),/originale non modificato/);});
test('unreadable existing file is rejected without reset',t=>{
 const dir=fixture(t),file=path.join(dir,'library.json'),raw='{"series":[]}';fs.writeFileSync(file,raw);const original=fs.readFileSync;
 fs.readFileSync=function(target,...args){if(target===file){const error=Error('Synthetic access denial');error.code='EACCES';throw error;}return original.call(this,target,...args);};
 try{assert.throws(()=>new Store(file),/originale non modificato/);}finally{fs.readFileSync=original;}assert.equal(fs.readFileSync(file,'utf8'),raw);
});
test('production startup reports a corrupted file and quits before creating a window',async t=>{
 const dir=fixture(t),file=path.join(dir,'library.json'),raw='{"series":';fs.writeFileSync(file,raw);const root=path.resolve(__dirname,'..'),req=require('module').createRequire(path.join(root,'main.js')),errors=[];let bootstrap,quit=0,windows=0;
 const electron={app:{isPackaged:true,requestSingleInstanceLock:()=>true,whenReady:()=>({then:fn=>bootstrap=fn}),getPath:()=>dir,on:()=>{},quit:()=>quit++},dialog:{showErrorBox:(title,body)=>errors.push({title,body})},BrowserWindow:class{constructor(){windows++;}}};
 require('vm').runInNewContext(fs.readFileSync(path.join(root,'main.js'),'utf8'),{require:n=>n==='electron'?electron:req(n),__dirname:root,process,console,setTimeout,clearTimeout});await bootstrap();
 assert.equal(quit,1);assert.equal(windows,0);assert.equal(errors[0].title,'Libreria non aperta');assert.match(errors[0].body,/originale non modificato/);assert.equal(fs.readFileSync(file,'utf8'),raw);
});
