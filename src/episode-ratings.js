(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EpisodeRatings = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const key = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  const baseKey = value => key(String(value || '').replace(/\b(?:season\s*\d+|\d+(?:st|nd|rd|th)\s*season|S\d+|part\s*\d+|cour\s*\d+)\b.*$/i,'').replace(/[:–-]\s*$/,''));
  // AniList 97940 is the continuous 170-episode run. IMDb partitions that run.
  // Ranges were checked against the live IMDb episode IDs and the official episode list.
  const BLACK_CLOVER = {97940:[[1,1,51,0],[2,1,51,51],[3,1,52,102],[4,1,16,154]],195604:[[5,1,Infinity,0]]};
  function reference(series, chart, episode) {
    if (!chart?.imdbId || series.format === 'MOVIE') return null;
    const seasons = chart.seasons || [];
    if (BLACK_CLOVER[series.anilistId] && chart.imdbId !== 'tt7441658') return null;
    let matched; let method;
    if (chart.imdbId === 'tt7441658' && BLACK_CLOVER[series.anilistId]) {
      for (const [season,first,last,offset] of BLACK_CLOVER[series.anilistId]) {
        const n = Number(episode.number) - offset;
        if (n >= first && n <= last) {
          const item=seasons.find(s=>Number(s.season)===season)?.episodes.find(e=>Number(e.number)===n);
          if (item) {matched={season,episode:item};method='anilist-imdb-crosswalk';break;}
        }
      }
    } else {
      const names=[series.title,series.altTitle,...(series.titleAliases || [])];
      if(!chart.title || !names.some(name=>baseKey(name)===baseKey(chart.title))) return null;
      // Prefer a unique episode title; never use the item's position in an array.
      const titleMatches = episode.title ? seasons.flatMap(s=>s.episodes.filter(e=>key(e.title)===key(episode.title)).map(e=>({season:s.season,episode:e}))) : [];
      if (titleMatches.length===1) {matched=titleMatches[0];method='unique-episode-title';}
      else if (!/\b(?:part|cour)\b/i.test(series.title || '')) {
        const explicit=String(series.title || '').match(/season\s*(\d+)|(\d+)(?:st|nd|rd|th)\s*season|\bS(\d+)\b/i);
        const number=explicit ? Number(explicit.slice(1).find(Boolean)) : 1;
        const season=seasons.find(s=>Number(s.season)===number);
        const expected=Number(series.episodeCount);
        // The full contiguous range must agree with the AniList record. A cour,
        // split season or incomplete chart cannot provide this evidence.
        if (season && expected>0 && season.episodes.length===expected
          && new Set(season.episodes.map(e=>Number(e.number))).size===expected
          && season.episodes.every(e=>Number(e.number)>=1 && Number(e.number)<=expected)) {
          const item=season.episodes.find(e=>Number(e.number)===Number(episode.number));
          if(item){matched={season:number,episode:item};method='season-and-complete-episode-range';}
        }
      }
    }
    if(!matched?.episode.id) return null;
    return {imdbId:chart.imdbId,episodeId:matched.episode.id || null,season:Number(matched.season),
      episodeNumber:Number(matched.episode.number),anilistId:series.anilistId ?? null,seriesId:series.id ?? null,
      number:Number(episode.number),method,rating:matched.episode.rating};
  }
  function apply(series,chart) {
    for(const episode of series.episodes || []) {
      const ref=reference(series,chart,episode);
      if(episode.ratingSource==='IMDb'){episode.rating=null;episode.ratingSource=null;delete episode.ratingIdentity;}
      if(ref?.rating!=null && Number.isFinite(Number(ref.rating))){episode.rating=Number(ref.rating);episode.ratingSource='IMDb';episode.ratingIdentity=ref;}
    }
    return series.episodes;
  }
  function target(records,chart,season,number) {
    const matches=[];
    for(const series of records || []) for(const episode of series.episodes || []) {
      const ref=reference(series,chart,episode);
      if(ref && ref.season===Number(season) && ref.episodeNumber===Number(number))matches.push({series,episode,reference:ref});
    }
    return matches.length===1?matches[0]:null;
  }
  return {reference,apply,target};
});
