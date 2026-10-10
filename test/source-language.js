'use strict';
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
const Language = require('../src/source-language');
const { Store, validateLibraryData } = require('../src/store');
const { PlayerManager } = require('../src/player');
const { AnimeUnityClient } = require('../src/animeunity'); const { AnimeWorldClient } = require('../src/animeworld');
const { selectVariantMatches } = require('../src/source-match');
const { mergeLibrarySnapshots, compressLibraryForCloud, expandLibraryFromCloud } = require('../src/cloud');
const multiaudioFixture = require('./multiaudio-fixture');
const waitFor = async (condition, timeout = 12000) => { const start = Date.now(); while (!condition()) { if (Date.now() - start > timeout) throw new Error('Language playback timeout'); await new Promise(resolve=>setTimeout(resolve,40)); } };
const classified = (provider, mode, id, extra = {}) => ({number:1,url:`https://media.test/${provider || 'manual'}-${id}.mp4`,provider,
  ...(provider ? {providerEpisodeId:provider === 'animeunity' ? id : String(id)} : {}),resolutionState:'resolved',language:provider ? Language.classifyProvider({dub:mode === 'it'}, {}) : Language.manualClassification(mode),...extra});

(async()=>{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'anime-languages-')); const store = new Store(path.join(dir,'library.json')); let player; let server;
  try {
    const old = store.addSeries({title:'Legacy',cover:'https://cover.test/x.jpg',personalRating:8,preset:'aa-hq'});
    store.addSources(old.id,[{number:1,url:'https://manual.test/Release_Ep_01_SUB_ITA.mp4'}]);
    const oldEp = old.episodes[0]; oldEp.progress.pos = 42; oldEp.personalRating = 9;
    assert.deepStrictEqual(Language.modesFor(oldEp.sources[0]),[],'old URL spelling must not imply language');
    assert.strictEqual(old.videoPreference,null); store.save(true);
    const reopened = new Store(store.file); assert.strictEqual(reopened.getSeries(old.id).videoPreference,null); clearTimeout(reopened._timer);
    assert.strictEqual(Language.classifyProvider({}, {url:'https://media.test/Anime_SUB_ITA.mp4'}).confidence,'suggested');
    assert.strictEqual(Language.classifyProvider({}, {url:'https://media.test/Anime_ITA.mp4'}).audio,'it');
    assert.deepStrictEqual(Language.modesFor({...classified('animeunity','it',1),resolutionState:'found'}),['it']);
    assert.strictEqual(Language.availability({episodes:[{sources:[{...classified('animeunity','it',1),resolutionState:'found'}]}]}).it,0);

    // Both provider searches retrieve all safely matched variants, with ambiguity
    // still rejected independently within a version.
    const candidates = [{id:1,title:'Demo',name:'Demo',dub:false,link:'https://provider.test/sub'},
      {id:2,title:'Demo (ITA)',name:'Demo (ITA)',dub:true,link:'https://provider.test/ita'},
      {id:3,title:'Demo Movie',name:'Demo Movie',dub:true,format:'MOVIE',link:'https://provider.test/movie'}];
    assert.strictEqual(selectVariantMatches(candidates,['Demo'],{format:'TV'}).length,2);
    assert.deepStrictEqual(selectVariantMatches([...candidates,{...candidates[1],id:4,link:'https://provider.test/ita2'}],['Demo'],{format:'TV'}).map(item=>item.id),[1]);
    for (const Client of [AnimeUnityClient,AnimeWorldClient]) {
      const client = new Client(); client.search = async()=>candidates; client.searchCatalogue = async()=>[];
      const episodes = async match=>[{number:1,url:`https://media.test/${typeof match === 'string' ? match.split('/').pop() : match.id}.mp4`,resolutionState:'resolved',providerEpisodeId:typeof match === 'string' ? match : match.id}];
      client.getEpisodeSources = episodes; client._episodeSources = episodes;
      const found = await client.findSources({titles:['Demo'],format:'TV'});
      assert.deepStrictEqual(found.map(source=>source.language.audio),['ja','it']);
      assert.strictEqual(client.lastDiscovery.candidates.filter(item=>item.selected).length,2);
    }
    const renewal = new AnimeWorldClient(); renewal._ensureSession = async()=>{};
    renewal._request = async(url)=>{assert.ok(url.includes('id=s1'));return {json:async()=>({grabber:'https://media.test/renewed.mp4'})}};
    assert.strictEqual((await renewal.renewSource({providerSourceId:'s1'},1)).resolutionState,'resolved');

    const series = store.addSeries({title:'Languages',episodeCount:1});
    store.addSources(series.id,[classified('animeunity','ja-sub-it',1),classified('animeunity','it',2),classified('animeworld','it',3),classified(null,'it',4)]);
    const ep = series.episodes[0]; const events = []; let launched;
    player = new PlayerManager({store,paths:{userData:dir,shaderDir:''},notify:(channel,payload)=>events.push({channel,payload})});
    player._launch = async c=>{launched=c};
    store.setVideoPreference(series.id,'it'); await player.play(series.id,ep.id);
    assert.strictEqual(launched.source.providerEpisodeId,2,'ITA AU outranks SUB AU');
    await player._fallback(launched,'first failed'); assert.strictEqual(launched.source.provider,'animeworld','same-language AW before AU SUB');
    await player._fallback(launched,'second failed'); assert.strictEqual(launched.source.language.origin,'manual','classified manual next');
    const lastLaunch = launched; await player._fallback(launched,'third failed');
    assert.strictEqual(launched,lastLaunch,'other language cannot launch before consent');
    const pending = player.pendingLanguageFallback; assert.deepStrictEqual(pending.choices,['ja-sub-it']);
    await player.acceptLanguageFallback(pending.token,'ja-sub-it'); assert.strictEqual(launched.source.providerEpisodeId,1);
    assert.strictEqual(series.videoPreference.mode,'it','consent is episode-scoped');
    assert.strictEqual(player.acceptLanguageFallback(pending.token,'ja-sub-it'),false,'tokens are single use');

    const onlyAW = store.addSeries({title:'ITA only AW'}); store.addSources(onlyAW.id,[classified('animeunity','ja-sub-it',5),classified('animeworld','it',6)]);
    store.setVideoPreference(onlyAW.id,'it'); await player.play(onlyAW.id,onlyAW.episodes[0].id); assert.strictEqual(launched.source.provider,'animeworld');
    const onlySub = store.addSeries({title:'SUB only AU'}); store.addSources(onlySub.id,[classified('animeunity','ja-sub-it',7)]);
    store.setVideoPreference(onlySub.id,'ja-sub-it'); await player.play(onlySub.id,onlySub.episodes[0].id); assert.strictEqual(launched.source.provider,'animeunity');
    store.setVideoPreference(onlySub.id,'it'); const before = launched; await player.play(onlySub.id,onlySub.episodes[0].id); assert.strictEqual(launched,before);
    const cancelled = player.pendingLanguageFallback; await player.stop(); assert.strictEqual(player.acceptLanguageFallback(cancelled.token,'ja-sub-it'),false);
    await player.play(onlySub.id,onlySub.episodes[0].id); const stale = player.pendingLanguageFallback;
    await player.changeVideoPreference(onlySub.id,'auto'); assert.strictEqual(player.acceptLanguageFallback(stale.token,'ja-sub-it'),false);
    await player.play(old.id,oldEp.id); assert.strictEqual(launched.source,oldEp.sources[0],'auto plays unclassified legacy links');
    store.setVideoPreference(old.id,'it'); await player.play(old.id,oldEp.id); assert.deepStrictEqual(player.pendingLanguageFallback.choices,['unknown']);
    await player.acceptLanguageFallback(player.pendingLanguageFallback.token,null); assert.strictEqual(player.pendingLanguageFallback,null);

    // Stable IDs retain versions and coalesce changing signatures; editing links
    // does not strip provider IDs, language, headers, measured tracks or ratings.
    const ita = ep.sources.find(source=>source.providerEpisodeId === 2);
    ita.referer = 'https://custom.test/'; ita.userAgent = 'custom';
    store.recordSourceTracks(series.id,ep.id,ita,[{type:'audio',id:1,lang:'ita'}]);
    store.markSourcePlayback(series.id,ep.id,ita.url);
    store.addSources(series.id,[classified('animeunity','it',2,{url:'https://media.test/new.mp4?token=fixture&expires=1'})]);
    assert.strictEqual(ep.sources.length,4); assert.strictEqual(ita.mediaTracks,undefined); assert.strictEqual(ita.playbackVerifiedAt,undefined);
    assert.strictEqual(ita.referer,'https://custom.test/'); assert.strictEqual(ita.userAgent,'custom');
    store.setSources(series.id,ep.id,ep.sources.map(source=>source.url)); assert.strictEqual(ep.sources.find(source=>source === ita),ita);
    player.resolveAutomaticSource = async source=>({...source,url:'https://media.test/fresh.mp4',resolutionState:'resolved'});
    await player.play(series.id,ep.id); assert.strictEqual(launched.source,ita); assert.strictEqual(launched.url,'https://media.test/fresh.mp4');
    store.addSources(series.id,[classified('animeworld','it',3,{providerSourceId:'server1'}),classified('animeworld','it',3,{providerSourceId:'server1',url:'https://media.test/aw-new.mp4'})]);
    assert.strictEqual(ep.sources.filter(source=>source.providerSourceId === 'server1').length,1);
    store.setSourceLanguage(old.id,oldEp.id,oldEp.sources[0].url,'it');
    store.save(true); const copy = new Store(store.file); assert.strictEqual(copy.getSeries(series.id).videoPreference.mode,'it');
    assert.strictEqual(copy.getSeries(old.id).episodes[0].sources[0].language.origin,'manual'); clearTimeout(copy._timer);
    const validated = validateLibraryData(store.snapshot()); assert.strictEqual(validated.series.find(item=>item.id === series.id).videoPreference.mode,'it');
    assert.strictEqual(oldEp.progress.pos,42); assert.strictEqual(oldEp.personalRating,9); assert.strictEqual(old.personalRating,8); assert.strictEqual(old.preset,'aa-hq');

    // Field-level cloud conflict, null protection, compact/import round trip.
    const deviceA = store.snapshot(); const deviceB = store.snapshot();
    deviceA.series[0].videoPreference = {mode:'it',updatedAt:10}; deviceA.series[0].updatedAt = 100;
    deviceB.series[0].videoPreference = {mode:'ja-sub-it',updatedAt:20}; deviceB.series[0].updatedAt = 50;
    const merged = mergeLibrarySnapshots(deviceA,deviceB); assert.deepStrictEqual(merged.series[0].videoPreference,{mode:'ja-sub-it',updatedAt:20});
    assert.deepStrictEqual(mergeLibrarySnapshots(deviceB,deviceA).series[0].videoPreference,merged.series[0].videoPreference);
    assert.deepStrictEqual(Language.mergePreference({mode:'it',updatedAt:20},{mode:'ja-sub-it',updatedAt:20}),Language.mergePreference({mode:'ja-sub-it',updatedAt:20},{mode:'it',updatedAt:20}),'equal timestamps converge deterministically');
    deviceB.series[0].videoPreference = null; deviceB.series[0].updatedAt = 200;
    assert.strictEqual(mergeLibrarySnapshots(deviceA,deviceB).series[0].videoPreference.mode,'it');
    const compact = compressLibraryForCloud(deviceA); assert.ok(compact.series.every(item=>item.episodes.every(episode=>!episode.sources)));
    const restored = validateLibraryData(expandLibraryFromCloud(compact));
    assert.strictEqual(restored.series[0].episodes[0].sources[0].language.origin,'manual');
    assert.deepStrictEqual(restored.series[0].videoPreference,deviceA.series[0].videoPreference);
    const invalid = store.snapshot(); invalid.series[0].videoPreference = {mode:'wrong'}; invalid.series[0].episodes[0].sources[0].language = {audio:'it',origin:'fake',confidence:'declared'};
    const sanitized = validateLibraryData(invalid); assert.strictEqual(sanitized.series[0].videoPreference,null); assert.strictEqual(sanitized.series[0].episodes[0].sources[0].language,undefined);
    assert.ok(Language.trackSelection([{type:'audio',id:1,lang:'jpn'}],'it',ita).error);
    assert.ok(Language.trackSelection([{type:'audio',id:1,lang:'jpn'},{type:'audio',id:2}],'it',ita).error,'mixed unknown tags cannot silently keep known wrong audio');
    assert.deepStrictEqual(Language.trackSelection([{type:'audio',id:2,lang:'ita'}],'it',ita).commands,[['set_property','aid',2],['set_property','sid','no']]);
    const imported = new Store(path.join(dir,'import.json')); imported.importData(store.snapshot());
    assert.strictEqual(imported.getSeries(series.id).videoPreference.mode,'it'); assert.strictEqual(imported.getSeries(series.id).episodes[0].sources[0].providerEpisodeId,1); clearTimeout(imported._timer);
    const legacyImport = imported.snapshot(); legacyImport.series.find(item=>item.id === series.id).videoPreference = null;
    imported.importData(legacyImport); assert.strictEqual(imported.getSeries(series.id).videoPreference.mode,'it','legacy/null import preserves a valid local preference');
    imported.applyCloudData(legacyImport,new Date().toISOString()); assert.strictEqual(imported.getSeries(series.id).videoPreference.mode,'it','null cloud data cannot erase a valid preference'); clearTimeout(imported._timer);
    // Changing preference during URL renewal cancels the obsolete preparation.
    const preparing = store.addSeries({title:'Preference during renewal'});
    store.addSources(preparing.id,[classified('animeunity','it',21,{url:'https://media.test/expired.mp4?token=fixture&expires=1'}),classified('animeworld','ja-sub-it',22)]);
    store.setVideoPreference(preparing.id,'it'); let release;
    player.resolveAutomaticSource = async()=>new Promise(resolve=>{release=resolve});
    const obsolete = player.play(preparing.id,preparing.episodes[0].id);
    await player.changeVideoPreference(preparing.id,'ja-sub-it'); assert.strictEqual(launched.source.providerEpisodeId,'22');
    release(classified('animeunity','it',21)); await obsolete; assert.strictEqual(launched.source.providerEpisodeId,'22');
    console.log('Languages fixtures: all provider/priority/consent cases, renewal/dedup, persistence/migration/import, protected data and two-device cloud conflicts passed.');

    const mpvPath = path.join(process.env.APPDATA || '', 'Anime Player','mpv',`win32-${process.arch}`,'mpv.exe');
    if (!fs.existsSync(mpvPath)) { console.log('Real mpv language playback skipped: managed executable unavailable.'); return; }
    const media = multiaudioFixture(); fs.writeFileSync(path.join(dir,'multi.mkv'),media);
    server = http.createServer((req,res)=>{if (req.url.startsWith('/bad')) {res.writeHead(403);res.end('Fixture failure');} else {res.writeHead(200,{'Content-Type':'video/x-matroska','Content-Length':media.length});res.end(media);}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); const base = `http://127.0.0.1:${server.address().port}`;
    const real = store.addSeries({title:'Real language fallback'}); store.setVideoPreference(real.id,'it');
    store.addSources(real.id,[classified('animeunity','ja-sub-it',11,{url:base+'/sub.mkv'}),classified('animeunity','it',12,{url:base+'/bad?token=fixture&expires=1'}),classified('animeworld','it',13,{url:base+'/multi.mkv'})]);
    store.setSettings({mpvPath,defaultPreset:'off',autoplayNext:false,extraArgs:'--vo=null --ao=null --no-config --network-timeout=3'});
    const realEvents = []; const launches = []; let aid; let sid;
    player = new PlayerManager({store,paths:{userData:dir,shaderDir:''},notify:(channel,payload)=>realEvents.push({channel,payload}),resolveAutomaticSource:async source=>({...source,url:base+'/bad?token=renewed-fixture',resolutionState:'resolved'})});
    const launch = player._launch.bind(player); player._launch = async c=>{
      launches.push(c.source.providerEpisodeId); await launch(c); if (!player.cur) return;
      const session = player.cur.session; const onMessage = session._onMessage.bind(session);
      session._onMessage = msg=>{if(msg.event === 'property-change' && msg.name === 'aid') aid=msg.data; if(msg.event === 'property-change' && msg.name === 'sid') sid=msg.data; onMessage(msg)};
      session.on('connected',()=>{session.send(['observe_property',8,'aid']);session.send(['observe_property',9,'sid'])});
    };
    const realEp = real.episodes[0]; await player.play(real.id,realEp.id);
    await waitFor(()=>aid === 2 && player.cur?.pos > 0.2 && realEp.sources.find(source=>source.provider === 'animeworld').playbackVerifiedAt);
    assert.deepStrictEqual(launches,[12,'13'],'HTTP failure tries AW ITA before AU SUB');
    assert.strictEqual(sid,false); assert.ok(!realEvents.some(event=>event.channel === 'player:language-fallback'));
    const observed = realEp.sources.find(source=>source.provider === 'animeworld').mediaTracks;
    assert.deepStrictEqual(observed.audio.map(track=>track.lang),['ja','it']); assert.deepStrictEqual(observed.subtitles.map(track=>track.lang),['it']);
    // Native selection on the same multi-track file; no source duplication.
    store.setSources(real.id,realEp.id,[base+'/multi.mkv']); aid=null; sid=null;
    await player.changeVideoPreference(real.id,'ja-sub-it');
    await waitFor(()=>aid === 1 && sid === 1 && player.cur?.pos > 0.2);
    assert.strictEqual(realEp.sources.length,1); await player.stop();
    assert.ok(realEp.progress.pos > 0); assert.strictEqual(real.videoPreference.mode,'ja-sub-it');
    console.log('Real mpv: expired URL renewal → AU HTTP 403 → AW Italian; native aid=2, then preference change aid=1/sid=1 on the same multi-track Matroska; advancing playback observed.');
  } finally {
    if (player?.cur) await player.stop(); if (server) await new Promise(resolve=>server.close(resolve));
    clearTimeout(store._timer); fs.rmSync(dir,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1});
