'use strict';

// One rate-limited queue is shared by search, franchise traversal and refresh.
// Interactive search/add requests may jump ahead of queued background work.
function createAniListClient({fetchImpl=(...args)=>globalThis.fetch(...args),now=Date.now,
  sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),intervalMs=2200,maxWaitMs=90000,
  maxRetries=2,cacheMs=5*60*1000}={}){
  let nextAt=0,blockedUntil=0,spacing=intervalMs,pumping=false,wakeResolve=null;
  const queue=[],pending=new Map(),media=new Map(),searches=new Map();
  const copy=value=>structuredClone(value);
  const priority=value=>value==='interactive'?2:value==='normal'?1:0;
  const read=(cache,key)=>{const entry=cache.get(key);if(!entry||entry.expiresAt<=now()){cache.delete(key);return null;}return copy(entry.value);};
  const remember=data=>{for(const item of [data?.Media,...(data?.Page?.media||[])])if(item?.id)media.set(Number(item.id),{value:copy(item),expiresAt:now()+cacheMs});while(media.size>300)media.delete(media.keys().next().value);};
  const cooldown=headers=>{
    const retry=headers?.get('retry-after'),reset=Number(headers?.get('x-ratelimit-reset'));
    const seconds=retry==null?NaN:Number(retry),retryAt=Number.isFinite(seconds)?now()+Math.max(0,seconds)*1000:Date.parse(retry);
    const resetAt=Number.isFinite(reset)&&reset>0?reset*1000:0,deadline=Math.max(Number.isFinite(retryAt)?retryAt:0,resetAt);
    return deadline>=now()?Math.max(deadline,now()+1000):now()+60000;
  };
  const rateError=(retryAfter)=>{const seconds=Math.max(1,Number(retryAfter)||Math.ceil((blockedUntil-now())/1000));return Object.assign(new Error(`AniList ha raggiunto il limite di richieste. Riprova tra ${seconds} secondi.`),{status:429,retryAfter:seconds});};
  function wake(){if(wakeResolve){const resolve=wakeResolve;wakeResolve=null;resolve();}}
  const ordered=()=>queue.sort((a,b)=>b.priority-a.priority||a.sequence-b.sequence);
  async function pump(){
    if(pumping)return;pumping=true;
    try{
      while(queue.length){
        const delay=Math.max(0,nextAt-now(),blockedUntil-now());
        if(delay){
          const expired=queue.filter(job=>now()-job.queuedAt+delay>maxWaitMs);
          for(const job of expired){job.reject(rateError(Math.ceil(delay/1000)));pending.delete(job.key);}
          if(expired.length){for(let i=queue.length-1;i>=0;i--)if(expired.includes(queue[i]))queue.splice(i,1);if(!queue.length)continue;}
          let wakeNow;const interrupted=new Promise(resolve=>{wakeNow=resolve;wakeResolve=resolve;});
          await Promise.race([sleep(delay),interrupted]);
          if(wakeResolve===wakeNow)wakeResolve=null;
          continue;
        }
        const job=ordered().shift();if(!job)continue;
        if(now()-job.queuedAt>maxWaitMs){job.reject(rateError());pending.delete(job.key);continue;}
        const startedAt=now();nextAt=startedAt+spacing;
        let response,payload;
        try{
          response=await fetchImpl('https://graphql.anilist.co',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},
            body:JSON.stringify({query:job.query,variables:job.variables}),signal:AbortSignal.timeout(15000)});
          const limit=Number(response.headers?.get('x-ratelimit-limit'));
          if(limit>0)spacing=Math.max(intervalMs,Math.ceil(60000/limit)+100);
          nextAt=Math.max(nextAt,startedAt+spacing);
          if(response.ok)payload=await response.json();
        }catch(error){job.reject(error);pending.delete(job.key);continue;}
        const throttled=response.status===429||payload?.errors?.some(error=>Number(error.status)===429);
        if(throttled){
          const hasTiming=response.headers?.get('retry-after')!=null||response.headers?.get('x-ratelimit-reset')!=null;
          blockedUntil=Math.max(blockedUntil,hasTiming?cooldown(response.headers):now()+60000);
          if(!response.ok)await response.body?.cancel();
          job.retryAfter=Math.max(1,Math.ceil((blockedUntil-now())/1000));
          if(job.attempt++>=maxRetries){job.reject(rateError(job.retryAfter));pending.delete(job.key);}else queue.push(job);
          continue;
        }
        if(!response.ok){await response.body?.cancel();job.reject(new Error(`AniList ha risposto ${response.status}`));pending.delete(job.key);continue;}
        const remaining=response.headers?.get('x-ratelimit-remaining');
        if(remaining!=null&&Number(remaining)===0){const reset=Number(response.headers?.get('x-ratelimit-reset'))*1000;blockedUntil=Math.max(blockedUntil,reset>now()?reset:now()+60000);}
        if(payload?.errors?.length){job.reject(new Error(payload.errors[0].message));pending.delete(job.key);continue;}
        if(!payload?.data){job.reject(new Error('Risposta AniList senza metadati.'));pending.delete(job.key);continue;}
        remember(payload.data);
        if(job.variables?.s!=null){searches.set(job.key,{value:copy(payload.data),expiresAt:now()+60000});while(searches.size>50)searches.delete(searches.keys().next().value);}
        pending.delete(job.key);job.resolve(payload.data);
      }
    }finally{pumping=false;if(queue.length)void pump();}
  }
  function request(query,variables,options={}){
    const key=JSON.stringify([query,variables]),cached=read(searches,key);if(cached)return Promise.resolve(cached);
    if(pending.has(key)){const existing=pending.get(key);existing.priority=Math.max(existing.priority,priority(options.priority));return existing.promise.then(copy);}
    let resolve,reject;const promise=new Promise((res,rej)=>{resolve=res;reject=rej;});
    const job={key,query,variables,priority:priority(options.priority),sequence:request.sequence++,queuedAt:now(),attempt:0,resolve,reject,promise};
    pending.set(key,job);queue.push(job);wake();void pump();return promise.then(copy);
  }
  request.sequence=0;
  return{request,getMedia:id=>read(media,Number(id))};
}
module.exports={createAniListClient};
