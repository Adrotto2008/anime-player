'use strict';
const crypto = require('crypto');
const {sourceMetadata} = require('./source-state');
const Model = require('./franchise-model');
function makePart(number, title = '',key=`manual:${number}`,layout='manual') {
  return {id:crypto.randomUUID(),number,key,layout,kind:'part',title,sources:[],thumb:null,duration:0,personalRating:null,
    skipTimes:[],updatedAt:Date.now(),progress:{pos:0,duration:0,watched:false,updatedAt:0}};
}
function migrateParts(series) {
  series.mediaParts = Array.isArray(series.mediaParts) ? series.mediaParts : [];
  if(Model.singleWork(series) && (series.episodes || []).length) {
    const complete=series.episodes.length===1;
    for(const episode of series.episodes) {
      const number=Number.isSafeInteger(episode.number) && episode.number>0 ? episode.number : 1;
      const position=series.mediaParts.some(p=>p.number===number)?Math.max(...series.mediaParts.map(p=>p.number))+1:number;
      series.mediaParts.push({...episode,number:position,key:complete?'single':`legacy:${episode.number}`,layout:complete?'single':'legacy',kind:'part',
        sources:(episode.sources || []).map(source=>source.provider && source.providerNumber == null ? {...source,providerNumber:episode.number} : source)});
    }
    series.episodes=[];
  }
  if ((series.movieSources || []).length && !series.movieSourcesMigrated) {
    let part = series.mediaParts.find(p => p.key === 'single' || !p.key && p.number === 1);
    if (!part) { part = makePart(Math.max(0,...series.mediaParts.map(p=>p.number))+1,'','single','single'); series.mediaParts.push(part); }
    for (const source of series.movieSources) if (!part.sources.some(s => s.url === source.url)) {
      part.sources.push({...source,...sourceMetadata(source)});
    }
    series.movieSourcesMigrated = true;
  }
}
function partSources(sources) {
  const releases=new Map();
  const release=source=>source.providerTitleUrl || [source.language?.audio,source.language?.subtitles].join(':');
  for(const source of sources){const key=release(source);if(!releases.has(key))releases.set(key,new Set());
    const numbers=Array.isArray(source.providerPartNumbers)?source.providerPartNumbers:[source.number];
    for(const number of [...numbers,source.number])if(Number.isSafeInteger(number) && number>=0)releases.get(key).add(number);
  }
  return sources.map(source => {const numbers=[...releases.get(release(source))].sort((a,b)=>a-b);
    // Equal file counts do not prove equal cuts. Keep each multipart release
    // separate; only complete-work files can share fallback across providers.
    const releaseId=crypto.createHash('sha256').update(`${source.provider || ''}:${release(source)}`).digest('hex').slice(0,12);
    const layout=numbers.length === 1 ? 'single' : `multipart:${numbers.length}:${releaseId}`;
    return {...source,providerNumber:source.number,
    number:numbers.length === 1 ? 1 : numbers.indexOf(source.number)+1,
    contentPartKey:numbers.length === 1 ? 'single' : `${layout}:${numbers.indexOf(source.number)+1}`,
    contentLayout:layout,
    title:numbers.length > 1 ? `Part ${numbers.indexOf(source.number)+1}/${numbers.length} · ${source.provider==='animeunity'?'AnimeUnity':'AnimeWorld'}${source.language?.audio==='it'?' · ITA':source.language?.audio==='ja'?' · JAP':''}` : ''};});
}
module.exports = {makePart,migrateParts,partSources};
