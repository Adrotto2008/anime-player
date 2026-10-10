'use strict';
const assert=require('assert');const fs=require('fs');const os=require('os');const path=require('path');
const {Store,validateLibraryData}=require('../src/store');const {mergeLibrarySnapshots,compressLibraryForCloud,expandLibraryFromCloud}=require('../src/cloud');
const {parseSearchRecords,selectExactMatch:selectUnity,AnimeUnityClient}=require('../src/animeunity');
const {AnimeWorldClient,titleKey,selectExactMatch:selectWorld}=require('../src/animeworld');
const {createSeriesAdder}=require('../src/series-addition');const {discoverSeriesSources}=require('../src/source-discovery');const Ratings=require('../src/episode-ratings');
const response=body=>({ok:true,status:200,headers:{get:()=>null,getSetCookie:()=>[]},text:async()=>typeof body==='string'?body:JSON.stringify(body),json:async()=>body});
(async()=>{
  // Monster's real provider shape: title is null, title_eng carries the title.
  const monster=parseSearchRecords({records:[{id:411,title:null,title_eng:'Monster',date:'2004',episodes_count:74,slug:'monster'}]},'https://animeunity.test');
  assert.strictEqual(monster[0].title,'Monster');assert.strictEqual(selectUnity(monster,['MONSTER'],{year:2004,episodeCount:74}).id,411);
  assert.strictEqual(titleKey('進撃の巨人'),'進撃の巨人');assert.notStrictEqual(titleKey('進撃の巨人'),titleKey('モンスター'));
  assert.strictEqual(selectUnity([{id:1,title:'Monster Eater'}],['Monster']),null);
  assert.strictEqual(selectWorld([{link:'wrong',name:'Monster',year:2026,episodes:12}],['Monster'],{year:2004,episodeCount:74}),null);
  assert.strictEqual(selectWorld([{link:'1',name:'Same'},{link:'2',name:'Same'}],['Same']),null);
  assert.throws(()=>parseSearchRecords({unexpected:[]},'https://test'),'malformed payload must be an error');
  const originalFetch=global.fetch;
  try {
    global.fetch=async url=>url.includes('anilist') ? response({data:{Page:{media:[{id:19,title:{english:'Monster',romaji:'MONSTER',native:'モンスター'},synonyms:['Il mostro'],coverImage:{medium:'https://cover.test/medium.jpg'},duration:24}]}}})
      : response({data:[{attributes:{number:1,canonicalTitle:'Episode',length:41,ratingAverage:null}}],links:{}});
    const metadata=require('../src/metadata');const [media]=await metadata.searchAnime('Monster');
    assert.deepStrictEqual(media.titleAliases,['Monster','MONSTER','モンスター','Il mostro']);assert.strictEqual(media.averageDuration,1440);assert.strictEqual(media.cover,'https://cover.test/medium.jpg');
    const episodes=await metadata.fetchEpisodes({kitsuId:1,episodeCount:1});assert.strictEqual(episodes.episodes[0].rating,null);assert.strictEqual(episodes.episodes[0].duration,41);assert.strictEqual(episodes.episodes[0].durationUnit,'minutes');
  } finally {global.fetch=originalFetch;}
  const au=new AnimeUnityClient({fetchImpl:async url=>{
    if(url.endsWith('/'))return response('<meta name="csrf-token" content="token">');
    if(url.endsWith('/livesearch'))return response({records:[{id:411,title:null,title_eng:'Monster',date:'2004',episodes_count:74,slug:'monster'}]});
    if(url.includes('/info_api/') && url.includes('?'))return response([{id:111,number:1}]);
    if(url.includes('/info_api/'))return response({episodes_count:74});
    if(url.includes('/embed-url/'))throw new Error('HTTP 503 (fixture)');throw new Error('Unexpected request');
  }});
  assert.deepStrictEqual(await au.findSources({titles:['Monster'],year:2004,episodeCount:74}),[]);
  assert.strictEqual(au.lastDiscovery.status,'provider_error');
  const awCalls=[];
  const aw=new AnimeWorldClient({baseUrl:'https://animeworld.test',fetchImpl:async url=>{
    awCalls.push(url);
    if(new URL(url).pathname==='/')return response('<meta id="csrf-token" content="token">');
    if(url.includes('/api/search/'))return response({animes:[{name:'Monster Eater',link:'eater',identifier:'x',episodes:12,year:2026}]});
    if(url.includes('/search?'))return response('<div class="film-list"><a class="name" href="/play/monster.x" data-jtitle="Monster">Monster</a></div>');
    if(url.includes('/play/'))return response('<div class="info">Data di Uscita: 2004</div><div class="servers-tabs"><a class="server-tab" data-name="1"></a></div><div class="server" data-name="1"><li class="episode"><a data-episode-num="1" data-episode-id="1" data-id="9"></a></li></div>');
    if(url.includes('/api/episode/info'))return response({grabber:'https://video.test/monster-1.mp4'});throw new Error('Unexpected request '+url);
  }});
  const found=await aw.findSources({titles:['Monster'],year:2004,episodeCount:74});assert.strictEqual(found[0].number,1);
  assert.ok(awCalls.some(x=>x.includes('/search?')));assert.strictEqual(aw.lastDiscovery.status,'found');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anime-player-audit-'));const store=new Store(path.join(dir,'library.json'));
  try {
    const bc=store.addSeries({title:'Black Clover',anilistId:97940,episodeCount:170,cover:'https://cover.test/original.jpg',banner:'https://cover.test/banner.jpg'});
    const ep=store.ensureEpisode(bc,52);store.addSources(bc.id,[{number:52,url:'https://manual.test/52.mp4'}]);store.setProgress(bc.id,ep.id,{pos:100,duration:2460});
    ep.personalRating=9;store.refreshSeriesMetadata(bc.id,{cover:null,banner:'',episodeCount:170},[{number:52,duration:23,durationUnit:'minutes',durationSource:'Kitsu'}]);
    assert.strictEqual(bc.cover,'https://cover.test/original.jpg');assert.strictEqual(ep.duration,2460);assert.strictEqual(ep.durationSource,'mpv');
    store.setProgress(bc.id,ep.id,{pos:0,duration:0});assert.strictEqual(ep.progress.duration,2460);
    const chart={imdbId:'tt7441658',seasons:[{season:1,episodes:[{number:51,id:'tt9118272',rating:7.5}]},{season:2,episodes:[{number:1,id:'tt9150376',rating:7.8}]},{season:4,episodes:[{number:16,id:'tt14017100',rating:9.7}]},{season:5,episodes:[{number:1,id:'tt46662871',rating:9.4}]}]};
    bc.imdbChart=chart;Ratings.apply(bc,chart);assert.strictEqual(ep.ratingIdentity.episodeId,'tt9150376');assert.strictEqual(ep.rating,7.8);
    assert.strictEqual(Ratings.reference(bc,chart,{number:170}).episodeId,'tt14017100');assert.strictEqual(Ratings.reference(bc,chart,{number:53}),null,'missing E2 must not shift to another array item');
    assert.strictEqual(Ratings.reference({...bc,title:'Another show'}, {...chart,imdbId:'ttDifferent'},ep),null,'known AniList ID must not map to a different IMDb series');
    assert.strictEqual(Ratings.reference({title:'Wrong show',episodeCount:1},{imdbId:'tt1',title:'Actual show',seasons:[{season:1,episodes:[{id:'tt2',number:1,rating:10}]}]},{number:1}),null);
    assert.strictEqual(Ratings.target([bc],chart,2,1).episode.id,ep.id);
    const sequel=store.addSeries({anilistId:195604,title:'Black Clover Season 2',episodes:[]});store.ensureEpisode(sequel,1);
    assert.strictEqual(Ratings.target([bc,sequel],chart,5,1).series.id,sequel.id,'AniList sequel maps to IMDb S5, not S2');
    const part={id:'part',title:'Example Season 2 Part 2',episodeCount:1,episodes:[{number:1,rating:8,ratingSource:'IMDb'}]};
    Ratings.apply(part,{imdbId:'ttExample',seasons:[{season:2,episodes:[{number:1,rating:9}]}]});assert.strictEqual(part.episodes[0].rating,null);
    assert.strictEqual(ep.personalRating,9);assert.strictEqual(ep.sources[0].url,'https://manual.test/52.mp4');
    const newer={...bc,updatedAt:bc.updatedAt+10,cover:null,banner:null,episodes:[{...ep,updatedAt:ep.updatedAt+10,duration:1380,durationSource:'Kitsu'}]};
    const merged=mergeLibrarySnapshots({series:[bc]},{series:[newer]}).series[0];assert.strictEqual(merged.cover,bc.cover);assert.strictEqual(merged.episodes[0].duration,2460);
    const restored=expandLibraryFromCloud(compressLibraryForCloud({series:[merged]})).series[0];assert.strictEqual(restored.episodes[0].durationSource,'mpv');assert.strictEqual(restored.cover,bc.cover);
    const legacy=validateLibraryData({series:[{...bc,cover:null,coverImage:{large:'https://cover.test/legacy.jpg'}}]}).series[0];assert.strictEqual(legacy.cover,'https://cover.test/legacy.jpg');
    store.save(true);const reloaded=new Store(store.file);assert.strictEqual(reloaded.getEpisode(bc.id,ep.id).duration,2460);clearTimeout(reloaded._timer);
    const metadata={getAnimeBatch:async ids=>ids.map(Number).map(id=>({anilistId:id,title:id===97940?'Black Clover':'Black Clover Season 2',format:'TV',episodeCount:id===97940?170:null,related:[{id:id===97940?195604:97940,type:'ANIME',format:'TV',relation:id===97940?'SEQUEL':'PREQUEL'}]})),fetchEpisodes:async()=>({episodes:[]}),fetchImdbData:async()=>null};
    const added=await createSeriesAdder({store,metadata,sourceQueue:{enqueue:()=>{}}})({anilistId:195604});assert.strictEqual(added.id,sequel.id);assert.ok(added.lib.series.some(s=>s.anilistId===195604));
    assert.strictEqual(store.data.series.filter(s=>s.anilistId===195604).length,1);assert.strictEqual(ep.id,reloaded.getEpisode(bc.id,ep.id).id);
    let release;const wait=new Promise(r=>release=r);
    const pending=discoverSeriesSources(sequel,[],{store,animeUnity:{findSources:()=>wait},animeWorld:{findSources:async()=>{throw new Error('must not run after deletion')}}});store.deleteSeries(sequel.id);release([{number:1,url:'https://video.test/1.mp4'}]);
    assert.strictEqual((await pending).cancelled,true);assert.strictEqual(store.getSeries(sequel.id),undefined);
    console.log('Audit regressions: Monster payload/catalogue, Unicode aliases, ambiguous matches, HTTP errors, selected AniList ID/dedup, covers/cloud, explicit IMDb identity/gaps/cours and measured duration persistence verified with fixtures.');
  } finally {clearTimeout(store._timer);fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
