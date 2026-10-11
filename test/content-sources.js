'use strict';
const assert=require('assert');const fs=require('fs');const os=require('os');const path=require('path');const http=require('http');
const {Store}=require('../src/store');const {PlayerManager}=require('../src/player');
const {discoverSeriesSources}=require('../src/source-discovery');const Language=require('../src/source-language');
const {AnimeWorldClient}=require('../src/animeworld');const {AnimeUnityClient}=require('../src/animeunity');
const {compressLibraryForCloud,expandLibraryFromCloud,mergeLibrarySnapshots}=require('../src/cloud');
const multiaudioFixture=require('./multiaudio-fixture');
const waitFor=async predicate=>{const deadline=Date.now()+15000;while(Date.now()<deadline){if(predicate())return;await new Promise(r=>setTimeout(r,60));}throw Error('Content playback timed out');};
const source=(provider,number,mode,id,url)=>({provider,number,url: url || `https://${provider}.test/film-${id}.mp4`,providerEpisodeId:provider==='animeunity'?id:String(id),
  providerSourceId:provider==='animeworld'?String(id):undefined,resolutionState:'resolved',language:Language.manualClassification(mode)?{...Language.manualClassification(mode),origin:'provider',confidence:'declared'}:undefined});
(async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anime-player-content-sources-'));const store=new Store(path.join(dir,'library.json'));let player,server;
  try {
    const film=store.addSeries({title:'A film',anilistId:800,format:'MOVIE',episodeCount:1});
    const manual='https://manual.test/saved.mp4';store.addContentSources(film.id,[{number:1,url:manual,referer:'https://headers.test/',userAgent:'Custom',language:Language.manualClassification('it')}]);
    const manualId=film.mediaParts[0].id;
    const options=[],clients={animeUnity:{findSources:async o=>{options.push(o);return[source('animeunity',7,'it',101),source('animeunity',7,'ja-sub-it',102)];}},
      animeWorld:{findSources:async o=>{options.push(o);return[source('animeworld',50,'it',201),source('animeworld',50,'ja-sub-it',202)];}}};
    const discovery=await discoverSeriesSources(film,[film.title],{store,...clients});
    assert.strictEqual(film.episodes.length,0,'provider Movie_01 creates no television episode');
    assert.strictEqual(film.mediaParts.length,1,'manual and provider complete-film links share fallback without synthetic episodes');
    const part=film.mediaParts.find(p=>p.key==='single');assert.strictEqual(part.sources.length,5);
    assert.deepStrictEqual(part.sources.filter(s=>s.provider).map(s=>s.provider),['animeunity','animeunity','animeworld','animeworld']);
    assert.deepStrictEqual(part.sources.filter(s=>s.provider).map(s=>s.providerNumber),[7,7,50,50]);
    assert.ok(options.every(o=>o.episodeCount===undefined && o.format==='MOVIE' && o.anilistId===800));
    assert.strictEqual(discovery.providers.animeunity.playbackVerified,false);
    assert.ok(film.mediaParts.find(p=>p.id===manualId).sources.some(s=>s.url===manual && s.userAgent==='Custom'));
    store.setVideoPreference(film.id,'it');player=new PlayerManager({store,paths:{userData:dir,shaderDir:''},notify:()=>{}});
    let launch;player._launch=async c=>{launch=c};await player.play(film.id,part.id);assert.strictEqual(launch.source.provider,'animeunity');
    const rotated={...launch.source,url:'https://animeunity.test/rotated.mp4?token=fixture&expires=1'};
    store.refreshSource(film.id,part.id,launch.source,rotated);player.resolveAutomaticSource=async s=>({...s,url:'https://animeunity.test/current.mp4?token=renewed-fixture',resolutionState:'resolved'});
    await player.play(film.id,part.id);assert.ok(launch.url.includes('renewed-fixture'));
    const first=launch.source;await player._fallback({...launch,series:film,ep:part,attempted:new Set([first]),requestId:player.playRequestId},'Fixture failure');
    assert.strictEqual(launch.source.provider,'animeworld','same-language fallback reaches the other provider');
    store.setVideoPreference(film.id,'ja-sub-it');await player.play(film.id,part.id);assert.strictEqual(launch.source.language.audio,'ja');
    const multi=store.addSeries({title:'Split film',format:'MOVIE',episodeCount:1});
    await discoverSeriesSources(multi,[multi.title],{store,animeUnity:{findSources:async()=>[source('animeunity',70,'it',301),source('animeunity',71,'it',302)]},
      animeWorld:{findSources:async()=>[source('animeworld',1,'it',303)]}});
    assert.strictEqual(multi.mediaParts.length,3,'split and complete releases must not share a first-part source list');
    assert.strictEqual(multi.mediaParts.find(p=>p.key.startsWith('multipart:2:') && p.key.endsWith(':1')).sources[0].providerNumber,70);
    assert.strictEqual(multi.mediaParts.find(p=>p.key==='single').sources[0].providerNumber,1);
    const versions=store.addSeries({title:'Different release layouts',format:'MOVIE',episodeCount:1});
    await discoverSeriesSources(versions,[versions.title],{store,animeUnity:{findSources:async()=>[
      source('animeunity',1,'it',310),source('animeunity',1,'ja-sub-it',311),source('animeunity',2,'ja-sub-it',312)]},animeWorld:{findSources:async()=>[]}});
    assert.strictEqual(versions.mediaParts.length,3,'a DUB complete film stays separate from a SUB two-file release');
    assert.strictEqual(versions.mediaParts.find(p=>p.key==='single').sources[0].language.audio,'it');
    assert.ok(versions.mediaParts.filter(p=>p.layout.startsWith('multipart:2:')).every(p=>p.sources[0].language.audio==='ja'));
    const differentCuts=store.addSeries({title:'Same file count, different cuts',format:'MOVIE'});
    await discoverSeriesSources(differentCuts,[differentCuts.title],{store,
      animeUnity:{findSources:async()=>[source('animeunity',10,'it',320),source('animeunity',11,'it',321)]},
      animeWorld:{findSources:async()=>[source('animeworld',20,'it',322),source('animeworld',21,'it',323)]}});
    assert.strictEqual(differentCuts.mediaParts.length,4,'same file count cannot merge provider editions with unverified cuts');
    assert.strictEqual(new Set(differentCuts.mediaParts.map(p=>p.layout)).size,2);
    const incomplete=store.addSeries({title:'Second film part temporarily unresolved',format:'MOVIE'});
    await discoverSeriesSources(incomplete,[incomplete.title],{store,animeUnity:{findSources:async()=>[{...source('animeunity',10,'it',330),providerPartNumbers:[10,11]}]},animeWorld:{findSources:async()=>[]}});
    assert.strictEqual(incomplete.mediaParts.length,1);assert.ok(incomplete.mediaParts[0].key.startsWith('multipart:2:'));
    assert.ok(!incomplete.mediaParts.some(p=>p.key==='single'),'one resolved fragment cannot become a complete work when another file failed to resolve');
    const navigation=store.addSeries({title:'Parts entered out of order',format:'MOVIE'});
    store.addContentSources(navigation.id,[{number:2,url:'https://manual.test/part2.mp4',contentPartKey:'manual:2',contentLayout:'manual'},
      {number:1,url:'https://manual.test/part1.mp4',contentPartKey:'manual:1',contentLayout:'manual'},
      {number:1,url:'https://manual.test/complete.mp4',contentPartKey:'single',contentLayout:'single'}]);
    const navPlayer=new PlayerManager({store,paths:{userData:dir,shaderDir:''},notify:()=>{}});let nextId;
    navPlayer.play=async(sid,eid)=>{nextId=eid};store.setSettings({autoplayNext:true});
    const finish=part=>{const cur={series:navigation,ep:part,pos:10,dur:10,playedSeconds:10};navPlayer.cur=cur;navPlayer._onExit(cur,{eof:true});};
    finish(navigation.mediaParts.find(p=>p.key==='manual:1'));
    assert.strictEqual(nextId,navigation.mediaParts.find(p=>p.key==='manual:2').id,'autoplay follows logical part order, regardless of insertion order');
    nextId=undefined;finish(navigation.mediaParts.find(p=>p.key==='single'));
    assert.strictEqual(nextId,undefined,'a complete film cannot autoplay into a split edition');
    const oldFilm=store.addSeries({title:'Legacy manual film',format:'MOVIE',movieSources:[{url:'https://saved.test/old-film.mp4'}]});
    const oldPart=oldFilm.mediaParts[0];store.setSources(oldFilm.id,oldPart.id,[]);store.save(true);
    const restarted=new Store(path.join(dir,'library.json'));clearTimeout(restarted._timer);
    assert.strictEqual(restarted.getSeries(oldFilm.id).mediaParts[0].sources.length,0,'removed migrated film links stay removed on restart');
    const uncertain=store.addSeries({title:'OVA with count initially unknown',format:'OVA'});
    store.addSources(uncertain.id,[{number:1,url:'https://saved.test/ova.mp4'}]);
    const knownEpisodeId=uncertain.episodes[0].id;store.setProgress(uncertain.id,knownEpisodeId,{pos:5,duration:50,watched:false});
    store.refreshSeriesMetadata(uncertain.id,{episodeCount:1});
    assert.strictEqual(uncertain.episodes.length,0);assert.strictEqual(uncertain.mediaParts[0].id,knownEpisodeId);
    assert.strictEqual(uncertain.mediaParts[0].progress.pos,5,'new one-shot metadata immediately migrates saved content without requiring restart');
    store.setProgress(film.id,part.id,{pos:7,duration:20,watched:false});store.save(true);
    const imported=new Store(path.join(dir,'import.json'));imported.importData(store.snapshot());clearTimeout(imported._timer);
    assert.strictEqual(imported.getSeries(film.id).mediaParts.find(p=>p.id===part.id).progress.pos,7);
    assert.strictEqual(imported.getSeries(film.id).mediaParts.find(p=>p.id===part.id).sources[0].providerNumber,7);
    const compact=compressLibraryForCloud(store.snapshot());assert.ok(compact.series.flatMap(s=>s.mediaParts || []).every(p=>p.sources.every(s=>!s.provider)));
    const expanded=expandLibraryFromCloud(compact);assert.ok(expanded.series.find(s=>s.id===film.id).mediaParts.find(p=>p.id===manualId).sources.some(s=>s.url===manual));
    const remote=JSON.parse(JSON.stringify(expanded));remote.series.find(s=>s.id===film.id).mediaParts.find(p=>p.id===part.id).progress={pos:9,duration:20,watched:false,updatedAt:Date.now()+1};
    assert.strictEqual(mergeLibrarySnapshots(store.snapshot(),remote).series.find(s=>s.id===film.id).mediaParts.find(p=>p.id===part.id).progress.pos,9);
    const special=store.addSeries({title:'Single special',format:'SPECIAL',episodeCount:1});
    const legacy=JSON.parse(JSON.stringify(store.snapshot()));
    legacy.series=[{id:'legacy-ova',title:'Old single OVA',format:'OVA',episodeCount:1,episodes:[{id:'saved-episode',number:1,title:'Saved title',thumb:'https://img.test/keep.jpg',sources:[{url:'https://saved.test/keep.mp4',referer:'https://headers.test/'}],progress:{pos:11,duration:100,watched:false,updatedAt:5},personalRating:9}]}];
    const legacyStore=new Store(path.join(dir,'legacy.json'));legacyStore.importData(legacy);clearTimeout(legacyStore._timer);
    assert.strictEqual(legacyStore.getSeries('legacy-ova').episodes.length,0);
    const kept=legacyStore.getSeries('legacy-ova').mediaParts[0];assert.strictEqual(kept.id,'saved-episode');assert.strictEqual(kept.progress.pos,11);assert.strictEqual(kept.personalRating,9);
    assert.strictEqual(kept.sources[0].url,'https://saved.test/keep.mp4');assert.strictEqual(kept.sources[0].referer,'https://headers.test/');
    assert.strictEqual(legacyStore.statistics().watchTime,11,'one-shot migration preserves watch time in statistics');
    legacy.series[0].episodes[0].progress={pos:22,duration:100,watched:false,updatedAt:Date.now()+100};
    const mixedLegacy=mergeLibrarySnapshots(legacyStore.snapshot(),legacy);
    legacyStore.applyCloudData(mixedLegacy,new Date().toISOString());clearTimeout(legacyStore._timer);
    assert.strictEqual(legacyStore.getSeries('legacy-ova').mediaParts[0].id,'saved-episode');
    assert.strictEqual(legacyStore.getSeries('legacy-ova').mediaParts[0].progress.pos,22,'legacy cloud progress merges into the migrated part without duplicate IDs');
    const beforePartRemoval=legacyStore.snapshot();legacyStore.deleteEpisode('legacy-ova','saved-episode');
    assert.strictEqual(mergeLibrarySnapshots(legacyStore.snapshot(),beforePartRemoval).series[0].mediaParts.length,0,'part tombstones survive cloud merging');
    await discoverSeriesSources(special,[special.title],{store,animeUnity:{findSources:async()=>[]},animeWorld:{findSources:async()=>[source('animeworld',0,'it',401)]}});
    assert.strictEqual(special.episodes.length,0);assert.strictEqual(special.mediaParts.length,1);

    // Provider film pages can identify files without television episode numbers.
    const response=body=>({ok:true,status:200,text:async()=>typeof body==='string'?body:JSON.stringify(body),json:async()=>body,headers:{get:()=>null,getSetCookie:()=>[]}});
    const aw=new AnimeWorldClient({baseUrl:'https://aw.test',fetchImpl:async url=>new URL(url).pathname.startsWith('/api/') ? response({grabber:'https://media.test/movie.mp4'}) : response(
      '<div class="servers-tabs"><span class="server-tab" data-name="9"></span></div><div class="server" data-name="9"><li class="episode"><a data-episode-id="film" data-id="file"></a></li></div>')});
    aw.lastDiscovery={errors:[]};assert.strictEqual((await aw._episodeSources('https://aw.test/play/film',{contentMode:'parts'}))[0].number,1);
    const au=new AnimeUnityClient({baseUrl:'https://au.test',fetchImpl:async url=>response(new URL(url).pathname.endsWith('/0') ? [{id:501}] : {episodes_count:1})});
    au._resolveEpisode=async ep=>({...ep,url:'https://media.test/movie.mp4'});
    assert.strictEqual((await au.getEpisodeSources({id:10,slug:'film'},{contentMode:'parts'}))[0].number,1);

    const mpv=path.join(process.env.APPDATA || '', 'Anime Player','mpv',`win32-${process.arch}`,'mpv.exe');
    if(!fs.existsSync(mpv)){console.log('Content real mpv skipped: managed binary absent.');return;}
    const body=multiaudioFixture();server=http.createServer((req,res)=>{if(req.url.startsWith('/bad')){res.writeHead(403);res.end('Failure');}else{res.writeHead(200,{'Content-Type':'video/x-matroska','Content-Length':body.length});res.end(body);}});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
    const live=store.addSeries({title:'Real film parts',format:'MOVIE',episodeCount:1});
    store.addContentSources(live.id,[source('animeunity',1,'it',601,base+'/bad?token=fixture&expires=1'),source('animeworld',1,'it',602,base+'/film.mkv')]);
    store.setSettings({mpvPath:mpv,defaultPreset:'off',autoplayNext:false,extraArgs:'--vo=null --ao=null --no-config --network-timeout=3'});store.setVideoPreference(live.id,'it');
    const events=[];player=new PlayerManager({store,paths:{userData:dir,shaderDir:''},notify:(channel,payload)=>events.push({channel,payload}),resolveAutomaticSource:async s=>({...s,url:base+'/bad?token=renewed-fixture',resolutionState:'resolved'})});
    const realPart=live.mediaParts[0];await player.play(live.id,realPart.id);
    await waitFor(()=>realPart.sources.find(s=>s.provider==='animeworld').playbackVerifiedAt);
    assert.strictEqual(player.cur.source.provider,'animeworld');assert.strictEqual(player.state().seriesId,live.id);
    assert.strictEqual(realPart.sources.find(s=>s.provider==='animeworld').mediaTracks.audio.length,2);
    await player.stopIfSeries(live.id);assert.strictEqual(player.cur,null);assert.ok(realPart.progress.pos>0);
    assert.ok(events.some(e=>e.channel==='player:source-failed'));assert.strictEqual(live.episodes.length,0);
    console.log('Content real mpv: movie part, signed URL refresh, AU 403 → AW Italian, multitrack metadata, observed playback/progress and stopIfSeries verified.');
    console.log('Content sources: film/special files, distinct multipart layouts, provider numbers, language priority/fallback, manual headers, import/cloud and numberless provider pages passed.');
  } finally {if(player?.cur)await player.stop();if(server)await new Promise(r=>server.close(r));clearTimeout(store._timer);fs.rmSync(dir,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1});
