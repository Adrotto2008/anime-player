'use strict';
const Model=require('./franchise-model');

// All entry paths use Model.evaluateRelated. Weak links never become trusted
// anchors; a one-shot alternate bridge may expose a proposal, never an import.
async function discoverRelatedWorks(anchors,fetchByIds,{maxItems=96,maxDepth=2}={}) {
  const known=new Map(anchors.filter(m=>m?.anilistId!=null).map(m=>[String(m.anilistId),m]));
  const anchorIds=new Set(known.keys()),attempted=new Set(known.keys()),evidence=new Map();
  const trusted=new Map(known),bridges=new Map();let frontier=[...known.values()],requests=0,truncated=false;
  for(let depth=0;depth<maxDepth && (frontier.length || bridges.size);depth++) {
    const sources=[...frontier,...bridges.values()];bridges.clear();
    for(const source of sources)for(const rel of Model.animeRelations(source)) {
      const id=String(rel.id);if(anchorIds.has(id))continue;
      const inherited=source._bridge;
      if(inherited && !['PREQUEL','SEQUEL','ALTERNATIVE'].includes(rel.relation))continue;
      if(!evidence.has(id))evidence.set(id,{stub:{anilistId:rel.id,title:rel.title,format:rel.format,episodeCount:rel.episodeCount},bridge:null});
      if(inherited)evidence.get(id).bridge={via:String(source.anilistId),path:[...inherited.path,id],
        edges:[...inherited.edges,{from:String(source.anilistId),to:id,relation:rel.relation}]};
    }
    const missing=[...evidence.keys()].filter(id=>!attempted.has(id));
    const selected=missing.slice(0,Math.max(0,maxItems-(attempted.size-anchorIds.size)));
    if(selected.length<missing.length)truncated=true;
    for(let offset=0;offset<selected.length;offset+=24){const ids=selected.slice(offset,offset+24);ids.forEach(id=>attempted.add(id));
      const records=await fetchByIds(ids);requests++;for(const m of records || [])if(m?.anilistId!=null && ids.includes(String(m.anilistId)))known.set(String(m.anilistId),m);
    }
    frontier=[];
    for(const id of selected){const entry=evidence.get(id),record=known.get(id) || entry.stub;
      const item=Model.evaluateRelated(record,[...trusted.values()],{missing:!known.has(id),bridge:entry.bridge});
      if(item.franchiseEvidence.automatic){trusted.set(id,record);frontier.push(record);}
      else if(!entry.bridge && known.has(id) && Number(record.episodeCount)===1
        && Model.animeRelations(record).some(r=>r.relation==='ALTERNATIVE')) {
        const edge=item.franchiseEvidence.edges.find(e=>e.to===id) || item.franchiseEvidence.edges.find(e=>e.from===id);
        if(edge)bridges.set(id,{...record,_bridge:{path:[edge.to===id?edge.from:edge.to,id],edges:item.franchiseEvidence.edges}});
      }
    }
    if(depth===maxDepth-1 && [...frontier,...bridges.values()].some(m=>Model.animeRelations(m).some(r=>!attempted.has(String(r.id)))))truncated=true;
  }
  // Reconsider all accumulated evidence, including late contradictions.
  let changed=true;
  while(changed){changed=false;for(const id of [...trusted.keys()])if(!anchorIds.has(id)){
    const entry=evidence.get(id),item=Model.evaluateRelated(known.get(id),[...trusted.values()].filter(m=>String(m.anilistId)!==id),{bridge:entry?.bridge});
    if(!item.franchiseEvidence.automatic){trusted.delete(id);changed=true;}
  }}
  const automatic=[],suggestions=[];
  for(const [id,entry]of evidence){const record=known.get(id) || entry.stub;
    const item=Model.evaluateRelated(record,[...trusted.values()].filter(m=>String(m.anilistId)!==id),{missing:!known.has(id),bridge:entry.bridge});
    if(trusted.has(id) && item.franchiseEvidence.automatic)automatic.push(item);else suggestions.push(item);
  }
  return{automatic,suggestions,requests,truncated};
}
module.exports={discoverRelatedWorks};
