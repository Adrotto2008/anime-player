'use strict';
const crypto=require('crypto'),path=require('path');
const O=require('./organization'),F=require('./franchise-model');
function createOrganizationService({store}){
  const instance=crypto.randomUUID();
  const context=()=>`${instance}:${store.scope}:${path.resolve(store.file)}`;
  function check(token){if(token!==context())throw new Error('La sessione della libreria è cambiata. Ripeti l’operazione.');}
  function memberList(key){const m=/^members:(.+):([^:]+)$/.exec(key);return m && F.CATEGORIES.includes(m[2])?{id:m[1],category:m[2]}:null;}
  function visual(key){return key==='library' || key.startsWith('collection:');}
  function items(key){
    if(key==='home:sections')return [...O.HOME,...O.sections(store.data.organization).map(s=>'collection:'+s.id)];
    if(key==='home:recent' || key==='home:continue')return store.data.series.map(s=>s.id);
    if(visual(key)){
      if(key!=='library' && !O.sections(store.data.organization).some(s=>'collection:'+s.id===key))throw new Error('Sezione non disponibile.');
      const names=new Map(store.data.series.map(s=>['series:'+s.id,s.title]));
      for(const s of store.data.series)if(s.franchiseId)names.set('franchise:'+s.franchiseId,store.getFranchise(s.franchiseId)?.title || s.franchiseTitle || s.title);
      const keys=O.entryKeys(store.data).sort((a,b)=>(names.get(a)||'').localeCompare(names.get(b)||''));
      return O.ordered(store.data.organization,'library',keys).filter(id=>O.placement(store.data.organization,id)===key);
    }
    const m=memberList(key);if(!m || !store.getFranchise(m.id))throw new Error('Sezione non disponibile.');
    return store.franchiseMembers(m.id).filter(s=>F.category(s)===m.category).sort((a,b)=>(a.franchiseOrder || 999)-(b.franchiseOrder || 999) || a.title.localeCompare(b.title)).map(s=>s.id);
  }
  function stamp(previous=0){return Math.max(Date.now(),previous+1);}
  function setOrder(key,ids){const org=store.data.organization ||=O.empty();org.lists[key]={ids,updatedAt:stamp(org.lists[key]?.updatedAt)};}
  function move(command){
    const {context:token,item,from,to,before,after,confirmMembership=false}=command || {};check(token);
    if(typeof item!=='string' || typeof from!=='string' || typeof to!=='string')throw new Error('Spostamento non valido.');
    const source=items(from);if(!source.includes(item))throw new Error('Il contenuto o la sua appartenenza è cambiata. Ripeti il trascinamento.');
    const member=memberList(from),destination=memberList(to);
    const membership=from!==to && member;
    if(membership && (!destination || destination.id!==member.id) && to!=='independent')throw new Error('Destinazione non compatibile.');
    if(membership && !confirmMembership)throw new Error('Conferma esplicita della nuova appartenenza richiesta.');
    if(from!==to && !membership && !(visual(from) && visual(to)))throw new Error('Sezioni non compatibili.');
    if(to!=='independent')items(to); // validate an empty destination as well
    return store.transaction(()=>{
      const org=store.data.organization ||=O.empty();
      if(membership){store.setMembership(item,{franchiseId:to==='independent'?null:destination.id,category:destination?.category || F.category(store.getSeries(item))});}
      else if(from!==to){org.placements[item]={section:to==='library'?null:to,updatedAt:stamp(org.placements[item]?.updatedAt)};}
      if(from!==to)setOrder(from,O.ordered(org,from,source).filter(id=>id!==item));
      if(to==='independent'){
        const entry='series:'+item;org.placements[entry]={section:null,updatedAt:stamp(org.placements[entry]?.updatedAt)};return store.snapshot();
      }
      const ids=O.ordered(org,to,items(to)).filter(id=>id!==item);
      // Relative anchors operate on CURRENT data; filtered/stale full arrays
      // cannot discard concurrent additions or reorder unseen cards.
      let index=before!=null?ids.indexOf(before):after!=null?ids.indexOf(after)+1:ids.length;
      if(before!=null && index<0 || after!=null && !ids.includes(after))throw new Error('La destinazione è cambiata. Ripeti il trascinamento.');
      ids.splice(index,0,item);setOrder(to,ids);
      return store.snapshot();
    }) && store.snapshot();
  }
  function section({context:token,id,title,deleted=false}){
    check(token);if(id!=null && !Object.hasOwn(store.data.organization?.sections || {},id))throw new Error('Sezione non disponibile.');
    const key=id || crypto.randomUUID(),previous=store.data.organization?.sections?.[key];
    const name=title==null?previous?.title:String(title).trim();if(!name || name.length>80)throw new Error('Scrivi un titolo di massimo 80 caratteri.');
    store.transaction(()=>{
      const org=store.data.organization ||=O.empty();org.sections[key]={title:name,deleted:Boolean(deleted),updatedAt:stamp(previous?.updatedAt)};
      // Deletion is a visual tombstone. Return contents to the library without
      // changing any work, group, relation or playback data.
      if(deleted)for(const [item,p] of Object.entries(org.placements))if(p.section==='collection:'+key)org.placements[item]={section:null,updatedAt:stamp(p.updatedAt)};
    });
    return {id:key,lib:store.snapshot()};
  }
  return {context,items,move,section};
}
module.exports={createOrganizationService};
