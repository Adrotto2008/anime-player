'use strict';
const assert=require('assert'); const fs=require('fs'); const os=require('os'); const path=require('path');
const {AnimeUnityClient}=require('../src/animeunity');const {AnimeWorldClient}=require('../src/animeworld');
const {Store}=require('../src/store');const Language=require('../src/source-language');
const {detectEpisodeNumber,expandPattern}=require('../src/patterns');
const {compressLibraryForCloud,expandLibraryFromCloud}=require('../src/cloud');
const episodeNumbers=[1,499,500,938,939,1000,1180];
(async()=>{
 const au=new AnimeUnityClient();au.lastDiscovery={errors:[]};const ranges=[];
 au._request=async url=>({json:async()=>{
  if(!url.includes('?'))return {episodes_count:938};
  const query=new URL(url,'https://provider.test').searchParams; const start=Number(query.get('start_range')); const end=Number(query.get('end_range'));ranges.push([start,end]);
  return Array.from({length:end-start},(_,i)=>({id:50000+start+i+1,number:start+i+1}));
 }});
 au._resolveEpisode=async episode=>({number:episode.number,providerEpisodeId:episode.id,url:`https://media.test/OnePiece_Ep_${String(episode.number).padStart(2,'0')}_ITA.mp4`,resolutionState:'resolved'});
 const dub=await au.getEpisodeSources({id:1,slug:'one-piece-ita'},{episodeNumbers});
 assert.deepStrictEqual(ranges,[[0,100],[100,200],[200,300],[300,400],[400,500],[500,600],[600,700],[700,800],[800,900],[900,938]]);
 assert.deepStrictEqual(dub.map(s=>s.number),[1,499,500,938],'provider DUB count determines available episodes; no 500-episode cutoff');
 assert.strictEqual(au.lastDiscovery.episodesFound,938);

 const response=body=>({ok:true,headers:{getSetCookie:()=>[],get:()=>null},text:async()=>typeof body==='string'?body:JSON.stringify(body),json:async()=>body});
 const aw=new AnimeWorldClient({baseUrl:'https://provider.test',fetchImpl:async value=>{
  const url=new URL(value);
  if(url.pathname==='/')return response('<meta id="csrf-token" content="fixture">');
  if(url.pathname==='/api/search/v2')return response({animes:[
   {name:'One Piece',year:'1999',episodes:'1180',dub:'0',anilistId:21,link:'one-piece',identifier:'sub'},
   {name:'One Piece (ITA)',year:'1999',episodes:'938',dub:'1',anilistId:21,link:'one-piece-ita',identifier:'dub'}]});
  if(url.pathname.startsWith('/play/')){
   const ita=url.pathname.endsWith('.dub');const total=ita?938:1180;
   return response(`<div class="info">Data di Uscita: 1999</div><div class="servers-tabs"><span class="server-tab" data-name="9"></span></div><div class="server" data-name="9">${Array.from({length:total},(_,i)=>`<li class="episode"><a data-episode-num="${i+1}" data-episode-id="${ita?'dub':'sub'}${i+1}" data-id="${ita?'d':'s'}${i+1}"></a></li>`).join('')}</div>`);
  }
  if(url.pathname==='/api/episode/info'){
   const id=url.searchParams.get('id'); const ita=id[0]==='d';const number=Number(id.slice(1));
   return response({grabber:`https://media.test/OnePiece_Ep_${String(number).padStart(ita?3:4,'0')}_${ita?'ITA':'SUB_ITA'}.mp4`});
  }
  throw new Error('Unexpected fixture endpoint');
 }});
 const found=await aw.findSources({titles:['One Piece'],anilistId:21,year:1999,episodeCount:1180,isAiring:true,episodeNumbers});
 assert.deepStrictEqual(found.filter(s=>s.language.audio==='it').map(s=>s.number).sort((a,b)=>a-b),[1,499,500,938]);
 assert.ok(found.find(s=>s.number===1&&s.language.audio==='it').url.endsWith('OnePiece_Ep_001_ITA.mp4'));
 assert.ok(found.find(s=>s.number===1&&s.language.audio==='ja').url.endsWith('OnePiece_Ep_0001_SUB_ITA.mp4'));
 assert.ok(!found.some(s=>s.url.endsWith('OnePiece_Ep_0001_ITA.mp4')),'never infer DUB padding from the franchise/SUB episode count');
 assert.ok(!found.some(s=>s.number===939&&s.language.audio==='it'),'missing dubbed episodes do not become synthesized links');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'onepiece-sources-'));const store=new Store(path.join(dir,'library.json'));
 try{
  const series=store.addSeries({title:'One Piece',episodeCount:1180,status:'RELEASING'});store.addSources(series.id,found);
  const first=series.episodes.find(ep=>ep.number===1);const ita=first.sources.find(s=>s.language.audio==='it');
  store.recordSourceTracks(series.id,first.id,ita,[{id:1,type:'audio',lang:'eng'}]);
  assert.strictEqual(Language.rankSources(first.sources,'it')[0].source,ita,'legacy saved en tag must not hide a declared single-track ITA release');
  const choice=Language.trackSelection([{id:1,type:'audio',lang:'eng'}],'it',ita);assert.ok(choice.warning);assert.ok(!choice.error);
  assert.strictEqual(ita.language.audio,'it');assert.strictEqual(ita.mediaTracks.audio[0].lang,'en','observed tag remains separate and unchanged');
  store.setVideoPreference(series.id,'it'); store.save(true);const reopened=new Store(store.file);assert.strictEqual(Language.rankSources(reopened.getEpisode(series.id,first.id).sources,'it')[0].source.language.audio,'it');clearTimeout(reopened._timer);
  const manual=store.addSeries({title:'Manual pattern',episodeCount:1180});const pattern=detectEpisodeNumber('https://manual.test/OnePiece_Ep_001_ITA.mp4',1).candidates[0].pattern;
  assert.ok(pattern.includes('{ep:3}'));store.addSources(manual.id,expandPattern(pattern,1,938).map(item=>({...item,language:Language.manualClassification('it')})));
  store.ensureEpisode(manual,939);store.ensureEpisode(manual,1180);
  const restored=expandLibraryFromCloud(compressLibraryForCloud(store.snapshot())).series.find(s=>s.id===manual.id);
  assert.ok(restored.episodes[0].sources[0].url.endsWith('OnePiece_Ep_001_ITA.mp4'));
  assert.ok(restored.episodes.find(ep=>ep.number===938).sources[0].url.endsWith('OnePiece_Ep_938_ITA.mp4'));
  assert.strictEqual(restored.episodes.find(ep=>ep.number===939).sources.length,0);
  assert.strictEqual(restored.episodes.find(ep=>ep.number===1180).sources.length,0);
 }finally{clearTimeout(store._timer);assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});}
 console.log('One Piece fixtures: SUB 1180 vs DUB 938, provider-specific padding, no fabricated DUB E939, AU pagination beyond 500, persisted en-tagged single-track ITA and three-digit cloud/manual pattern passed.');
})().catch(error=>{console.error(error);process.exitCode=1});
