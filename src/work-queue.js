'use strict';

function createWorkQueue({concurrency=2,schedule=setImmediate}={}){
  const jobs=new Map(),pending=[];let active=0,sequence=0;
  const priority=value=>value==='interactive'?2:value==='normal'?1:0;
  const valid=job=>!job.cancelled&&[...job.subscribers].some(check=>{try{return check();}catch{return false;}});
  function pump(){
    while(active<concurrency&&pending.length){pending.sort((a,b)=>b.priority-a.priority||a.sequence-b.sequence);const job=pending.shift();
      if(!valid(job)){job.resolve({cancelled:true});jobs.delete(job.key);continue;}
      active++;job.state='running';
      Promise.resolve().then(()=>job.run({signal:job.controller.signal,isCurrent:()=>valid(job)}))
        .then(result=>job.resolve(valid(job)?result:{cancelled:true}),error=>job.reject(error))
        .finally(()=>{active--;jobs.delete(job.key);pump();});
    }
  }
  function enqueue(key,run,{priority:level='background',isCurrent=()=>true}={}){
    key=String(key);
    if(jobs.has(key)){const job=jobs.get(key);job.priority=Math.max(job.priority,priority(level));job.subscribers.add(isCurrent);pump();return job.promise;}
    let resolve,reject;const promise=new Promise((res,rej)=>{resolve=res;reject=rej;});
    const job={key,run,priority:priority(level),sequence:sequence++,subscribers:new Set([isCurrent]),controller:new AbortController(),state:'pending',resolve,reject,promise,cancelled:false};
    jobs.set(key,job);pending.push(job);schedule(pump);return promise;
  }
  function cancel(keys){for(const key of keys||[]){const job=jobs.get(String(key));if(!job||valid(job))continue;job.cancelled=true;job.controller.abort();if(job.state==='pending'){const index=pending.indexOf(job);if(index>=0)pending.splice(index,1);jobs.delete(job.key);job.resolve({cancelled:true});}}}
  return{enqueue,cancel,get size(){return jobs.size;},get active(){return active;}};
}
module.exports={createWorkQueue};
