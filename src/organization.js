(function(root,factory){const api=factory();if(typeof module==='object' && module.exports)module.exports=api;else root.LibraryOrganization=api;})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  const HOME=['featured','continue','library','schedule','recent'];
  const CATEGORIES=['season','movie','special','spinoff','other'];
  const empty=()=>({version:1,lists:{},sections:{},placements:{}});
  const object=v=>v && typeof v==='object' && !Array.isArray(v);
  const safe=s=>typeof s==='string' && s.length>0 && s.length<=240 && !['__proto__','constructor','prototype'].includes(s);
  const listKey=s=>safe(s) && (['library','home:sections','home:continue','home:recent'].includes(s) || /^collection:.+/.test(s) || /^members:.+:[^:]+$/.test(s));
  function validate(raw){
    if(raw==null)return empty();
    const fail=()=>{throw new Error('Preferenze di organizzazione non valide.');};
    if(!object(raw) || raw.version!==1)fail();
    const result=empty();
    for(const kind of ['lists','sections','placements']){
      if(!object(raw[kind]) || Object.keys(raw[kind]).length>20000)fail();
      for(const [key,v] of Object.entries(raw[kind]).sort(([a],[b])=>a.localeCompare(b))){
        if(!safe(key) || !object(v) || !Number.isSafeInteger(v.updatedAt) || v.updatedAt<0)fail();
        if(kind==='lists'){
          if(!listKey(key) || !Array.isArray(v.ids) || v.ids.length>20000 || !v.ids.every(safe) || new Set(v.ids).size!==v.ids.length)fail();
          result.lists[key]={ids:[...v.ids],updatedAt:v.updatedAt};
        }else if(kind==='sections'){
          if(typeof v.title!=='string' || !v.title.trim() || v.title.length>80 || typeof v.deleted!=='boolean')fail();
          result.sections[key]={title:v.title,deleted:v.deleted,updatedAt:v.updatedAt};
        }else{
          if(!/^(series|franchise):.+/.test(key) || (v.section!==null && !(typeof v.section==='string' && v.section.startsWith('collection:') && safe(v.section))))fail();
          result.placements[key]={section:v.section,updatedAt:v.updatedAt};
        }
      }
    }
    return result;
  }
  function ordered(org,key,ids){
    const available=new Set(ids),saved=(org?.lists?.[key]?.ids || []).filter(id=>available.has(id)),seen=new Set(saved);
    return [...saved,...ids.filter(id=>!seen.has(id))];
  }
  function placement(org,key){const section=org?.placements?.[key]?.section;
    return section && org.sections?.[section.slice(11)] && !org.sections[section.slice(11)].deleted ? section : 'library';
  }
  function sections(org){return Object.entries(org?.sections || {}).filter(([,v])=>!v.deleted).map(([id,v])=>({id,...v}));}
  function winner(a,b){if(!a)return b;if(!b)return a;return a.updatedAt!==b.updatedAt?(a.updatedAt>b.updatedAt?a:b):(JSON.stringify(a)>JSON.stringify(b)?a:b);}
  function merge(a,b){a=validate(a);b=validate(b);const result=empty();
    for(const kind of ['lists','sections','placements'])for(const key of [...new Set([...Object.keys(a[kind]),...Object.keys(b[kind])])].sort())
      result[kind][key]=structuredCopy(winner(a[kind][key],b[kind][key]));
    return result;
  }
  const structuredCopy=v=>v===undefined?undefined:JSON.parse(JSON.stringify(v));
  function rebase(base,local,incoming,acknowledged=incoming){
    const result=incoming,previous=validate(base.organization),current=validate(local.organization),remote=validate(incoming.organization),observed=validate(acknowledged.organization);
    for(const kind of ['lists','sections','placements'])for(const [key,value] of Object.entries(current[kind]))
      if(JSON.stringify(value)!==JSON.stringify(previous[kind][key]))remote[kind][key]={...structuredCopy(value),updatedAt:Math.max(value.updatedAt,(observed[kind][key]?.updatedAt || 0)+1)};
    result.organization=remote;
    // Membership is a single decision too; a local category/detach made during
    // upload must not inherit half of the acknowledged remote membership.
    const old=new Map((base.series || []).map(s=>[s.id,s])),fresh=new Map((local.series || []).map(s=>[s.id,s])),observedSeries=new Map((acknowledged.series || []).map(s=>[s.id,s]));
    for(const record of result.series || []){const l=fresh.get(record.id),b=old.get(record.id);
      if(l?.franchiseMembership && JSON.stringify(l.franchiseMembership)!==JSON.stringify(b?.franchiseMembership)){
        const stamp=Math.max(l.franchiseMembership.updatedAt || 0,(observedSeries.get(record.id)?.franchiseMembership?.updatedAt || 0)+1);
        record.franchiseMembership={...structuredCopy(l.franchiseMembership),updatedAt:stamp};
        for(const key of ['franchiseId','franchiseTitle','franchiseType','franchiseOrder','franchiseSeasonNumber'])record[key]=l[key];
        record.updatedAt=Math.max(record.updatedAt || 0,stamp);
      }
    }
    return result;
  }
  function entryKeys(data){
    const groups=new Map();for(const s of data.series || [])if(s.franchiseId)groups.set(s.franchiseId,(groups.get(s.franchiseId)||0)+1);
    const defined=new Set((data.franchises || []).map(g=>g.id));
    return [...new Set((data.series || []).map(s=>s.franchiseId && (defined.has(s.franchiseId) || groups.get(s.franchiseId)>1)?'franchise:'+s.franchiseId:'series:'+s.id))];
  }
  return {HOME,CATEGORIES,empty,validate,ordered,placement,sections,merge,rebase,entryKeys};
});
