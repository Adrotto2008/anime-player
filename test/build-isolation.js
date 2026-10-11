'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),vm=require('vm');
const {prepareBuildConfig}=require('../scripts/build-config');
function root(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anime-build-isolation-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('offline build never reads AppData, stale resources or implicit keys',t=>{
 const dir=root(t);let reads=0;
 prepareBuildConfig({root:dir,readFile:()=>{reads++;throw Error('forbidden');}});
 assert.equal(reads,0);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'.build-resources/supabase-config.json'))),{});
 fs.writeFileSync(path.join(dir,'.build-resources/supabase-config.json'),'private stale data');
 prepareBuildConfig({root:dir,readFile:()=>{throw Error('forbidden');}});
 assert.equal(fs.readFileSync(path.join(dir,'.build-resources/supabase-config.json'),'utf8'),'{}');
});
test('explicit public client config is whitelisted; secret/session/credential configs fail closed',t=>{
 const dir=root(t),url='https://gbdcdserzrujiuacefca.supabase.co';
 const readFile=()=>JSON.stringify({url,publishableKey:'sb_publishable_fixture'});
 assert.equal(prepareBuildConfig({root:dir,configFile:'explicit.json',readFile}).publishableKey,'sb_publishable_fixture');
 for(const input of [{url,publishableKey:'sb_secret_fixture'},{url,publishableKey:'sb_publishable_fixture',access_token:'private'}, {url:'https://user:pass@gbdcdserzrujiuacefca.supabase.co',publishableKey:'sb_publishable_fixture'}, {url:'https://other.supabase.co',publishableKey:'sb_publishable_fixture'}])
   assert.throws(()=>prepareBuildConfig({root:dir,configFile:'explicit.json',readFile:()=>JSON.stringify(input)}));
 assert.throws(()=>prepareBuildConfig({root:dir,configFile:'missing.json',readFile:()=>{throw Error('ENOENT')}}));
});
test('legacy translated preference always renders original without IPC and leaves archived data intact',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../renderer/app.js'),'utf8');
 const start=source.indexOf('function displayedDescription('),end=source.indexOf('const presetLabel',start);
 const context={t:x=>x};vm.createContext(context);vm.runInContext(source.slice(start,end),context);
 const record={descriptionOriginal:'Original',description:'Legacy',descriptionTranslations:{it:{text:'Tradotto'}}};
 const before=JSON.stringify(record);assert.equal(context.displayedDescription(record),'Original');assert.equal(context.displayedDescription({description:'Legacy'}),'Legacy');
 assert.equal(JSON.stringify(record),before);assert.ok(!source.includes('series:translateDescription'));assert.ok(!source.includes('descriptionMode.value'));
 assert.ok(!fs.readFileSync(path.join(__dirname,'../preload.js'),'utf8').includes('series:translateDescription'));
});

test('source checkout selects only a local profile before any personal profile access',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
 const start=source.indexOf('// Source checkouts'),end=source.indexOf('if (!app.requestSingleInstanceLock())',start);
 const selected=[],root=path.resolve('isolated-checkout');
 vm.runInNewContext(source.slice(start,end),{app:{isPackaged:false,setPath:(name,value)=>selected.push([name,value]),getPath:()=>{throw Error('personal profile forbidden')}},fs:{mkdirSync:()=>{}},path,__dirname:root});
 assert.deepEqual(selected.map(([name])=>name),['userData','sessionData']);
 for(const [,value] of selected)assert.ok(value.startsWith(path.join(root,'.isolated-user-data')));
});
