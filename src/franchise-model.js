'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FranchiseModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const CATEGORIES = ['season', 'movie', 'special', 'spinoff', 'other'];
  const LINK_TYPES = ['crossover','shared_universe','alternative','adaptation','explicit','manual'];
  const LINK_STATES = ['suggested','confirmed','excluded'];
  // The same directed evidence evaluator governs both membership and links.
  // A character edge needs independent provider evidence to become prominent.
  function evaluateFranchiseRelation(record, anchors) {
    const item=evaluateRelated(record,anchors),proof=item.franchiseEvidence;
    const types=new Set(proof.edges.map(e=>e.relation));
    if(!seasonWork(record) && record.format!=='MOVIE' && !(record.format==='OVA' && Number(record.episodeCount)>1))
      return types.has('CHARACTER')?{secondary:true,type:'explicit',reason:'unsupported_independent_format',evidence:proof}:null;
    const crossover=[record,...anchors].find(m=>(m.relationTags || []).some(t=>t.name==='Crossover' && Number(t.rank)>=70 && !t.isMediaSpoiler));
    if(proof.automatic || proof.reason==='conflicting_parent' || proof.reason==='contradictory_relations'
      || types.has('PARENT') || types.has('SIDE_STORY') || types.has('SPIN_OFF'))return null;
    let type,reason;
    if(types.has('CHARACTER')) {
      if(!crossover)return {secondary:true,type:'explicit',reason:'shared_characters_only',evidence:proof};
      type='crossover';reason='crossover_tag_and_character';
    } else if(types.has('SAME_UNIVERSE')) {type='shared_universe';reason='explicit_provider_relation';}
    else if(types.has('ADAPTATION')) {type='adaptation';reason='explicit_provider_relation';}
    else if(types.has('ALTERNATIVE') || types.has('ALTERNATIVE_VERSION')) {type='alternative';reason='explicit_provider_relation';}
    else return null;
    if(!record.related || proof.reason==='metadata_unavailable')return {secondary:true,type,reason:'metadata_unavailable',evidence:proof};
    const taggedId=crossover?String(crossover.anilistId):null;
    return {type,reason,targetDirection:type==='crossover'?(taggedId===String(record.anilistId)?'crossover_work':'source_work'):'related',evidence:{...proof,tags:crossover?(crossover.relationTags || []).filter(t=>t.name==='Crossover').map(t=>({...t,mediaId:taggedId})):[]},
      directions:type==='crossover'?{[String(record.anilistId)]:taggedId===String(record.anilistId)?'crossover_work':'source_work',
        ...Object.fromEntries(anchors.map(m=>[String(m.anilistId),taggedId===String(m.anilistId)?'crossover_work':'source_work']))}: {}};
  }
  const ROLES = ['main','prequel','sequel','part','side_story','spinoff','shared_characters','crossover','alternative','remake','reboot','related','standalone'];
  const SEASON_FORMATS = new Set(['TV','TV_SHORT','ONA']);
  const WEAK = new Set(['SPIN_OFF','CHARACTER','ALTERNATIVE','ALTERNATIVE_VERSION','SUMMARY','COMPILATION','OTHER','SAME_UNIVERSE','REMAKE','REBOOT']);
  const animeRelations = media => (media?.related || []).filter(r=>r?.id && r.type==='ANIME');
  function seasonWork(media) {
    return SEASON_FORMATS.has(media?.format) && Number(media.episodeCount)!==1
      && !(['TV_SHORT','ONA'].includes(media.format) && animeRelations(media).some(r=>r.relation==='PARENT'));
  }
  function category(media) {
    const saved = media?.franchiseMembership?.category || media?.franchiseType;
    if (CATEGORIES.includes(saved)) return saved;
    const relations = media?.franchiseRelations || [];
    if (relations.includes('SPIN_OFF')) return 'spinoff';
    if (relations.some(r => WEAK.has(r))) return 'other';
    if (media?.format === 'MOVIE') return 'movie';
    if (['OVA', 'SPECIAL'].includes(media?.format)) return 'special';
    if (media?.format==='TV_SHORT' && animeRelations(media).some(r=>r.relation==='PARENT')) return 'special';
    if (media?.format==='ONA' && relations.includes('SIDE_STORY')) return 'special';
    if (media?.format==='ONA' && animeRelations(media).some(r=>r.relation==='PARENT')) return 'special';
    if (['TV', 'TV_SHORT', 'ONA'].includes(media?.format) && Number(media.episodeCount) !== 1) return 'season';
    return 'other';
  }
  // Shared policy for initial imports and later discovery. Relations describe
  // evidence between provider IDs, independently of persistent local identity.
  function evaluateRelated(record, anchors, {missing=false, bridge=null}={}) {
    const id=String(record.anilistId),anchorIds=new Set(anchors.map(m=>String(m.anilistId)));
    const edges=[];
    for(const source of anchors) for(const r of animeRelations(source)) if(String(r.id)===id)
      edges.push({from:String(source.anilistId),to:id,relation:r.relation});
    for(const r of animeRelations(record)) if(anchorIds.has(String(r.id)))edges.push({from:id,to:String(r.id),relation:r.relation});
    const forward=edges.filter(e=>e.to===id),types=[...new Set(edges.map(e=>e.relation).filter(Boolean))];
    const incoming=[...new Set(forward.map(e=>e.relation).filter(Boolean))];
    const kind=bridge?'alternative':incoming.includes('SPIN_OFF')?'spinoff':incoming.includes('REMAKE')?'remake':incoming.includes('REBOOT')?'reboot'
      :incoming.some(r=>['ALTERNATIVE','ALTERNATIVE_VERSION'].includes(r))?'alternative':incoming.includes('CHARACTER')?'shared_characters'
      :incoming.includes('PARENT')?'main'
      :incoming.includes('SIDE_STORY')?'side_story':incoming.includes('PREQUEL')?'prequel':incoming.includes('SEQUEL')
        ?(/\bpart\s*\d+\b/i.test(record.title || '')?'part':'sequel'):'related';
    const categoryValue=category({...record,franchiseMembership:undefined,franchiseType:undefined,
      franchiseRelations:bridge?['ALTERNATIVE']:incoming.includes('PARENT')?['OTHER']:incoming});
    const parents=animeRelations(record).filter(r=>r.relation==='PARENT');
    const foreignParent=parents.some(r=>!anchorIds.has(String(r.id)));
    const contradictory=forward.some(e=>['PREQUEL','SEQUEL'].includes(e.relation)
      && edges.some(back=>back.from===id && back.to===e.from && back.relation===e.relation));
    const corroborated=forward.some(e=>edges.some(back=>back.from===id && back.to===e.from
      && (e.relation==='SIDE_STORY' && back.relation==='PARENT' || e.relation==='SEQUEL' && back.relation==='PREQUEL' || e.relation==='PREQUEL' && back.relation==='SEQUEL')));
    const weak=types.some(r=>WEAK.has(r));
    const automatic=!missing && !bridge && !foreignParent && !contradictory && !weak && corroborated && ['movie','special'].includes(categoryValue);
    const reason=missing?'metadata_unavailable':bridge?'alternative_bridge':foreignParent?'conflicting_parent':contradictory?'contradictory_relations'
      :weak?'independent_relation':automatic?'confirmed_reciprocal_relation':'confirm_related_work';
    const evidence={provider:'AniList',kind,reason,automatic,edges:[...(bridge?.edges || []),...edges],path:bridge?.path || [],
      ...(bridge?{via:bridge.via}: {})};
    return {...record,category:categoryValue,franchiseRelations:types,linkedFrom:[...new Set(forward.map(e=>e.from))],reason,franchiseEvidence:evidence};
  }
  function singleWork(media) {
    return media?.format === 'MOVIE' || ['OVA','SPECIAL','ONA'].includes(media?.format) && Number(media?.episodeCount) === 1;
  }
  function membership(value) {
    if (!value || typeof value !== 'object') return null;
    if (value.franchiseId != null && (typeof value.franchiseId !== 'string' || !value.franchiseId)) return null;
    if (!CATEGORIES.includes(value.category)) return null;
    return {franchiseId:value.franchiseId ?? null,category:value.category,
      order:Number.isFinite(Number(value.order)) ? Math.max(0,Number(value.order)) : 0,
      manual:Boolean(value.manual),updatedAt:Math.max(0,Number(value.updatedAt)||0),
      ...(ROLES.includes(value.role)?{role:value.role}: {})};
  }
  function mirror(record, value, group) {
    record.franchiseMembership = membership(value);
    record.franchiseId = value.franchiseId;
    record.franchiseType = value.franchiseId ? value.category : null;
    record.franchiseOrder = value.franchiseId ? value.order : null;
    record.franchiseTitle = value.franchiseId ? group?.title || record.franchiseTitle || record.title : null;
  }
  // Stable legacy group IDs and every record/episode ID are retained.
  function migrate(data) {
    data.franchises = Array.isArray(data.franchises) ? data.franchises : [];
    data.deletedFranchises = Array.isArray(data.deletedFranchises) ? data.deletedFranchises : [];
    const groups = new Map(data.franchises.filter(g => g?.id).map(g => [String(g.id),g]));
    for (const record of data.series || []) {
      let value = membership(record.franchiseMembership);
      if (!value && record.franchiseId) value = {franchiseId:String(record.franchiseId),category:category(record),
        order:Number(record.franchiseOrder)||0,manual:false,updatedAt:Number(record.updatedAt)||0};
      if (!value) continue;
      const removed = data.deletedFranchises.find(g=>g.id === value.franchiseId);
      if (removed && !groups.has(value.franchiseId)) value={...value,franchiseId:null,manual:true,updatedAt:Math.max(value.updatedAt,removed.deletedAt)};
      if (value.franchiseId && !groups.has(value.franchiseId)) {
        const siblings = data.series.filter(s => String(s.franchiseId || '') === value.franchiseId);
        const primary = siblings.filter(s => category(s) === 'season').sort((a,b)=>(a.franchiseOrder||999)-(b.franchiseOrder||999))[0] || record;
        const group = {id:value.franchiseId,title:primary.franchiseTitle || primary.title,
          cover:primary.cover || null,banner:primary.banner || null,rootAniListId:primary.anilistId || null,
          custom:{},suggestions:[],updatedAt:Number(primary.updatedAt)||0};
        data.franchises.push(group); groups.set(group.id,group);
      }
      mirror(record,value,groups.get(value.franchiseId));
    }
    return data;
  }
  function units(series) { return [...(series?.episodes || []), ...(series?.mediaParts || [])]; }
  function partOrder(part) { const n=Number(String(part.key || '').split(':').pop());return Number.isFinite(n)?n:part.number; }
  return {CATEGORIES,ROLES,LINK_TYPES,LINK_STATES,SEASON_FORMATS,WEAK,animeRelations,seasonWork,evaluateRelated,evaluateFranchiseRelation,category,singleWork,membership,mirror,migrate,units,partOrder};
});
