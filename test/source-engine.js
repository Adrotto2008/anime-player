'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),path=require('path'),os=require('os');
const {EngineClient}=require('../src/source-engine'),{Store}=require('../src/store');
const work={provider:'animeunity',providerId:'8',slug:'sample',title:'Sample',titles:['Sample'],
  format:'TV',year:2020,episodes:2,ids:{mal:123},audio:'ja',url:'https://example.test/anime/8-sample'};
const unit={provider:'animeunity',workId:'8',id:'9',number:'1'};
function client(overrides={}) {return new EngineClient('animeunity',{provider:{base:'https://example.test',
  search:async()=>({records:[work],complete:true}),units:async()=>[unit],resolve:async()=>[
    {url:'https://cdn.test/a.m3u8',type:'hls',headers:{Referer:'https://embed.test/'}},
    {url:'https://cdn.test/a.mp4',type:'file',headers:{Referer:'https://embed.test/'}}],...overrides}});}
const options={titles:['Sample'],format:'TV',year:2020,episodeCount:2,malId:123};
test('new source engine keeps HLS and file identities distinct and survives Store reopening',async t=>{
  const results=await client().findSources(options);assert.equal(results.length,2);assert.notEqual(results[0].providerSourceId,results[1].providerSourceId);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'source-engine-')),store=new Store(path.join(dir,'library.json'));
  t.after(()=>{clearTimeout(store._timer);fs.rmSync(dir,{recursive:true,force:true});});
  const s=store.addSeries({title:'Sample',format:'TV'});store.addSources(s.id,results);store.save(true);
  const reopened=new Store(store.file);clearTimeout(reopened._timer);
  assert.equal(reopened.getSeries(s.id).episodes[0].sources.length,2);
  assert.equal(reopened.getSeries(s.id).episodes[0].sources[0].engine.work.providerId,'8');
});
test('new source engine refuses conflicting catalog IDs even when the title matches',async()=>{
  assert.deepEqual(await client().findSources({...options,malId:999}),[]);
});
test('new source engine refuses incomplete searches',async()=>{
  const c=client({search:async()=>({records:[work],complete:false})});assert.deepEqual(await c.findSources(options),[]);assert.equal(c.lastDiscovery.status,'search_incomplete');
});
test('new source engine never rounds decimals, ranges or beta labels into an integer episode',async()=>{
  const c=client({units:async()=>['1.5','2-3','23β'].map((number,i)=>({...unit,id:String(i),number}))});
  assert.deepEqual(await c.findSources(options),[]);assert.equal(c.lastDiscovery.errors.length,3);
});
test('new source engine renews the same immutable work/unit and requested media type',async()=>{
  let searches=0;const c=client({search:async()=>{searches++;return{records:[work],complete:true};}});
  const sources=await c.findSources(options),before=searches;
  const renewed=await c.renewSource(sources[1],{title:'Wrong newer title'},{number:99});
  assert.equal(searches,before);assert.equal(renewed.providerEpisodeId,9);assert.equal(renewed.engine.type,'file');
});
test('new source engine stops renewal if the original provider episode disappears',async()=>{
  const c=client(),sources=await c.findSources(options);c.provider.units=async()=>[];
  await assert.rejects(c.renewSource(sources[0],{title:'Sample'},{number:1}),/renewal_unit_missing/);
});
test('source engine keeps one-shot count evidence and avoids an unbounded Re query',async()=>{
  const queries=[],movie={...work,title:'Re:Zero - Memory Snow',titles:['Re:Zero - Memory Snow'],format:'OVA',episodes:1};
  const c=client({search:async q=>{queries.push(q);return{records:[movie],complete:true};}});
  const sources=await c.findSources({titles:[movie.title],format:'OVA',year:2020,malId:123,canonicalEpisodeCount:1});
  assert.equal(sources.length,2);assert.ok(!queries.includes('Re'));
  assert.deepEqual(await c.findSources({titles:[movie.title],format:'OVA',year:2020,malId:123,canonicalEpisodeCount:2}),[]);
});
test('theatrical OVA/Movie category needs exact MAL, year, title and singleton evidence',async()=>{
  const r={...work,format:'MOVIE',episodes:1};
  const c=client({search:async()=>({records:[r],complete:true})});
  const target={...options,format:'OVA',canonicalEpisodeCount:1};
  assert.equal((await c.findSources(target)).length,2);
  for(const patch of [{malId:999},{year:2021},{titles:['Wrong']},{canonicalEpisodeCount:2}])
    assert.deepEqual(await c.findSources({...target,...patch}),[]);
  c.provider.search=async()=>({records:[{...r,ids:{},year:null}],complete:true});
  assert.deepEqual(await c.findSources(target),[]);
});
test('legacy ReZero aggregate renews only its already attached named component, keeping its unit number',async()=>{
  const r={...work,title:'Re:Zero -Starting Life in Another World- Memory Snow',
    titles:['Re:Zero -Starting Life in Another World- Memory Snow','Re:Zero kara Hajimeru Isekai Seikatsu - Memory Snow'],
    format:'OVA',year:2018,episodes:1,ids:{mal:36286,anilist:100049},url:'https://example.test/anime/809-rezero-memory-snow'};
  const c=client({search:async()=>({records:[r],complete:true})});
  const source={provider:'animeunity',providerEpisodeId:9,providerTitleUrl:r.url};
  const series={title:'Re:Zero OVA',format:'OVA',year:2018,episodeCount:2,anilistId:100049};
  const fresh=await c.renewSource(source,series,{number:2});assert.equal(fresh.number,2);assert.equal(fresh.providerEpisodeId,9);
  assert.equal(series.episodeCount,2);assert.equal(fresh.engine.work.title,r.title);
  await assert.rejects(c.renewSource({...source,providerTitleUrl:'https://example.test/anime/other'},series,{number:2}),/legacy_source_identity_unproven/);
});
