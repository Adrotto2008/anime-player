'use strict';
const crypto=require('crypto');
const Language=require('./source-language');

// Legacy IDs are deterministic across import/reopen of the same saved unit.
// Once assigned, the ID is retained even when credentials/URLs rotate.
function sourceId(unitId,source) {
  if(typeof source.id==='string' && source.id)return source.id;
  const identity=Language.sourceIdentity(source) || `url:${source.url}`;
  const bytes=crypto.createHash('sha256').update(`${unitId}\0${identity}`).digest().subarray(0,16);
  bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;
  const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function ensureSourceIds(data) {
  for(const series of data.series || [])for(const unit of [...(series.episodes||[]),...(series.mediaParts||[])])
    for(const source of unit.sources || [])source.id=sourceId(unit.id,source);
}
function mergeSources(unitId,first=[],second=[]) {
  const result=new Map();
  for(const raw of [...first,...second]) {
    const source={...raw,id:sourceId(unitId,raw)},old=result.get(source.id);
    if(!old) {result.set(source.id,source);continue;}
    const newer=(Number(source.resolvedAt)||0)>=(Number(old.resolvedAt)||0)?source:old;
    const older=newer===source?old:source;
    result.set(source.id,{...older,...newer,
      // Device-local custom headers and manual classification are independent
      // of a resolver credential refresh.
      ...(older.language?.origin==='manual'?{language:older.language}:{}),
      ...(older.referer && older.referer!==older.resolverReferer?{referer:older.referer}:{}),
      ...(older.userAgent?{userAgent:older.userAgent}:{})});
  }
  return [...result.values()];
}
function automaticSources(unit) {
  const descriptors=new Map((unit.automaticSources || []).map(source=>[source.id,{...source}]));
  for(const source of unit.sources || [])if(source.provider) {
    const id=sourceId(unit.id,source);
    const {urlLifetime}=require('./source-state');
    descriptors.set(id,{id,provider:source.provider,...Language.metadata(source),
      ...(source.providerEpisodeId!=null?{providerEpisodeId:source.providerEpisodeId}:{}),
      ...(source.providerNumber!=null?{providerNumber:source.providerNumber}:{}),
      ...(source.referer && source.referer!==source.resolverReferer && !urlLifetime(source.referer).temporary?{referer:source.referer}:{}),
      ...(source.userAgent?{userAgent:source.userAgent}:{})});
  }
  return [...descriptors.values()];
}
function mergePersonalRating(first,second) {
  const candidates=[first,second].filter(Boolean);
  const stamped=candidates.filter(value=>Number(value.personalRatingUpdatedAt)>0);
  const winner=(stamped.length?stamped:candidates.filter(value=>value.personalRating!=null))
    .sort((a,b)=>(Number(b.personalRatingUpdatedAt || b.updatedAt)||0)-(Number(a.personalRatingUpdatedAt || a.updatedAt)||0))[0];
  return winner?{personalRating:winner.personalRating,...(stamped.length?{personalRatingUpdatedAt:winner.personalRatingUpdatedAt}:{})}:{};
}
// Rebase only edits made after the transmitted snapshot onto the acknowledged
// merge. IDs, not display keys/numbers, identify elements in persistent arrays.
function rebase(base,local,incoming) {
  if(JSON.stringify(base)===JSON.stringify(local))return incoming;
  if(Array.isArray(local) && Array.isArray(base) && Array.isArray(incoming)
    && [...base,...local,...incoming].every(item=>item && typeof item.id==='string')) {
    const key=item=>item.seriesId?`${item.seriesId}:${item.id}`:item.id;
    const b=new Map(base.map(item=>[key(item),item])),l=new Map(local.map(item=>[key(item),item])),r=new Map(incoming.map(item=>[key(item),item]));
    const result=[];
    for(const id of new Set([...r.keys(),...l.keys()])) {
      if(b.has(id) && !l.has(id))continue; // an explicit local deletion
      const value=l.has(id)?rebase(b.get(id),l.get(id),r.get(id)):r.get(id);
      if(value!==undefined)result.push(value);
    }
    return result;
  }
  if(base && local && incoming && !Array.isArray(local) && !Array.isArray(incoming)
    && typeof base==='object' && typeof local==='object' && typeof incoming==='object') {
    const result={};
    for(const key of new Set([...Object.keys(incoming),...Object.keys(local),...Object.keys(base)])) {
      const value=rebase(base[key],local[key],incoming[key]);
      if(value!==undefined)result[key]=value;
    }
    return result;
  }
  return local;
}
module.exports={sourceId,ensureSourceIds,mergeSources,automaticSources,mergePersonalRating,rebase};
