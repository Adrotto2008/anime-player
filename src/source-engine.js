'use strict';
const {redact,providerTitles}=require('./source-state');
let modules;
const load=()=>modules ||= Promise.all([
  import('./source-engine/providers.mjs'),import('./source-engine/identity.mjs'),
  import('./source-engine/hls.mjs'),import('./source-engine/playback.mjs'),
]).then(([providers,identity,hls,playback])=>({providers,identity,hls,playback}));

function targetFor(titles,options={}) {
  return {title:titles[0],titles,format:options.format,year:options.year,
    episodes:options.canonicalEpisodeCount??options.episodeCount,ids:{anilist:options.anilistId,mal:options.malId}};
}
function queriesFor(titles) {
  const prefix=String(titles[0]).split(/\s+/).slice(0,3).join(' ');
  return [...new Set([...titles.slice(0,3),...(titles[0].split(/\s+/).length>3?[prefix]:[])])];
}
function reconcileCategory(target,record,identity) {
  const a=identity.assessCandidate(target,record);
  const oneShot=target.episodes===1 && record.episodes===1 && ['MOVIE','OVA'].includes(target.format)
    && ['MOVIE','OVA'].includes(record.format) && a.reasons.length===1 && a.reasons[0]==='format_conflict'
    && ['mal_id_match','exact_full_title_or_verified_alias','year_match','episode_count_match'].every(e=>a.evidence.includes(e));
  return oneShot?{...record,providerFormat:record.format,format:target.format,
    formatEvidence:'same_mal_full_title_year_single_unit'}:record;
}
function legacyTarget(series,source) {
  const target=targetFor(providerTitles(series),require('./source-match').matchOptions(series));
  if(Number(series.anilistId)!==100049 || Number(series.episodeCount)!==2)return target;
  // Renew an already attached named component in the aggregate, not a new
  // guessed slot. The existing unit UUID/number and public URL remain binding.
  const pathname=new URL(source.providerTitleUrl).pathname;
  if(/memory-snow(?:\.|$)/i.test(pathname))return {title:'Re:Zero kara Hajimeru Isekai Seikatsu - Memory Snow',
    titles:['Re:Zero kara Hajimeru Isekai Seikatsu - Memory Snow','Re:Zero -Starting Life in Another World- Memory Snow'],
    format:'OVA',year:2018,episodes:1,ids:{mal:36286}};
  if(/(?:the-frozen-bond|hyouketsu-no-kizuna)(?:\.|$)/i.test(pathname))return {title:'Re:Zero kara Hajimeru Isekai Seikatsu - Hyouketsu no Kizuna',
    titles:['Re:Zero kara Hajimeru Isekai Seikatsu - Hyouketsu no Kizuna','Re:Zero -Starting Life in Another World- The Frozen Bond'],
    format:'MOVIE',year:2019,episodes:1,ids:{mal:38414}};
  return target;
}
class EngineClient {
  constructor(id,{provider}={}) {this.id=id;this.provider=provider;this.lastDiscovery={};}
  async getProvider() {
    const m=await load();
    return this.provider ||= this.id==='animeunity'?new m.providers.AnimeUnity():new m.providers.AnimeWorld();
  }
  async findSources({titles=[],episodeNumbers,...options}={}) {
    const m=await load(),provider=await this.getProvider(),target=targetFor(titles,options);
    this.lastDiscovery={status:'title_not_found',errors:[],candidates:[],episodesFound:0};
    if(!titles.length)return [];
    const queries=queriesFor(titles),records=[];
    for(const q of queries) {
      const r=await provider.search(q);
      if(!r.complete){this.lastDiscovery.status='search_incomplete';return [];}
      records.push(...r.records.map(record=>reconcileCategory(target,record,m.identity)));
    }
    const sources=[],numbers=new Set();
    // Dub and sub variants are independent user choices, not title ambiguity.
    for(const audio of ['ja','it',null]) {
      const match=m.identity.chooseCandidate(target,records.filter(r=>(r.audio||null)===audio));
      this.lastDiscovery.candidates.push(...match.assessments.map(a=>({title:a.candidate.title,id:a.candidate.providerId,
        selected:match.selected===a.candidate,reasons:a.reasons,evidence:a.evidence,decision:a.decision})));
      if(match.status!=='matched')continue;
      const work=match.selected;
      try {
        const units=await provider.units(work);
        // Preserve opaque/range/decimal labels in diagnostics; the existing
        // library has integer episode keys and cannot safely import these.
        const unitNumbers=units.map(u=>m.identity.parseEpisodeLabel(u.number)).filter(n=>n.kind==='number')
          .map(n=>Number(n.value)).filter(n=>Number.isSafeInteger(n)&&n>=0);
        for(const unit of units) {
          const label=m.identity.parseEpisodeLabel(unit.number);
          if(label.kind!=='number'){this.lastDiscovery.errors.push({phase:'unit',code:'unsupported_library_episode_label',label:label.raw});continue;}
          const number=Number(label.value);
          if(!Number.isSafeInteger(number)||number<0)continue;
          numbers.add(number);
          if(episodeNumbers&&!episodeNumbers.includes(number))continue;
          try {
            const media=await provider.resolve(work,unit);
            for(const s of media)sources.push(this.descriptor(s,work,unit,number,unitNumbers));
          }catch(e){this.lastDiscovery.errors.push({phase:'episode',number,message:redact(e.code||e.message)});}
        }
      }catch(e){this.lastDiscovery.errors.push({phase:'variant',message:redact(e.code||e.message)});}
    }
    this.lastDiscovery.episodesFound=numbers.size;this.lastDiscovery.episodeNumbers=[...numbers];
    this.lastDiscovery.status=sources.length?'found':this.lastDiscovery.errors.length?'media_unresolved':records.length?'title_rejected':'title_not_found';
    return sources;
  }
  descriptor(s,work,unit,number,numbers) {
    return {number,url:s.url,provider:this.id,providerEpisodeId:this.id==='animeunity'?Number(unit.id):String(unit.id),
      providerSourceId:s.sourceId || (s.type==='hls'?'hls':'file'),providerTitleUrl:work.url,
      referer:s.headers?.Referer,resolverReferer:s.headers?.Referer,
      resolutionState:'resolved',resolvedAt:Date.now(),providerPartNumbers:numbers,
      language:work.audio?{audio:work.audio,subtitles:work.audio==='ja'?'it':null,origin:'provider',confidence:work.audio==='it'?'declared':'suggested'}:undefined,
      engine: {version:1,type:s.type,work:{provider:work.provider,providerId:work.providerId,slug:work.slug,
        title:work.title,titles:work.titles,ids:work.ids,format:work.format,year:work.year,episodes:work.episodes,
        audio:work.audio,url:work.url,providerFormat:work.providerFormat,formatEvidence:work.formatEvidence}}};
  }
  async renewSource(source,series,episode,{signal}={}) {
    const p=await this.getProvider(),m=await load();
    let work=source.engine?.work;
    if(!work) {
      // Older descriptors are upgraded by their stable public work URL, never
      // by picking the first result of a new title search during playback.
      const u=new URL(source.providerTitleUrl||'');
      if(u.origin!==p.base)throw Error('provider_identity_conflict');
      const target=legacyTarget(series,source);
      const records=[];
      for(const q of queriesFor(target.titles)) {
        const result=await p.search(q,{signal});if(!result.complete)throw Error('search_incomplete');records.push(...result.records);
      }
      const selected=records.filter(r=>r.url===u.href).map(r=>reconcileCategory(target,r,m.identity)),
        match=m.identity.chooseCandidate({...target,audio:source.language?.audio},selected);
      if(match.status!=='matched')throw Error('legacy_source_identity_unproven');work=match.selected;
    }
    const units=await p.units(work,{signal}),unit=units.find(u=>String(u.id)===String(source.providerEpisodeId));
    if(!unit)throw Error('renewal_unit_missing');
    const media=await p.resolve(work,unit,{signal}),type=source.engine?.type;
    const chosen=media.find(s=>type?s.type===type&&(!s.sourceId||s.sourceId===source.providerSourceId)
      :s.sourceId===source.providerSourceId)||(!type?media.find(s=>s.type==='hls')||media[0]:null);
    if(!chosen)throw Error('renewal_source_missing');
    return this.descriptor(chosen,work,unit,source.providerNumber??episode.number,units.map(u=>Number(u.number)).filter(Number.isSafeInteger));
  }
}
class AnimeUnityClient extends EngineClient {constructor(options){super('animeunity',options);}}
class AnimeWorldClient extends EngineClient {constructor(options){super('animeworld',options);}}
async function prepareSource(source,{signal,audio}={}) {
  if(source.engine?.version!==1)return null;
  const m=await load(),provider=source.provider==='animeunity'?new m.providers.AnimeUnity():new m.providers.AnimeWorld();
  const media={url:source.url,type:source.engine.type,headers:{...(source.referer||source.resolverReferer?{Referer:source.referer||source.resolverReferer}:{}),
    ...(source.userAgent?{'User-Agent':source.userAgent}:{})},state:'http_media_verified'};
  if(media.type==='hls')await m.hls.inspectHls(provider.client,media,{signal,audio});
  else {
    const r=await provider.client.open(media.url,{headers:{...media.headers,Range:'bytes=0-4095'},signal});
    try {
      if(![200,206].includes(r.statusCode)||/text\/html|application\/json/i.test(r.headers['content-type']||''))throw Error('not_media');
      let b=Buffer.alloc(0);
      for await(const chunk of r){b=Buffer.concat([b,chunk.subarray(0,4096-b.length)]);if(b.length>=1024)break;}
      const valid=b.length>=12&&['ftyp','styp'].includes(b.toString('ascii',4,8))
        ||b.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))||b.length>376&&b[0]===71&&b[188]===71&&b[376]===71;
      if(!valid)throw Error('not_media');
    }finally{r.destroy();}
  }
  return m.playback.playbackProxy(provider.client,media,{signal,audio});
}
module.exports={AnimeUnityClient,AnimeWorldClient,EngineClient,prepareSource,targetFor};
