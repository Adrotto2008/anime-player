'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FranchiseModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const CATEGORIES = ['season', 'movie', 'special', 'spinoff', 'other'];
  function category(media) {
    const saved = media?.franchiseMembership?.category || media?.franchiseType;
    if (CATEGORIES.includes(saved)) return saved;
    const relations = media?.franchiseRelations || [];
    if (relations.includes('SPIN_OFF')) return 'spinoff';
    if (relations.some(r => ['SUMMARY', 'ALTERNATIVE', 'ALTERNATIVE_VERSION'].includes(r))) return 'other';
    if (media?.format === 'MOVIE') return 'movie';
    if (['OVA', 'SPECIAL'].includes(media?.format)) return 'special';
    if (['TV', 'TV_SHORT', 'ONA'].includes(media?.format) && Number(media.episodeCount) !== 1) return 'season';
    return 'other';
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
      manual:Boolean(value.manual),updatedAt:Math.max(0,Number(value.updatedAt)||0)};
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
  return {CATEGORIES,category,singleWork,membership,mirror,migrate,units,partOrder};
});
