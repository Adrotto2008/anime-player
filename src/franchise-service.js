'use strict';
const {discoverRelatedWorks}=require('./franchise-discovery');
const Model=require('./franchise-model');
function createFranchiseService({store,metadata,addSeries,sourceQueue,player}) {
  const scans=new Map();store._deletingFranchises=new Set();
  const available=id=>{const group=store.getFranchise(id);if(!group || store._deletingFranchises.has(id))throw new Error('Franchise non disponibile.');return group;};
  const scan=async id=>{
    const group=available(id),members=store.franchiseMembers(id).filter(s=>s.anilistId && !['other','spinoff'].includes(Model.category(s)));
    const records=[];
    for(let index=0;index<members.length;index+=24) records.push(...await metadata.getAnimeBatch(members.slice(index,index+24).map(s=>s.anilistId)));
    if(store.getFranchise(id)!==group || store._deletingFranchises.has(id))return{cancelled:true,lib:store.snapshot()};
    const result=await discoverRelatedWorks(records,ids=>metadata.getAnimeBatch(ids));
    if(store.getFranchise(id)!==group || store._deletingFranchises.has(id))return{cancelled:true,lib:store.snapshot()};
    for(const record of result.automatic) {
      if(store.getFranchise(id)!==group || store._deletingFranchises.has(id))break;
      if((group.excludedAniListIds||[]).includes(String(record.anilistId)))continue;
      const existing=store.data.series.find(s=>String(s.anilistId)===String(record.anilistId));
      if(existing?.franchiseMembership?.manual)continue;
      // A confirmed automatic import is distinct from a user's manual membership.
      const added=await addSeries({anilistId:record.anilistId,franchiseId:id,category:record.category,automatic:true});
      if(added.cancelled || !store.getFranchise(id))break;
    }
    if(store.getFranchise(id)!==group)return{cancelled:true,lib:store.snapshot()};
    const present=new Set(store.franchiseMembers(id).map(s=>String(s.anilistId)));
    group.suggestions=result.suggestions.filter(s=>!present.has(String(s.anilistId)) && !(group.excludedAniListIds||[]).includes(String(s.anilistId)));
    group.discoveryTruncated=result.truncated;group.updatedAt=Math.max(Date.now(),(group.updatedAt||0)+1);store.save();
    return{lib:store.snapshot(),suggestions:group.suggestions.length,truncated:result.truncated};
  };
  return {
    scan(id){if(scans.has(id))return scans.get(id);const task=scan(id).finally(()=>scans.delete(id));scans.set(id,task);return task;},
    async delete(id){
      const group=available(id),ids=store.franchiseMembers(id).map(s=>s.id);store._deletingFranchises.add(id);sourceQueue.cancel?.(ids);
      try{for(const sid of ids)await player.stopIfSeries(sid);if(store.getFranchise(id)!==group)throw new Error('Franchise modificato; ripeti l’operazione.');store.deleteFranchise(id);return store.snapshot();}
      finally{store._deletingFranchises.delete(id);}
    },
    accept(id,anilistId,category){available(id);return addSeries({anilistId,franchiseId:id,category});},
    reject(id,anilistId){const group=available(id);group.excludedAniListIds=[...new Set([...(group.excludedAniListIds||[]),String(anilistId)])];group.suggestions=group.suggestions.filter(s=>String(s.anilistId)!==String(anilistId));group.updatedAt=Date.now();store.save();return store.snapshot();},
  };
}
module.exports={createFranchiseService};
