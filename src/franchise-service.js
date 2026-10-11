'use strict';
const {discoverRelatedWorks}=require('./franchise-discovery');
const Model=require('./franchise-model');
const {resolveFranchise,applyFranchiseMetadata}=require('./franchise');
function createFranchiseService({store,metadata,addSeries,sourceQueue,player,loadRatings}) {
  const links=require('./franchise-link-service').createFranchiseLinkService({store,metadata,sourceQueue,loadRatings});
  const scans=new Map();store._deletingFranchises=new Set();
  const available=id=>{const group=store.getFranchise(id);if(!group || store._deletingFranchises.has(id))throw new Error('Franchise non disponibile.');return group;};
  const scan=async id=>{
    const scope=store.scope,group=available(id),members=store.franchiseMembers(id).filter(s=>s.anilistId && !['other','spinoff'].includes(Model.category(s)));
    const active=()=>store.scope===scope && store.getFranchise(id)===group && !store._deletingFranchises.has(id);
    const records=[];
    for(let index=0;index<members.length;index+=24) records.push(...await metadata.getAnimeBatch(members.slice(index,index+24).map(s=>s.anilistId)));
    if(!active())return{cancelled:true,lib:store.snapshot()};
    const cache=new Map(records.map(m=>[String(m.anilistId),m]));
    const fetchRecords=async ids=>{const missing=ids.filter(i=>!cache.has(String(i)));if(missing.length){for(const m of await metadata.getAnimeBatch(missing))cache.set(String(m.anilistId),m);}return ids.map(i=>cache.get(String(i))).filter(Boolean);};
    const root=records.find(m=>String(m.anilistId)===String(group.rootAniListId));
    const core=root && Model.seasonWork(root) ? await resolveFranchise(root.anilistId,fetchRecords) : null;
    if(!active())return{cancelled:true,lib:store.snapshot()};
    const anchors=core && !core.ambiguous ? [...core.items,...core.movies] : records;
    const result=await discoverRelatedWorks(anchors,fetchRecords);
    if(!active())return{cancelled:true,lib:store.snapshot()};
    await links.discover(id,result.suggestions,[...anchors,...result.automatic]);
    if(!active())return{cancelled:true,lib:store.snapshot()};
    const seasons=core && !core.ambiguous ? applyFranchiseMetadata(core.items,{franchiseId:id,franchiseTitle:group.title,items:core.items}) : [];
    for(const record of [...seasons,...(core?.movies || []),...result.automatic]) {
      if(!active())break;
      if((group.excludedAniListIds||[]).includes(String(record.anilistId)))continue;
      const existing=store.data.series.find(s=>String(s.anilistId)===String(record.anilistId));
      if(existing?.franchiseMembership?.manual)continue;
      if(existing?.franchiseId && existing.franchiseId!==id)continue;
      // A confirmed automatic import is distinct from a user's manual membership.
      const added=await addSeries({anilistId:record.anilistId,franchiseId:id,category:record.category || record.franchiseType,automatic:true,
        relationEvidence:record.franchiseEvidence,relationOrder:record.franchiseOrder});
      if(added.cancelled || !store.getFranchise(id))break;
    }
    if(!active())return{cancelled:true,lib:store.snapshot()};
    const present=new Set(store.franchiseMembers(id).map(s=>String(s.anilistId)));
    const suggestions=result.suggestions.filter(s=>!Model.evaluateFranchiseRelation(s,[...anchors,...result.automatic]) && !present.has(String(s.anilistId)) && !(group.excludedAniListIds||[]).includes(String(s.anilistId)));
    if(JSON.stringify(suggestions)!==JSON.stringify(group.suggestions) || Boolean(group.discoveryTruncated)!==Boolean(result.truncated)) {
      group.suggestions=suggestions;group.discoveryTruncated=result.truncated;group.updatedAt=Math.max(Date.now(),(group.updatedAt||0)+1);store.save();
    }
    return{lib:store.snapshot(),suggestions:group.suggestions.length,truncated:result.truncated};
  };
  return {
    ...links,
    scan(id){const key=store.scope+':'+id;if(scans.has(key))return scans.get(key);const task=scan(id).finally(()=>scans.delete(key));scans.set(key,task);return task;},
    async delete(id){
      const group=available(id),ids=store.franchiseMembers(id).map(s=>s.id);store._deletingFranchises.add(id);sourceQueue.cancel?.(ids);
      try{for(const sid of ids)await player.stopIfSeries(sid);if(store.getFranchise(id)!==group)throw new Error('Franchise modificato; ripeti l’operazione.');store.deleteFranchise(id);return store.snapshot();}
      finally{store._deletingFranchises.delete(id);}
    },
    accept(id,anilistId,category){const group=available(id),candidate=(group.suggestions || []).find(s=>String(s.anilistId)===String(anilistId));
      return addSeries({anilistId,franchiseId:id,category,relationEvidence:candidate?.franchiseEvidence,
        relationRole:Model.ROLES.includes(candidate?.franchiseEvidence?.kind)?candidate.franchiseEvidence.kind:undefined});},
    reject(id,anilistId){const group=available(id);group.excludedAniListIds=[...new Set([...(group.excludedAniListIds||[]),String(anilistId)])];group.suggestions=group.suggestions.filter(s=>String(s.anilistId)!==String(anilistId));group.updatedAt=Date.now();store.save();return store.snapshot();},
  };
}
module.exports={createFranchiseService};
