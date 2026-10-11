(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EpisodeRatings = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const key = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  const baseKey = value => key(String(value || '').replace(/\b(?:season\s*\d+|\d+(?:st|nd|rd|th)\s*season|S\d+|part\s*\d+|cour\s*\d+)\b.*$/i,'').replace(/[:–-]\s*$/,''));
  // Verified AniList/IMDb ranges, independent of array position or missing pages.
  const BLACK_CLOVER = {97940:[[1,1,51,0],[2,1,51,51],[3,1,52,102],[4,1,16,154]],195604:[[5,1,Infinity,0]]};
  const coordinate = (season,number) => `${Number(season)}:${Number(number)}`;
  const uniquePut = (map,k,value) => map.set(k,map.has(k) ? null : value);
  function index(chart) {
    const coordinates=new Map(),titles=new Map(),ids=new Map(),ranges=new Map();
    for(const season of chart?.seasons || []) {
      const numbers=new Set();let contiguous=true;
      for(const episode of season.episodes || []) {
        const item={season:Number(season.season),episode},number=Number(episode.number);
        uniquePut(coordinates,coordinate(season.season,number),item);
        if(episode.id)uniquePut(ids,episode.id,item);
        if(key(episode.title))uniquePut(titles,key(episode.title),item);
        if(numbers.has(number) || !Number.isInteger(number) || number<1 || number>season.episodes.length)contiguous=false;
        numbers.add(number);
      }
      ranges.set(Number(season.season),contiguous && numbers.size===season.episodes.length ? numbers.size : null);
    }
    // Unplaced records still count against global title uniqueness, but never
    // supply invented coordinates or clickable local targets.
    for(const episode of chart?.unplacedEpisodes || [])if(key(episode.title))uniquePut(titles,key(episode.title),null);
    return {chart,coordinates,titles,ids,ranges,contexts:new WeakMap()};
  }
  function context(series,idx) {
    if(idx.contexts.has(series))return idx.contexts.get(series);
    const names=[series.title,series.altTitle,...(series.titleAliases || [])];
    const explicit=String(series.title || '').match(/season\s*(\d+)|(\d+)(?:st|nd|rd|th)\s*season|\bS(\d+)\b/i);
    const value={titleMatches:Boolean(idx.chart.title && names.some(name=>baseKey(name)===baseKey(idx.chart.title))),
      cour:/\b(?:part|cour)\b/i.test(series.title || ''),season:explicit ? Number(explicit.slice(1).find(Boolean)) : 1};
    idx.contexts.set(series,value);return value;
  }
  function reference(series, chart, episode, idx=index(chart)) {
    if (!chart?.imdbId || series.format === 'MOVIE') return null;
    if(series.imdbSelection?.confirmed && series.imdbSelection.id!==chart.imdbId)return null;
    if (BLACK_CLOVER[series.anilistId] && chart.imdbId !== 'tt7441658') return null;
    // A saved mapping addresses persistent identities, even after a title edit or
    // an incomplete refresh. Never transfer it to a different work/local unit.
    const saved=episode.ratingIdentity;
    if(saved?.episodeId && saved.imdbId===chart.imdbId && saved.seriesId===series.id
      && Number(saved.number)===Number(episode.number) && (!saved.unitId || saved.unitId===episode.id)
      && (saved.anilistId==null || String(saved.anilistId)===String(series.anilistId))) {
      const item=idx.ids.get(saved.episodeId);
      if(item)return {...saved,season:item.season,episodeNumber:Number(item.episode.number),rating:item.episode.rating};
      if(!idx.ids.has(saved.episodeId))return {...saved,rating:episode.rating};
      return {...saved,rating:episode.rating}; // Preserve identity; ambiguous index entries remain unclickable.
    }
    let matched,method;
    if (chart.imdbId === 'tt7441658' && BLACK_CLOVER[series.anilistId]) {
      for (const [season,first,last,offset] of BLACK_CLOVER[series.anilistId]) {
        const n=Number(episode.number)-offset;
        if(n>=first && n<=last){const item=idx.coordinates.get(coordinate(season,n));if(item){matched=item;method='anilist-imdb-crosswalk';break;}}
      }
    } else {
      if(chart.complete===false && chart.retrievalComplete!==true)return null;
      const ctx=context(series,idx);if(!ctx.titleMatches)return null;
      const titleMatch=episode.title ? idx.titles.get(key(episode.title)) : null;
      if(titleMatch){matched=titleMatch;method='unique-episode-title';}
      else if(chart.complete!==false && !ctx.cour && Number(series.episodeCount)>0 && idx.ranges.get(ctx.season)===Number(series.episodeCount)){
        matched=idx.coordinates.get(coordinate(ctx.season,episode.number));method='season-and-complete-episode-range';
      }
    }
    if(!matched?.episode.id)return null;
    return {imdbId:chart.imdbId,episodeId:matched.episode.id,season:matched.season,
      episodeNumber:Number(matched.episode.number),anilistId:series.anilistId ?? null,seriesId:series.id ?? null,
      ...(episode.id ? {unitId:episode.id} : {}),number:Number(episode.number),method,rating:matched.episode.rating};
  }
  function apply(series,chart,idx=index(chart)) {
    for(const episode of series.episodes || []) {
      const ref=reference(series,chart,episode,idx);
      if(episode.ratingSource==='IMDb' && !ref){episode.rating=null;episode.ratingSource=null;delete episode.ratingIdentity;}
      if(ref){
        // An absent page must not rewrite the confirmed mapping or its last vote.
        if(!idx.ids.get(ref.episodeId) && episode.ratingIdentity)continue;
        episode.ratingIdentity=ref;
        if(ref.rating!=null && Number.isFinite(Number(ref.rating))){episode.rating=Number(ref.rating);episode.ratingSource='IMDb';}
        else if(episode.ratingSource==='IMDb'){episode.rating=null;episode.ratingSource=null;}
      }
    }
    return series.episodes;
  }
  function prepare(records,chart,idx=index(chart)) {
    const targets=new Map();
    for(const series of records || [])for(const episode of series.episodes || []){
      const ref=reference(series,chart,episode,idx);
      if(ref && idx.ids.get(ref.episodeId))uniquePut(targets,coordinate(ref.season,ref.episodeNumber),{series,episode,reference:ref});
    }
    return {...idx,target:(season,number)=>targets.get(coordinate(season,number)) || null};
  }
  function target(records,chart,season,number,prepared=prepare(records,chart)) {return prepared.target(season,number);}
  return {index,reference,apply,prepare,target};
});
