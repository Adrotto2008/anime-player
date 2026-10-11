'use strict';
const crypto=require('crypto');
const Model=require('./franchise-model'),Links=require('./franchise-links');
const {resolveFranchise,applyFranchiseMetadata}=require('./franchise');
const {discoverRelatedWorks}=require('./franchise-discovery');
const clone=x=>JSON.parse(JSON.stringify(x));
function createFranchiseLinkService({store,metadata,sourceQueue,loadRatings}) {
  const previews=new Map(),creating=new Map();
  const available=id=>{const g=store.getFranchise(id);if(!g || store._deletingFranchises?.has(id))throw new Error('Franchise non disponibile.');return g;};
  function context(id){const scope=store.scope,file=store.file;available(id);return()=>{if(store.scope!==scope || store.file!==file)throw new Error('Account cambiato: richiesta annullata.');return available(id);};}
  function fetcher(active){const cache=new Map();return async ids=>{active();const missing=ids.filter(id=>!cache.has(String(id)));
    if(missing.length){const records=await metadata.getAnimeBatch(missing);active();for(const record of records)cache.set(String(record.anilistId),record);}
    return ids.map(id=>cache.get(String(id))).filter(Boolean);};}
  async function canonicalGraph(id,fetch) {
    let graph=await resolveFranchise(id,fetch);const seen=new Set();
    // Canonicalize an external film/season entry through a verified reciprocal
    // chronological bridge. This changes only link identity, never membership.
    for(let depth=0;depth<4 && !graph.ambiguous;depth++) {
      const root=graph.items[0],key=String(root.anilistId);if(seen.has(key))break;seen.add(key);
      const previous=Model.animeRelations(root).filter(r=>r.relation==='PREQUEL' && (r.format==='MOVIE' || root.format==='MOVIE' && Model.SEASON_FORMATS.has(r.format)));
      if(previous.length!==1)break;
      const peer=(await fetch([String(previous[0].id)]))[0];
      if(!peer || !Model.animeRelations(peer).some(r=>r.relation==='SEQUEL' && String(r.id)===key))break;
      if(peer.format!=='MOVIE' && !Model.seasonWork(peer))break;
      const prior=await resolveFranchise(peer.anilistId,fetch);if(prior.ambiguous)break;graph=prior;
    }
    return graph;
  }
  function entry(group,target,policy){const a=Links.endpoint(group),b=target;
    return {id:Links.linkId(a,b),endpoints:[a,b].sort((x,y)=>x.key.localeCompare(y.key)),type:policy.type,origin:'automatic',
      available:true,reason:policy.reason,evidence:[{provider:'AniList',...policy.evidence}],directions:{[a.key]:policy.type==='crossover'?(policy.targetDirection==='crossover_work'?'source_work':'crossover_work'):'related',[b.key]:policy.targetDirection || 'related'},updatedAt:0};}
  async function prepare(group,candidates,anchors,active){const id=group.id,fetch=fetcher(active),plans=new Map(),secondary=[];
    // Bounded candidates from the existing discovery budget; cache root plans.
    const roots=new Map();let resolved=0,incomplete=false;
    for(const record of candidates){const policy=Model.evaluateFranchiseRelation(record,anchors);if(!policy)continue;
      if(policy.secondary){secondary.push({anilistId:record.anilistId,reason:policy.reason,evidence:policy.evidence});continue;}
      let graph=roots.get(String(record.anilistId));
      if(!graph){if(resolved>=12){secondary.push({anilistId:record.anilistId,reason:'link_resolution_limit',evidence:policy.evidence});continue;}
        resolved++;try{graph=await canonicalGraph(record.anilistId,fetch);}catch{active();secondary.push({anilistId:record.anilistId,reason:'metadata_unavailable',evidence:policy.evidence});incomplete=true;break;}
        roots.set(String(record.anilistId),graph);for(const work of [...graph.items,...graph.movies])roots.set(String(work.anilistId),graph);}
      const root=graph.items[0];
      if(graph.ambiguous){secondary.push({anilistId:record.anilistId,reason:'ambiguous_franchise',evidence:policy.evidence});continue;}
      if(store.franchiseMembers(id).some(s=>String(s.anilistId)===String(root.anilistId)))continue;
      const target={key:`anilist:${root.anilistId}`,anilistId:Number(root.anilistId),title:root.title,cover:root.cover || null};
      const existing=Links.resolveEndpoint(store.data,target);if(existing?.id===id)continue;if(existing)target.franchiseId=existing.id;
      active();const link=entry(group,target,policy);
      // Preserve all original directed provider edges, including alternate entry
      // points. Reciprocal navigation is internal, never a fabricated API edge.
      plans.set(link.id,Links.mergeLinks(plans.has(link.id)?[plans.get(link.id)]:[],[link])[0]);
    }
    active();return {links:[...plans.values()],secondary,incomplete};
  }
  async function discover(id,candidates,anchors){const active=context(id),plan=await prepare(active(),candidates,anchors,active);
    if((store.data.franchises || []).filter(g=>active().rootAniListId && String(g.rootAniListId)===String(active().rootAniListId)).length>1) {
      const group=active();group.linkEvidence=[{reason:'ambiguous_source_identity'}];store.save();return [];
    }
    active();for(const link of plan.links)store.recordFranchiseLink(link);
    const found=new Set(plan.links.map(l=>l.id));
    for(const link of store.data.franchiseLinks || [])if(!plan.incomplete && link.origin==='automatic' && link.available!==false && !found.has(link.id)
      && link.endpoints.some(e=>Links.resolveEndpoint(store.data,e)?.id===id)) {
      link.available=false;link.updatedAt=Math.max(Date.now(),(link.updatedAt || 0)+1);store.save();
    }
    const group=active();if(JSON.stringify(group.linkEvidence || [])!==JSON.stringify(plan.secondary)){group.linkEvidence=plan.secondary;store.save();}
    return Links.linksFor(store.data,id);
  }
  async function previewLink(id,linkId){const active=context(id),link=Links.linksFor(store.data,id).find(l=>l.id===linkId);if(!link)throw new Error('Collegamento non disponibile.');
    if(link.ambiguous)throw new Error('Più franchise con questo identificatore: seleziona il contenitore manualmente.');
    const fetch=fetcher(active),graph=await resolveFranchise(link.target.anilistId,fetch);
    if(String(graph.items[0].anilistId)!==String(link.target.anilistId))throw new Error('Identità del franchise cambiata: ripeti la scansione.');
    const related=await discoverRelatedWorks([...graph.items,...graph.movies],fetch);active();
    const works=[...new Map([...graph.items,...graph.movies,...related.automatic].map(m=>[String(m.anilistId),m])).values()];
    const virtualGroup={id:String(link.target.anilistId),title:link.target.title,cover:link.target.cover,rootAniListId:link.target.anilistId};
    const linkPlan=await prepare(virtualGroup,related.suggestions,works,active);
    const token=crypto.randomUUID(),scope=store.scope,file=store.file;
    const preview={token,originId:id,linkId,scope,file,createdAt:Date.now(),target:link.target,type:link.type,reason:link.reason,evidence:link.evidence,
      works:clone(works),suggestions:clone(related.suggestions),items:clone(graph.items),ambiguous:graph.ambiguous,truncated:related.truncated,
      decisionStamp:JSON.stringify(link.decision || null),linkPlan,related:linkPlan.links.map(l=>{const e=l.endpoints.find(e=>e.key!==link.target.key);return{title:e.title,type:l.type};}),
      reuse:works.flatMap(m=>store.data.series.filter(s=>String(s.anilistId)===String(m.anilistId)).map(s=>({id:s.id,title:s.title,manual:Boolean(s.franchiseMembership?.manual),franchiseId:s.franchiseId || null}))),
      limits:'Discovery is bounded. Ambiguous seasons remain separate proposals; existing manual memberships are retained.'};
    for(const [key,p]of previews)if(p.scope!==scope || Date.now()-p.createdAt>300000)previews.delete(key);
    if(previews.size>=32)previews.delete(previews.keys().next().value);previews.set(token,preview);
    return clone(preview);
  }
  async function createLinked(token){const preview=previews.get(token);if(!preview || Date.now()-preview.createdAt>300000)throw new Error('Anteprima scaduta: riaprila.');
    if(preview.scope!==store.scope || preview.file!==store.file)throw new Error('Account cambiato: richiesta annullata.');
    const key=`${store.scope}:${preview.target.key}`;if(creating.has(key))return creating.get(key);
    const task=Promise.resolve().then(()=>{
      if(preview.scope!==store.scope || preview.file!==store.file)throw new Error('Account cambiato: richiesta annullata.');
      const origin=available(preview.originId),link=(store.data.franchiseLinks || []).find(l=>l.id===preview.linkId);
      if(!link)throw new Error('Collegamento non disponibile.');
      if(JSON.stringify(link.decision || null)!==preview.decisionStamp && link.decision?.state!=='confirmed')throw new Error('Collegamento modificato: riapri l’anteprima.');
      let group=Links.resolveEndpoint(store.data,preview.target);
      if(!group && (store.data.franchises || []).filter(g=>String(g.rootAniListId)===String(preview.target.anilistId)).length>1)throw new Error('Franchise ambiguo: verifica i contenitori esistenti.');
      const queue=[];let retained=0;
      store.transaction(()=>{
        if(!group){
          if((store.data.deletedFranchises || []).some(g=>g.id===String(preview.target.anilistId)))throw new Error('Franchise eliminato: serve un ripristino esplicito.');
          const conflicts=preview.works.flatMap(m=>store.data.series.filter(s=>String(s.anilistId)===String(m.anilistId)));
          const attached=new Set(conflicts.map(s=>s.franchiseId).filter(Boolean));
          if(attached.size)throw new Error('Opere già organizzate in un altro franchise: usa il collegamento manuale al contenitore esistente.');
          if(conflicts.some(s=>s.franchiseMembership?.manual && s.franchiseId===null))throw new Error('Distacco manuale presente: organizza esplicitamente l’opera prima di creare il franchise.');
          group=store.ensureFranchise({id:String(preview.target.anilistId),title:preview.target.title,cover:preview.target.cover,rootAniListId:preview.target.anilistId});
          const records=applyFranchiseMetadata(preview.works,{franchiseId:group.id,franchiseTitle:group.title,items:preview.items});
          for(const media of records){const matches=store.data.series.filter(s=>String(s.anilistId)===String(media.anilistId));
            if(matches.length>1)throw new Error('Opere duplicate preesistenti: seleziona e organizza il record da riutilizzare.');
            let series=matches[0];
            if(series?.franchiseMembership?.manual || series?.franchiseId){retained++;continue;}
            if(!series){const fields={...media};for(const field of ['franchiseId','franchiseTitle','franchiseOrder','franchiseType','streamingEpisodes'])delete fields[field];series=store.addSeries({...fields,episodes:[]});
              if(!Model.singleWork(series) && media.episodeCount>0 && media.episodeCount<=300)for(let n=1;n<=media.episodeCount;n++)store.ensureEpisode(series,n);
              queue.push(series.id);}
            store.setMembership(series.id,{franchiseId:group.id,category:media.franchiseType,order:media.franchiseOrder || undefined},{manual:false});
          }
          group.suggestions=preview.suggestions.filter(s=>!Model.evaluateFranchiseRelation(s,preview.works) && !store.franchiseMembers(group.id).some(m=>String(m.anilistId)===String(s.anilistId)));
          group.discoveryTruncated=Boolean(preview.truncated);
          if(queue.length)group.linkEnrichment={status:'loading',done:0,total:queue.length};
          group.linkEvidence=preview.linkPlan.secondary;
          for(const planned of preview.linkPlan.links)store.recordFranchiseLink(planned);
        }
        // Updating the endpoint cache does not change the stable relationship ID.
        const current=(store.data.franchiseLinks || []).find(l=>l.id===link.id);
        const target=current.endpoints.find(e=>e.key===preview.target.key);target.franchiseId=group.id;
        store.decideFranchiseLink(link.id,{state:'confirmed'});
      });
      for(const sid of queue)try{sourceQueue.enqueue(sid,[store.getSeries(sid).title]);}catch{ /* Creation remains valid; normal source search is recoverable. */ }
      if(queue.length)void enrich(preview,group.id,queue).catch(()=>{});
      return{id:group.id,lib:store.snapshot(),retained,sourceDiscoveryPending:queue.length>0};
    }).finally(()=>creating.delete(key));creating.set(key,task);return task;
  }
  async function enrich(preview,id,ids) {
    const scope=store.scope,file=store.file;
    const valid=()=>store.scope===scope && store.file===file && store.getFranchise(id) && !store._deletingFranchises?.has(id);
    let done=0,failed=false;
    for(const sid of ids){if(!valid())return;
      const media=preview.works.find(m=>String(m.anilistId)===String(store.getSeries(sid)?.anilistId));
      const member=()=>valid() && store.getSeries(sid)?.franchiseId===id && !store.getSeries(sid)?.franchiseMembership?.manual;
      if(!media || !member())continue;
      let timer;
      try{
        if(!Model.singleWork(media) && metadata.fetchEpisodes){
          const result=await Promise.race([metadata.fetchEpisodes({anilistId:media.anilistId,title:media.altTitle || media.title,streamingEpisodes:media.streamingEpisodes,episodeCount:media.episodeCount}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Metadata timeout')),20000);})]);
          if(member() && result.episodes?.length){store.mergeEpisodeMeta(sid,result.episodes);if(result.kitsuId)store.updateSeries(sid,{kitsuId:result.kitsuId});}
        }
        if(member() && loadRatings)void loadRatings(sid).catch(()=>{});
      }catch{failed=true;}finally{clearTimeout(timer);}
      if(!valid())return;
      const group=store.getFranchise(id);group.linkEnrichment={status:'loading',done:++done,total:ids.length};store.save();
    }
    if(valid()){store.getFranchise(id).linkEnrichment={status:failed?'partial':'ready',done,total:ids.length};store.save();}
  }
  function decideLink(id,linkId,patch){available(id);if(!Links.linksFor(store.data,id,{excluded:true}).some(l=>l.id===linkId))throw new Error('Collegamento non disponibile.');store.decideFranchiseLink(linkId,patch);return store.snapshot();}
  function manualLink(id,targetId,type='manual'){const a=available(id),b=available(targetId);if(a.id===b.id)throw new Error('Scegli franchise diversi.');
    // Explicit UUID selection can distinguish existing provider duplicates.
    const own=g=>(store.data.franchises || []).filter(x=>g.rootAniListId && String(x.rootAniListId)===String(g.rootAniListId)).length>1?{...Links.endpoint(g),key:`local:${g.id}`,anilistId:undefined}:Links.endpoint(g);
    const endpoints=[own(a),own(b)].sort((x,y)=>x.key.localeCompare(y.key));
    const link={id:Links.linkId(...endpoints),endpoints,type:'manual',origin:'manual',evidence:[],reason:'manual_link',updatedAt:0};
    store.transaction(()=>{store.recordFranchiseLink(link);store.decideFranchiseLink(link.id,{state:'confirmed',type});});return store.snapshot();
  }
  return {discover,previewLink,createLinked,decideLink,manualLink,links:id=>Links.linksFor(store.data,id)};
}
module.exports={createFranchiseLinkService};
