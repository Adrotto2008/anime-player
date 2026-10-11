'use strict';
const Model=require('./franchise-model');
const weak=new Set(['SPIN_OFF','ALTERNATIVE','ALTERNATIVE_VERSION','SUMMARY','CHARACTER','OTHER']);
const strong=new Set(['SIDE_STORY','PREQUEL','SEQUEL']);

// Only confirmed main works and side stories are traversed. A suggestion never
// opens a second franchise through its own parents, sequels or shared characters.
async function discoverRelatedWorks(anchors,fetchByIds,{maxItems=96,maxDepth=2}={}) {
  const known=new Map(anchors.filter(m=>m?.anilistId != null).map(m=>[String(m.anilistId),m]));
  const anchorIds=new Set(known.keys()),evidence=new Map(),fetched=new Set(known.keys());
  const automatic=new Map(),suggestions=new Map();let frontier=[...known.values()],requests=0,truncated=false;
  for (let depth=0;depth<maxDepth && frontier.length;depth++) {
    for (const source of frontier) for (const rel of source.related || []) {
      if (!rel?.id || rel.type !== 'ANIME' || anchorIds.has(String(rel.id))) continue;
      const id=String(rel.id);
      if (!evidence.has(id)) evidence.set(id,{id,stub:{anilistId:rel.id,title:rel.title,format:rel.format,year:rel.year},relations:new Set(),from:new Set()});
      const entry=evidence.get(id);entry.relations.add(rel.relation);entry.from.add(String(source.anilistId));
    }
    const missing=[...evidence.keys()].filter(id=>!fetched.has(id));
    const room=Math.max(0,maxItems-(fetched.size-anchorIds.size));
    const selected=missing.slice(0,room);if(selected.length < missing.length)truncated=true;
    for (let offset=0;offset<selected.length;offset+=24) {
      const ids=selected.slice(offset,offset+24);ids.forEach(id=>fetched.add(id));
      const records=await fetchByIds(ids);requests++;
      for (const record of records || []) if(record?.anilistId != null) known.set(String(record.anilistId),record);
    }
    const next=[];
    for (const id of selected) {
      const entry=evidence.get(id),record=known.get(id) || entry.stub;
      const relations=[...entry.relations].filter(Boolean);
      const category=Model.category({...record,franchiseType:undefined,franchiseMembership:undefined,franchiseRelations:relations});
      const parent=(record.related || []).some(r=>r.relation === 'PARENT' && anchorIds.has(String(r.id)));
      const reliable=known.has(id) && ['movie','special'].includes(category) && parent
        && relations.some(r=>strong.has(r)) && !relations.some(r=>weak.has(r));
      const item={...record,franchiseRelations:relations,category,linkedFrom:[...entry.from],
        reason:reliable?'confirmed_parent_and_side_story':!known.has(id)?'metadata_unavailable':'confirm_related_work'};
      if (reliable) {automatic.set(id,item);suggestions.delete(id);next.push(record);}
      else {suggestions.set(id,item);automatic.delete(id);}
    }
    frontier=next;
    if (depth === maxDepth-1 && frontier.some(m=>(m.related || []).some(r=>r.type === 'ANIME' && !fetched.has(String(r.id))))) truncated=true;
  }
  // Re-evaluate relation evidence accumulated from multiple trusted anchors.
  for (const [id,item] of automatic) {
    const relations=[...evidence.get(id).relations].filter(Boolean);
    if (relations.some(r=>weak.has(r))) {automatic.delete(id);suggestions.set(id,{...item,franchiseRelations:relations,
      category:Model.category({...item,franchiseType:undefined,franchiseMembership:undefined,franchiseRelations:relations}),reason:'confirm_multiple_relations'});}
  }
  return {automatic:[...automatic.values()],suggestions:[...suggestions.values()],requests,truncated};
}
module.exports={discoverRelatedWorks};
