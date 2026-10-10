'use strict';
const assert = require('assert');
const fs = require('fs'); const path = require('path'); const os = require('os'); const http = require('http');
const { Store, validateLibraryData } = require('../src/store');
const { AnimeUnityClient, selectExactMatch: unityMatch } = require('../src/animeunity');
const { selectExactMatch: worldMatch } = require('../src/animeworld');
const { discoverSeriesSources } = require('../src/source-discovery');
const { PlayerManager } = require('../src/player'); const { MpvSession } = require('../src/mpv');
const { providerTitles, urlLifetime, redact, candidateDiagnostics } = require('../src/source-state');
const { titleKey } = require('../src/animeworld');

async function waitFor(test, timeout = 15000) {
  const start = Date.now();
  while (!test()) { if (Date.now()-start > timeout) throw new Error('Playback test timed out'); await new Promise(resolve => setTimeout(resolve, 50)); }
}
function wav() {
  const n = 8000; const b = Buffer.alloc(44+n*2);
  b.write('RIFF'); b.writeUInt32LE(b.length-8,4); b.write('WAVEfmt ',8); b.writeUInt32LE(16,16);
  b.writeUInt16LE(1,20); b.writeUInt16LE(1,22); b.writeUInt32LE(8000,24); b.writeUInt32LE(16000,28);
  b.writeUInt16LE(2,32); b.writeUInt16LE(16,34); b.write('data',36); b.writeUInt32LE(n*2,40); return b;
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'anime-source-lifecycle-'));
  const store = new Store(path.join(dir,'library.json')); let player; let server;
  try {
    assert.deepStrictEqual(urlLifetime('https://media.test/x.mp4?token=secret&expires=123'),{temporary:true,expiresAt:123000});
    assert.ok(!redact('HTTP https://media.test/x?token=secret&expires=123').includes('secret'));
    const series = store.addSeries({title:'Re:ZERO -Starting Life in Another World- Season 2',anilistId:108632,year:2020,episodeCount:13});
    const aliases = providerTitles(series); const candidate = {id:2458,title:'Re:Zero kara Hajimeru Isekai Seikatsu 2',year:2020,episodeCount:13,dub:false};
    assert.strictEqual(unityMatch([candidate],aliases,{year:2020,episodeCount:13}),candidate);
    assert.strictEqual(worldMatch([{...candidate,name:candidate.title,episodes:13,link:'https://aw.test/season2'}],aliases,{year:2020,episodeCount:13}).name,candidate.title);
    assert.strictEqual(unityMatch([{...candidate,year:2016}],aliases,{year:2020,episodeCount:13}),null);
    assert.strictEqual(unityMatch([{...candidate,episodeCount:25}],aliases,{year:2020,episodeCount:13}),null);
    assert.strictEqual(unityMatch([candidate,{...candidate,id:9}],aliases,{year:2020,episodeCount:13}),null);
    assert.ok(!providerTitles({title:'Unrelated Season 2',anilistId:999}).includes(candidate.title));
    for (const [id,title,year,count] of [[195604,'Black Clover 2',2026,null],[119661,'Re:Zero kara Hajimeru Isekai Seikatsu 2 Part 2',2021,12],[189046,'Re:Zero kara Hajimeru Isekai Seikatsu 4',2026,19]]) {
      const names=providerTitles({anilistId:id,title:'AniList title'});const item={id:1,title,name:title,year,episodeCount:count,episodes:count,link:'season',dub:false};
      assert.strictEqual(unityMatch([item],names,{year,episodeCount:count}),item);
      assert.strictEqual(worldMatch([item],names,{year,episodeCount:count}),item);
      assert.strictEqual(worldMatch([{...item,year:year-1}],names,{year,episodeCount:count}),null);
    }
    const reasons = candidateDiagnostics([{...candidate,year:2016,episodeCount:25}],aliases,{year:2020,episodeCount:13},null,titleKey)[0].reasons;
    assert.deepStrictEqual(reasons,['year_mismatch','episode_count_mismatch']);

    const response = (text,type='text/html',status=200) => ({ok:status===200,status,headers:{get:()=>type},text:async()=>text});
    const au = new AnimeUnityClient({fetchImpl:async()=>response('<html>no media</html>')});
    au._request = async()=>response('https://embed.test/1?token=secret'); au.lastDiscovery={errors:[]};
    const unresolved = await au._resolveEpisode({number:1,id:123},'https://www.animeunity.so/');
    assert.strictEqual(unresolved.resolutionState,'found'); assert.ok(au.lastDiscovery.errors.some(e=>e.phase==='resolve'));
    let cancelled=false;
    au.fetch = async()=>({ok:true,url:'https://media.test/1.mp4',headers:{get:()=> 'video/mp4'},body:{cancel:async()=>{cancelled=true}},text:async()=>{throw new Error('Must not download video')}});
    assert.strictEqual((await au._resolveEpisode({number:1,id:123},'https://www.animeunity.so/')).resolutionState,'resolved'); assert.ok(cancelled);
    au.fetch=async()=>response('', 'text/html',403);
    assert.strictEqual((await au._resolveEpisode({number:1,id:123},'https://www.animeunity.so/')).resolutionState,'found');
    const discovery=await discoverSeriesSources(series,[],{store,animeUnity:{findSources:async()=>[unresolved]},animeWorld:{findSources:async()=>[{number:1,url:'https://aw.test/1.mp4',resolutionState:'resolved'},{number:99,url:'https://aw.test/99.mp4'}]}});
    assert.strictEqual(discovery.providers.animeunity.linksFound,1); assert.strictEqual(discovery.providers.animeunity.linksResolved,0);
    assert.strictEqual(discovery.providers.animeunity.status,'media_unresolved');
    assert.deepStrictEqual(discovery.providers.animeworld.rejectedSources,[{number:99,reasons:['episode_out_of_range']}]);
    assert.strictEqual(series.episodes[0].sources[0].provider,'animeworld');

    store.addSources(series.id,[{number:1,url:'https://media.test/1.mp4?token=old&expires=123',provider:'animeunity',providerEpisodeId:123,resolutionState:'resolved',referer:'https://embed.test/1?token=old',resolverReferer:'https://embed.test/1?token=old'}]);
    const ep=series.episodes[0]; const source=ep.sources[0];
    store.addSources(series.id,[{number:1,url:'https://manual.test/custom.mp4'}]);
    const manual=JSON.stringify(ep.sources.find(x=>!x.provider));
    ep.personalRating=8; ep.progress={pos:60,duration:1000,watched:false,updatedAt:42};
    const progress=JSON.stringify(ep.progress);
    store.markSourcePlayback(series.id,ep.id,source.url);
    store.addSources(series.id,[{number:1,url:'https://media.test/1.mp4?token=new&expires=9999999999',provider:'animeunity',providerEpisodeId:123,resolutionState:'resolved',referer:'https://embed.test/1?token=new',resolverReferer:'https://embed.test/1?token=new'}]);
    assert.strictEqual(ep.sources.filter(x=>x.provider==='animeunity').length,1,'rotation updates the stable episode locator');
    assert.ok(!source.playbackVerifiedAt,'verification cannot transfer to a different URL');
    assert.strictEqual(source.referer,'https://embed.test/1?token=new');
    assert.strictEqual(JSON.stringify(ep.progress),progress); assert.strictEqual(ep.personalRating,8);
    assert.strictEqual(JSON.stringify(ep.sources.find(x=>!x.provider)),manual);
    source.referer='https://custom.test/';source.userAgent='custom';
    store.refreshSource(series.id,ep.id,source,{...source,url:'https://media.test/1.mp4?token=next',referer:'https://embed.test/1?token=next',resolverReferer:'https://embed.test/1?token=next'});
    assert.strictEqual(source.referer,'https://custom.test/');assert.strictEqual(source.userAgent,'custom');
    store.markSourceFailure(series.id,ep.id,source.url,{error:'HTTP https://media.test/1.mp4?token=secret',code:2});
    const validated=validateLibraryData(store.snapshot()); assert.ok(validated.series[0].episodes[0].sources[0].playbackFailedAt);
    assert.ok(!source.playbackError.includes('secret'));store.save(true);
    assert.strictEqual(new Store(store.file).getSeries(series.id).episodes[0].sources[0].providerEpisodeId,123);

    // Preparation failure skips duplicate AU tokens and tries the available AW link.
    store.addSources(series.id,[{number:1,url:'https://media.test/duplicate.mp4?token=other',provider:'animeunity'}]);
    player=new PlayerManager({store,paths:{shaderDir:'',userData:dir},notify:()=>{},resolveAutomaticSource:async()=>{throw new Error('Expired signature')}});
    let launched;player._launch=async c=>{launched=c};await player.play(series.id,ep.id);
    assert.strictEqual(ep.sources[launched.sourceIndex].provider,'animeworld');
    let release;const pending=new Promise(resolve=>{release=resolve});
    player.resolveAutomaticSource=async()=>pending;launched=null;
    const cancelledPlay=player.play(series.id,ep.id);await player.stop();
    release({...source,resolutionState:'resolved'});await cancelledPlay;
    assert.strictEqual(launched,null,'Stop must cancel pending URL refresh');
    const ipc=new MpvSession({});ipc.quit=()=>{ipc.quitCalled=true};ipc._onMessage({event:'end-file',reason:'error',file_error:'cannot open https://host.test/1?token=secret'});
    assert.ok(ipc.quitCalled);assert.ok(!ipc.error.includes('secret'));
    console.log('Source lifecycle fixtures: unresolved embeds, direct media without download, strict aliases, exclusions, token rotation/import, protected user data and preparation fallback passed.');

    const mpvPath=path.join(process.env.APPDATA||'','Anime Player','mpv',`win32-${process.arch}`,'mpv.exe');
    if(!fs.existsSync(mpvPath)){console.log('Real mpv fallback skipped: managed executable unavailable.');return}
    const audio=wav();server=http.createServer((req,res)=>{if(req.url.startsWith('/bad')){res.writeHead(403,{'Content-Type':'text/html'});res.end('Expired signature')}else{res.writeHead(200,{'Content-Type':'audio/wav','Content-Length':audio.length});res.end(audio)}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
    const real=store.addSeries({title:'Real fallback',episodeCount:1});
    store.addSources(real.id,[{number:1,url:base+'/bad?token=secret',provider:'animeunity',resolutionState:'resolved'},{number:1,url:base+'/duplicate?token=other',provider:'animeunity',resolutionState:'resolved'},{number:1,url:base+'/ok.wav',provider:'animeworld',resolutionState:'resolved'}]);
    const realEp=real.episodes[0];const failures=[];const launches=[];
    store.setSettings({mpvPath,defaultPreset:'off',autoplayNext:false,extraArgs:'--vo=null --ao=null --no-config --network-timeout=3'});
    player=new PlayerManager({store,paths:{shaderDir:'',userData:dir},notify:(channel,payload)=>{if(channel==='player:source-failed')failures.push(payload)},resolveAutomaticSource:async source=>({...source,url:base+'/bad?token=refreshed',resolutionState:'resolved'})});
    const launch=player._launch.bind(player);player._launch=async c=>{launches.push(c.sourceIndex);return launch(c)};
    await player.play(real.id,realEp.id);await waitFor(()=>realEp.progress.watched && !player.cur);
    assert.deepStrictEqual(launches,[0,2]); assert.ok(Number.isInteger(failures[0].code), `mpv failure exit code was not retained: ${failures[0].code}`);
    assert.ok(realEp.sources[0].playbackFailedAt);assert.ok(realEp.sources[2].playbackVerifiedAt);
    assert.ok(!realEp.sources[1].playbackVerifiedAt);
    assert.ok(!JSON.stringify(failures).includes('refreshed'));
    console.log('Real mpv: HTTP 403 exit 2 → AnimeWorld WAV (advancing time/duration observed), failed state retained and duplicate token skipped.');
  } finally {
    if(player?.cur)await player.stop();if(server)await new Promise(resolve=>server.close(resolve));
    clearTimeout(store._timer); fs.rmSync(dir,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1});
