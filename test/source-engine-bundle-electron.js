'use strict';
// Native Electron loader probe against the actual app.asar. Does not bootstrap
// the production main program, personal Store, cloud or authentication.
const {app}=require('electron'),fs=require('fs'),path=require('path'),assert=require('assert');
const archive=process.argv.find(s=>s.startsWith('--archive=')).slice(10);
const output=process.argv.find(s=>s.startsWith('--output=')).slice(9);
const profile=process.argv.find(s=>s.startsWith('--profile=')).slice(10);
fs.mkdirSync(profile,{recursive:true});app.setPath('userData',profile);
app.whenReady().then(async()=>{
  try {
    const {EngineClient}=require(path.join(archive,'src','source-engine.js'));
    const work={provider:'animeunity',providerId:'8',slug:'sample',title:'Sample',titles:['Sample'],
      format:'TV',year:2020,episodes:1,ids:{mal:123},audio:'ja',url:'https://fixture.test/anime/8-sample'};
    const client=new EngineClient('animeunity',{provider:{search:async()=>({records:[work],complete:true}),
      units:async()=>[{provider:'animeunity',workId:'8',id:'9',number:'1'}],
      resolve:async()=>[{type:'hls',url:'https://fixture.test/master.m3u8',headers:{Referer:'https://fixture.test/'}}]}});
    const result=await client.findSources({titles:['Sample'],format:'TV',year:2020,episodeCount:1,malId:123});
    assert.equal(result.length,1);assert.equal(result[0].engine.version,1);
    fs.writeFileSync(output,JSON.stringify({ok:true,electron:process.versions.electron,node:process.versions.node,
      archive,modules:'native ESM source engine, providers, HTTP, AST parser, HLS parser and proxies loaded inside app.asar',
      fixtureSources:result.length,scope:'loader and contract; offline mocked public provider data; no playback or personal profile'},null,2));
  }catch(e){fs.writeFileSync(output,JSON.stringify({ok:false,error:e.message},null,2));process.exitCode=1;}
  app.quit();
});
