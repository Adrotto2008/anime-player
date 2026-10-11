'use strict';
const crypto=require('crypto');
const PHASES=['identification','metadata','franchise','library','additionalMetadata','sources'];
const clone=value=>structuredClone(value);

function createAdditionOperationService({store,addSeries,notify=()=>{},schedule=setImmediate,maxCompleted=24}){
  const tasks=new Map();let observedScope=store.scope;
  const snapshot=task=>({id:task.id,title:task.title,status:task.status,phase:task.phase,stages:clone(task.stages),
    seriesId:task.seriesId,seriesIds:[...task.seriesIds],createdAt:task.createdAt,updatedAt:task.updatedAt,
    attempt:task.attempt,message:task.message,summary:clone(task.summary)});
  const send=(task,type='progress',extra={})=>{task.updatedAt=Date.now();try{notify({type,task:snapshot(task),...extra});}catch(error){console.warn('Addition progress notification failed:',error.message);}};
  const freshStages=()=>Object.fromEntries(PHASES.map(phase=>[phase,{status:'pending',done:0,total:null,items:[]}])) ;
  function settleCore(task,result){if(task.coreSettled)return;task.coreSettled=true;task.resolveCore(result);}
  function valid(task,generation,scope){return task.generation===generation&&!task.controller.signal.aborted&&store.scope===scope;}
  function launch(task,payload){
    const generation=++task.generation,scope=store.scope,controller=new AbortController();task.controller=controller;
    task.status='running';task.phase='identification';task.message='';task.stages=freshStages();if(task.attempt===1){task.seriesId=null;task.seriesIds=[];}task.summary={};
    task.children=[];task.cancelHooks=[];task.coreSettled=false;
    task.corePromise=new Promise(resolve=>task.resolveCore=resolve);
    let resolveDone;task.donePromise=new Promise(resolve=>{resolveDone=resolve;task.resolveDone=resolve;});
    const current=()=>valid(task,generation,scope);
    const report=({phase,status='running',done,total,detail,itemId}={})=>{
      if(!current()||!PHASES.includes(phase))return;
      task.phase=phase;const stage=task.stages[phase];stage.status=status;
      if(Number.isFinite(done))stage.done=Math.max(stage.done,Math.max(0,done));
      if(Number.isFinite(total))stage.total=Math.max(0,total);else if(total===null)stage.total=null;
      if(itemId && detail)stage.items=stage.items.filter(item=>item.id!==itemId).concat({id:itemId,detail});
      send(task);
    };
    const track=(phase,itemId,promise)=>{
      if(!current())return Promise.resolve({cancelled:true});
      const stage=task.stages[phase];if(!stage)return Promise.resolve({cancelled:true});
      stage.status='running';stage.total=(stage.total||0)+1;stage.items.push({id:String(itemId),status:'pending'});task.phase=phase;send(task);
      const raw=typeof promise==='function'?Promise.resolve().then(()=>current()?promise({signal:controller.signal,isCurrent:current}):{cancelled:true}):Promise.resolve(promise);
      const wrapped=raw.then(result=>{
        if(!current())return{cancelled:true};
        stage.done++;const item=stage.items.find(entry=>entry.id===String(itemId));if(item)item.status=result?.cancelled?'cancelled':result?.unavailable||['error','partial'].includes(result?.status)?'partial':'completed';
        if(result?.unavailable||['error','partial'].includes(result?.status)){stage.status='partial';task.message='partial';}
        else if(stage.done===stage.total && stage.status!=='partial')stage.status='completed';
        if(result?.episodesFound!=null){task.summary.episodesFound=(task.summary.episodesFound||0)+Number(result.episodesFound||0);task.summary.episodesAdded=(task.summary.episodesAdded||0)+Number(result.episodesAdded||0);}
        send(task);return result;
      }).catch(error=>{
        if(current()){stage.done++;stage.status='partial';task.message='partial';const item=stage.items.find(entry=>entry.id===String(itemId));if(item)item.status='failed';send(task);}
        return{status:'error',error:error?.message||'error'};
      });
      task.children.push(wrapped);return wrapped;
    };
    const operation={signal:controller.signal,isCurrent:current,report,track,
      onCancel:fn=>{if(typeof fn==='function')task.cancelHooks.push(fn);},
      setSeries:(id)=>{if(current()&&id){task.seriesId=id;if(!task.seriesIds.includes(id))task.seriesIds.push(id);send(task);}},
      setSeriesIds:ids=>{if(current()){task.seriesIds=[...new Set(ids.filter(Boolean))];task.seriesId=task.seriesIds[0]||null;send(task);}},
      setSummary:value=>{if(current())Object.assign(task.summary,value||{});}};
    task.promise=Promise.resolve().then(()=>new Promise(resolve=>schedule(resolve))).then(async()=>{
      if(!current()){settleCore(task,{cancelled:true});return;}
      try{
        const result=await addSeries(payload,{operation});
        if(!current()){settleCore(task,{cancelled:true,lib:result?.lib});return;}
        if(result?.cancelled){task.status='cancelled';task.phase='cancelled';settleCore(task,result);send(task);return;}
        if(result?.id)operation.setSeries(result.id);
        if(Array.isArray(result?.ids))operation.setSeriesIds(result.ids);
        settleCore(task,result);send(task,'core',{result});
        await Promise.all(task.children);
        if(!current())return;
        const partial=Object.values(task.stages).some(stage=>stage.status==='partial');
        task.status=partial?'partial':'completed';task.phase=task.status;send(task,'progress');
      }catch(error){
        if(!current()){settleCore(task,{cancelled:true});return;}
        const failedPhase=task.phase;task.status='failed';task.phase='failed';task.message='failed';if(PHASES.includes(failedPhase))task.stages[failedPhase].status='failed';settleCore(task,{error:true});send(task,'progress');
      }
    }).finally(()=>resolveDone(snapshot(task)));
    task.promise.catch(()=>{});
  }
  function start(payload){
    const id=crypto.randomUUID();const task={id,title:String(payload.title||payload.selectedTitle||'Anime'),status:'pending',phase:'identification',stages:freshStages(),
      seriesId:null,seriesIds:[],createdAt:Date.now(),updatedAt:Date.now(),attempt:1,message:'',summary:{},generation:0,payload:clone(payload)};
    tasks.set(id,task);task.controller=new AbortController();task.corePromise=new Promise(resolve=>task.resolveCore=resolve);
    send(task);launch(task,task.payload);prune();
    return{taskId:id,core:task.corePromise};
  }
  function prune(){const finished=[...tasks.values()].filter(task=>['completed','partial','failed','cancelled'].includes(task.status)).sort((a,b)=>b.updatedAt-a.updatedAt);for(const task of finished.slice(maxCompleted))tasks.delete(task.id);}
  function list(){return[...tasks.values()].sort((a,b)=>a.createdAt-b.createdAt).map(snapshot);}
  function cancel(id){const task=tasks.get(String(id));if(!task||['completed','partial','failed','cancelled'].includes(task.status))return false;task.controller.abort();for(const cleanup of task.cancelHooks||[])try{cleanup();}catch{}task.status='cancelled';task.phase='cancelled';task.message='cancelled';settleCore(task,{cancelled:true,seriesId:task.seriesId});send(task);return true;}
  function cancelForSeries(id){let changed=false;for(const task of tasks.values())if(task.seriesIds.includes(String(id))||task.seriesId===String(id)||task.payload.franchiseId&&store.getSeries(id)?.franchiseId===task.payload.franchiseId)changed=cancel(task.id)||changed;return changed;}
  function cancelAll(){for(const task of tasks.values())cancel(task.id);}
  function retry(id){const task=tasks.get(String(id));if(!task||!['partial','failed'].includes(task.status))return false;task.attempt++;task.payload={...task.payload,retry:true};launch(task,task.payload);return true;}
  function wait(id){const task=tasks.get(String(id));return task?.donePromise || Promise.resolve(null);}
  const onStoreChanged=()=>{if(observedScope!==store.scope){observedScope=store.scope;cancelAll();}};
  store.on('changed',onStoreChanged);
  return{start,list,cancel,cancelForSeries,cancelAll,retry,wait,dispose(){store.off('changed',onStoreChanged);cancelAll();}};
}

module.exports={createAdditionOperationService,PHASES};
