'use strict';
(function(root,factory){if(typeof module==='object' && module.exports)module.exports=factory(require('./franchise-model'));else root.FranchiseLinks=factory(root.FranchiseModel);})(typeof globalThis!=='undefined'?globalThis:this,function(Model){
const clone=x=>JSON.parse(JSON.stringify(x));
const endpoint=group=>({key:group.rootAniListId?`anilist:${group.rootAniListId}`:`local:${group.id}`,
  ...(group.rootAniListId?{anilistId:Number(group.rootAniListId)}:{}),franchiseId:group.id,title:group.title,cover:group.cover || null});
function linkId(a,b){return 'franchise-link:'+JSON.stringify([a.key,b.key].sort());}
function validateLinks(input=[]) {
  if(!Array.isArray(input))throw new Error('Collegamenti franchise non validi.');
  const ids=new Set();
  return input.map(raw=>{
    if(!raw || !Array.isArray(raw.endpoints) || raw.endpoints.length!==2)throw new Error('Collegamento non valido.');
    if(!Model.LINK_TYPES.includes(raw.type) || !['automatic','manual'].includes(raw.origin) || !Array.isArray(raw.evidence))throw new Error('Metadati del collegamento non validi.');
    const endpoints=raw.endpoints.map(e=>{
      if(!e || typeof e.key!=='string' || !(e.key===`anilist:${e.anilistId}` && Number.isSafeInteger(e.anilistId) && e.anilistId>0 || e.key===`local:${e.franchiseId}` && typeof e.franchiseId==='string' && e.franchiseId))throw new Error('Identità del franchise non valida.');
      return {key:e.key,...(e.anilistId?{anilistId:e.anilistId}:{}),...(typeof e.franchiseId==='string'?{franchiseId:e.franchiseId}:{}),title:String(e.title || 'Franchise'),cover:typeof e.cover==='string'?e.cover:null};
    }).sort((a,b)=>a.key.localeCompare(b.key));
    const id=linkId(...endpoints);
    if(endpoints[0].key===endpoints[1].key || raw.id!==id || ids.has(id))throw new Error('Identità collegamento duplicata o non valida.');ids.add(id);
    const decision=raw.decision;
    if(decision && (!Model.LINK_STATES.includes(decision.state) || !Model.LINK_TYPES.includes(decision.type) || !Number.isFinite(decision.updatedAt) || decision.updatedAt<0))throw new Error('Decisione collegamento non valida.');
    return {...clone(raw),id,endpoints,...(decision?{decision:clone(decision)}:{})};
  });
}
function newest(items){return items.filter(Boolean).sort((a,b)=>(Number(b.updatedAt)||0)-(Number(a.updatedAt)||0) || JSON.stringify(b).localeCompare(JSON.stringify(a)))[0];}
function mergeLinks(a=[],b=[]){const result=new Map();for(const link of [...a,...b]){const old=result.get(link.id);if(!old){result.set(link.id,clone(link));continue;}
  const winner=newest([old,link]),decision=newest([old.decision,link.decision]);
  const evidence=[...new Map([...(old.evidence || []),...(link.evidence || [])].map(e=>[JSON.stringify(e),e])).values()].sort((x,y)=>JSON.stringify(x).localeCompare(JSON.stringify(y)));
  result.set(link.id,{...clone(winner),evidence,...(decision?{decision:clone(decision)}:{})});}
  return [...result.values()].sort((x,y)=>x.id.localeCompare(y.id));}
function resolveEndpoint(data,e){
  const groups=(data.franchises || []).filter(g=>e.anilistId?String(g.rootAniListId)===String(e.anilistId):g.id===e.franchiseId);
  // A saved local UUID identifies the selected container; provider duplicates
  // without an explicit selection remain ambiguous, never automatically merged.
  const selected=groups.find(g=>g.id===e.franchiseId);
  return selected || (groups.length===1?groups[0]:null);
}
function rebaseDecisions(base,local,incoming){
  const old=new Map((base.franchiseLinks || []).map(l=>[l.id,l]));
  const current=new Map((local.franchiseLinks || []).map(l=>[l.id,l]));
  for(const link of incoming.franchiseLinks || []) {
    const saved=current.get(link.id);
    if(saved?.decision && JSON.stringify(old.get(link.id)?.decision)!==JSON.stringify(saved.decision)) {
      // A manual decision is atomic. A type edit cannot inherit a remote
      // exclusion through field-by-field rebase of an unchanged state string.
      const observed=Number(link.decision?.updatedAt)||0;
      link.decision={...clone(saved.decision),updatedAt:Math.max(saved.decision.updatedAt,observed+1)};
      link.updatedAt=Math.max(link.updatedAt || 0,saved.updatedAt || 0,link.decision.updatedAt);
    }
  }
  return incoming;
}
function linksFor(data,id,{excluded=false}={}){const group=(data.franchises || []).find(g=>g.id===id);if(!group)return[];
  return (data.franchiseLinks || []).flatMap(link=>{
    const index=link.endpoints.findIndex(e=>resolveEndpoint(data,e)?.id===id);
    if(index<0)return[];const state=link.decision?.state || 'suggested';if(state==='excluded' && !excluded || state==='suggested' && link.available===false && !excluded)return[];
    const source=link.endpoints[index],target=link.endpoints[1-index],existing=resolveEndpoint(data,target);
    const ambiguous=!existing && (data.franchises || []).filter(g=>target.anilistId && String(g.rootAniListId)===String(target.anilistId)).length>1;
    return [{...link,state,type:link.decision?.type || link.type,source,target:{...target,franchiseId:existing?.id || null,title:existing?.title || target.title,cover:existing?.cover || target.cover},
      ambiguous,direction:(link.decision?.directions || link.directions || {})[source.key] || 'related'}];
  });}
return {endpoint,linkId,validateLinks,mergeLinks,resolveEndpoint,linksFor,rebaseDecisions};
});
