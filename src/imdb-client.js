'use strict';
// Public IMDb endpoints already used by the app. No authentication or new dependency.
const cleanTitle = title => {
  let value=String(title || '').trim();
  value=value.replace(/[:–-]\s*(season\s*\d+|\d+(?:st|nd|rd|th)\s*season|the\s+final\s+season.*|final\s+season.*|part\s*\d+|cour\s*\d+|entertainment\s+district.*|swordsmith\s+village.*|hashira\s+training.*|mugen\s+train.*|shibuya\s+incident.*|yuukaku-hen.*)/gi,'');
  value=value.replace(/\s+(season\s*\d+|\d+(?:st|nd|rd|th)\s*season|the\s+final\s+season.*|final\s+season.*|part\s*\d+|cour\s*\d+|s\d+|entertainment\s+district.*|swordsmith\s+village.*|hashira\s+training.*|mugen\s+train.*|shibuya\s+incident.*|yuukaku-hen.*)\b/gi,'');
  return value.replace(/\s+(II|III|IV|V|VI)$/i,'').trim();
};
const titleKey=value=>String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const validId=id=>/^tt\d+$/.test(String(id || ''));
const rating=value=>value!=null && Number.isFinite(Number(value)) && Number(value)>=0 && Number(value)<=10 ? Number(value) : null;
function createImdbClient({fetchImpl=(...args)=>fetch(...args),timeoutMs=12000,overallTimeoutMs=120000,maxPages=80,clean=cleanTitle}={}) {
  async function load(options={}, {signal,onProgress=()=>{}}={}) {
    const deadline=Date.now()+overallTimeoutMs;const controller=new AbortController();
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    async function json(url,init={}) {
      const remaining=deadline-Date.now();if(remaining<=0)throw new Error('timeout');
      const requestController=new AbortController();const abortRequest=()=>requestController.abort();controller.signal.addEventListener('abort',abortRequest,{once:true});
      let timer,abortListener;
      const interrupted=new Promise((_,reject)=>{
        abortListener=()=>{requestController.abort();reject(new Error('cancelled'));};
        controller.signal.addEventListener('abort',abortListener,{once:true});
        timer=setTimeout(()=>{requestController.abort();reject(new Error('timeout'));},Math.min(timeoutMs,remaining));
        if(controller.signal.aborted)abortListener();
      });
      try {
        return await Promise.race([interrupted,(async()=>{
          const res=await fetchImpl(url,{...init,signal:requestController.signal});if(!res?.ok)throw new Error('http');return await res.json();
        })()]);
      } finally {clearTimeout(timer);controller.signal.removeEventListener('abort',abortListener);controller.signal.removeEventListener('abort',abortRequest);}
    }
    let targetId=options.imdbSelection?.confirmed ? options.imdbSelection.id : options.imdbId;
    let candidates=[];const nodes=new Map();let title=options.title || '',overallRating=null,voteCount=null,total=null,pages=0,complete=false,issue=null;
    const seasonsList=new Set();
    try {
      if(targetId && !validId(targetId))throw new Error('invalid-id');
      if(!targetId){
        const names=[clean(options.title),options.title,clean(options.altTitle),options.altTitle,...(options.titleAliases || [])].filter(Boolean);
        const seen=new Set(),found=new Map();let failed=false;
        for(const name of names){
          const query=String(name).toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');if(!query || seen.has(query))continue;seen.add(query);
          try {
            const data=await json(`https://v3.sg.media-imdb.com/suggestion/${query[0]}/${query}.json`,{headers:{'User-Agent':'Mozilla/5.0'}});
            if(!Array.isArray(data.d))throw new Error('response');
            for(const item of data.d){
              if(!item || typeof item!=='object')continue;
              const type=item.qid || (item.q==='TV series'?'tvSeries':null);
              const types=options.format==='MOVIE' ? ['movie','tvMovie','video'] : ['tvSeries','tvMiniSeries',...(['OVA','ONA','SPECIAL'].includes(options.format)?['tvSpecial','tvMovie','video']:[])];
              if(validId(item.id) && types.includes(type) && names.some(n=>titleKey(clean(n))===titleKey(item.l)))found.set(item.id,{id:item.id,title:item.l,year:Number.isInteger(item.y)?item.y:null,type,cast:item.s || ''});
            }
            if(found.size)break;
          } catch(error){if(['timeout','cancelled'].includes(error.message))throw error;failed=true;}
        }
        candidates=[...found.values()];
        if(!candidates.length)return {status:failed?'error':'empty',issue:failed?'search':null,candidates:[]};
        // A later season/cour's year is not the original IMDb series release year.
        const baseWork=titleKey(clean(options.title))===titleKey(options.title);
        const exactYear=baseWork && Number.isInteger(options.year) ? candidates.filter(c=>c.year===options.year) : [];
        const eligible=baseWork && Number.isInteger(options.year) ? exactYear : candidates;
        if(eligible.length!==1)return {status:'ambiguous',candidates};
        targetId=eligible[0].id;
      }
      if(options.resolveOnly)return {status:'ready',selection:candidates.find(c=>c.id===targetId) || {id:targetId,title:options.title},candidates};
      let cursor=null;const cursors=new Set();
      while(pages<maxPages){
        const cursorArg=cursor==null ? '' : `, after: ${JSON.stringify(cursor)}`;
        const query=`query { title(id: ${JSON.stringify(targetId)}) { id titleText { text } ratingsSummary { aggregateRating voteCount } episodes { seasons { number } episodes(first: 250${cursorArg}) { total pageInfo { hasNextPage endCursor } edges { node { id titleText { text } series { episodeNumber { episodeNumber seasonNumber } } ratingsSummary { aggregateRating voteCount } } } } } } }`;
        const data=await json('https://caching.graphql.imdb.com',{method:'POST',headers:{'Content-Type':'application/json','User-Agent':'Mozilla/5.0','x-imdb-client-name':'imdb-web-next-localized'},body:JSON.stringify({query})});
        const value=data?.data?.title;if(!value || value.id && value.id!==targetId)throw new Error('response');
        title=value.titleText?.text || title;overallRating=rating(value.ratingsSummary?.aggregateRating);voteCount=value.ratingsSummary?.voteCount ?? null;
        for(const season of value.episodes?.seasons || [])if(Number.isInteger(season.number) && season.number>=0)seasonsList.add(season.number);
        const page=value.episodes?.episodes || (options.format==='MOVIE' && value.episodes==null ? {edges:[],total:0,pageInfo:{hasNextPage:false}} : null);
        if(!page || !Array.isArray(page.edges))throw new Error('page');
        pages++;if(Number.isInteger(page.total) && page.total>=0){if(total!=null && total!==page.total)issue='total-changed';total=page.total;}
        else if(page.total!=null)issue='invalid-total';
        const before=nodes.size;
        for(const edge of page.edges){if(validId(edge?.node?.id) && !nodes.has(edge.node.id))nodes.set(edge.node.id,edge.node);else if(!validId(edge?.node?.id))issue='invalid-episode';}
        onProgress({phase:'loading',pages,fetched:nodes.size,total});
        if(data.errors?.length){issue='graphql';break;}
        const info=page.pageInfo;if(typeof info?.hasNextPage!=='boolean'){issue='page-info';break;}
        if(!info.hasNextPage){complete=!issue && (total==null || total===nodes.size);if(!complete && !issue)issue='total-mismatch';break;}
        if(!page.edges.length || nodes.size===before){issue='empty-page';break;}
        if(typeof info.endCursor!=='string' || !info.endCursor || cursors.has(info.endCursor) || info.endCursor===cursor){issue='cursor-loop';break;}
        cursors.add(info.endCursor);cursor=info.endCursor;
      }
      if(pages===maxPages && !complete && !issue)issue='page-limit';
    } catch(error){issue=['http','timeout','cancelled','invalid-id','response','page'].includes(error.message)?error.message:'network';}
    finally {signal?.removeEventListener('abort',abort);}
    if(!pages && !nodes.size)return {status:'error',issue:issue || 'response',candidates};
    const retrievalComplete=complete,unplacedEpisodes=[];
    const seasonsMap=new Map([...seasonsList].map(number=>[number,[]]));let mapped=0,rated=0,maxEpisodes=0;
    const positions=new Set();
    for(const node of nodes.values()){
      const n=node.series?.episodeNumber;const season=n?.seasonNumber,number=n?.episodeNumber;
      if(!Number.isInteger(season) || season<0 || !Number.isInteger(number) || number<1){
        issue ||= 'invalid-number';complete=false;unplacedEpisodes.push({id:node.id,title:node.titleText?.text || '',rating:rating(node.ratingsSummary?.aggregateRating)});continue;
      }
      const coord=`${season}:${number}`;if(positions.has(coord)){issue ||= 'duplicate-number';complete=false;}positions.add(coord);
      if(!seasonsMap.has(season))seasonsMap.set(season,[]);
      const value=rating(node.ratingsSummary?.aggregateRating);mapped++;if(value!=null)rated++;
      seasonsMap.get(season).push({id:node.id,number,title:node.titleText?.text || '',rating:value});maxEpisodes=Math.max(maxEpisodes,number);
    }
    const seasons=[...seasonsMap].sort((a,b)=>a[0]-b[0]).map(([season,episodes])=>({season,episodes:episodes.sort((a,b)=>a.number-b.number)}));
    const chart={imdbId:targetId,title,overallRating,voteCount,seasons,maxEpisodes,complete,retrievalComplete,totalEpisodes:total,fetchedEpisodes:nodes.size,mappedEpisodes:mapped,ratedEpisodes:rated,unplacedEpisodes,pages,issue,updatedAt:Date.now()};
    return {status:mapped?'ready':issue?'error':'empty',chart,complete,issue,candidates};
  }
  return {load};
}
module.exports={createImdbClient,validId,cleanTitleForImdb:cleanTitle};
