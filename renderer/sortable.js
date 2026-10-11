/* Pointer/keyboard sorting with DOM previews and FLIP. No library render/save
   occurs on pointer movement; only the final relative command crosses IPC. */
(function(){
  'use strict';
  function create({root,scroll=root,onCommit,onBusyChange=()=>{},announce=()=>{},labels={}}){
    let pending=null,drag=null,saving=false,frame=0,cache=null,suppressUntil=0;
    const motion=matchMedia('(prefers-reduced-motion: reduce)'),animations=new Map();
    const children=list=>[...list.children].filter(el=>el.hasAttribute('data-sort-id'));
    const lists=()=>[...root.querySelectorAll('[data-sort-list]')];
    const busy=()=>Boolean(pending || drag || saving);
    const compatible=(a,b)=>a.dataset.sortFamily===b.dataset.sortFamily;
    const reduced=()=>motion.matches;
    const sequence=list=>drag?.virtual?.list===list?drag.virtual.order:children(list);
    function nextNode(list,el){const order=sequence(list);return order[order.indexOf(el)+1] || null;}
    function focusKeyboard(d){
      if(!d.keyboard)return;
      const target=d.origin.dataset.sortFamily==='sections'?d.handle:d.item;
      target.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});d.handle.focus({preventScroll:true});
    }
    function initVirtual(d,list){
      const order=children(list);
      if(list.dataset.sortFamily==='visual' && list.dataset.sortAxis==='grid' && order.length>=80)
        d.virtual={list,order,indices:new Map(order.map((el,i)=>[el,i])),moved:new Set()};
    }
    function resetVirtual(d){const v=d?.virtual;if(!v)return;
      for(const el of v.moved){el.style.transition='none';el.style.transform='';el.classList.remove('sort-virtual');el.style.transition='';}
      d.virtual=null;
    }
    function flushVirtual(d){const v=d.virtual;if(!v)return;
      const order=[...v.order];resetVirtual(d);v.list.append(...order);d.domChanged=true;invalidate();
    }
    function virtualInsert(list,before){
      const d=drag,v=d.virtual,oldIndex=v.order.indexOf(d.item),next=v.order.filter(el=>el!==d.item);
      let newIndex=before?next.indexOf(before):next.length;if(newIndex<0 || oldIndex===newIndex)return;
      next.splice(newIndex,0,d.item);
      const first=list.firstElementChild,r=layoutRect(first),style=getComputedStyle(list),columns=style.gridTemplateColumns.split(' ').length;
      const xStep=r.width+(parseFloat(style.columnGap)||0),yStep=r.height+(parseFloat(style.rowGap)||0);
      for(let i=Math.min(oldIndex,newIndex);i<=Math.max(oldIndex,newIndex);i++){
        const el=next[i],base=v.indices.get(el),x=(i%columns-base%columns)*xStep,y=(Math.floor(i/columns)-Math.floor(base/columns))*yStep;
        el.classList.add('sort-virtual');if(reduced() || el===d.item)el.style.transition='none';
        el.style.transform=`translate(${x}px,${y}px)`;v.moved.add(el);
      }
      v.order=next;d.changed=true;invalidate();say('position',d.title,list.dataset.sortTitle || '',newIndex+1,next.length);
      focusKeyboard(d);
    }
    function layoutRect(el){const r=el.getBoundingClientRect();
      const transform=getComputedStyle(el).transform,m=transform==='none'?{m41:0,m42:0}:new DOMMatrixReadOnly(transform);
      return {left:r.left-m.m41,right:r.right-m.m41,top:r.top-m.m42,bottom:r.bottom-m.m42,width:r.width,height:r.height};
    }
    const cancelAnimations=()=>{for(const animation of animations.values())animation.cancel();animations.clear();};
    function invalidate(){cache=null;}
    function measure(){
      if(!drag)return [];
      if(!cache)cache=drag.lists.map(list=>({list,rect:list.getBoundingClientRect(),axis:list.dataset.sortAxis || 'grid',
        placeholder:drag.item.parentElement===list?drag.item.getBoundingClientRect():null}));
      return cache;
    }
    function rectangles(nodes){const result=new Map();for(const el of nodes){
      const rect=el.getBoundingClientRect();if(rect.bottom>0 && rect.top<innerHeight && rect.right>0 && rect.left<innerWidth)result.set(el,rect);
    }return result;}
    function animate(before){
      if(reduced())return;
      for(const [el,first] of before){
        animations.get(el)?.cancel();animations.delete(el);
        const last=el.getBoundingClientRect(),x=first.left-last.left,y=first.top-last.top;
        if((Math.abs(x)<1 && Math.abs(y)<1) || el===drag?.item)continue;
        const animation=el.animate([{transform:`translate(${x}px,${y}px)`},{transform:'translate(0,0)'}],{duration:180,easing:'cubic-bezier(.2,.7,.2,1)'});
        animation.id='organization-move';
        animations.set(el,animation);animation.finished.then(()=>{if(animations.get(el)===animation)animations.delete(el);}).catch(()=>{});
      }
    }
    function say(key,...args){announce(typeof labels[key]==='function'?labels[key](...args):labels[key] || key);}
    function begin(item,list,handle,point,keyboard=false,pointerId=null){
      cancelAnimations();const rect=item.getBoundingClientRect();
      const targets=lists().filter(el=>compatible(el,list));
      drag={item,origin:list,handle,lists:targets,originals:new Map(targets.map(el=>[el,[...el.children]])),
        id:item.dataset.sortId,title:item.dataset.sortTitle || handle.getAttribute('aria-label'),
        keyboard,pointerId,x:point.x,y:point.y,offsetX:point.x-rect.left,offsetY:point.y-rect.top,valid:true,changed:false,domChanged:false,lastTime:performance.now()};
      initVirtual(drag,list);
      handle.setAttribute('aria-pressed','true');item.classList.add(keyboard?'sort-keyboard':'sort-placeholder');
      root.classList.add('sort-active');
      if(!keyboard){
        const ghost=document.createElement('div');ghost.className='sort-ghost';ghost.setAttribute('aria-hidden','true');ghost.inert=true;
        if(list.dataset.sortFamily==='visual')ghost.classList.add('sort-visual-ghost');
        ghost.style.width=rect.width+'px';
        if(list.dataset.sortFamily==='sections'){
          ghost.classList.add('sort-section-ghost');ghost.textContent=drag.title;
        }else{ghost.append(item.cloneNode(true));ghost.style.height=rect.height+'px';}
        // Cloned controls must never introduce duplicate DOM IDs.
        for(const el of ghost.querySelectorAll('[id]'))el.removeAttribute('id');
        document.body.append(ghost);drag.ghost=ghost;
      }
      invalidate();say('picked',drag.title);schedule();
    }
    function insert(list,before){
      const d=drag;if(!d || (list===d.item.parentElement && (before===d.item || before===nextNode(list,d.item) || !before && !nextNode(list,d.item))))return;
      if(d.virtual?.list===list){virtualInsert(list,before);return;}
      if(d.virtual)flushVirtual(d);
      const origin=d.item.parentElement,source=children(origin),destination=origin===list?source:children(list);
      const start=source.indexOf(d.item),end=before?destination.indexOf(before):destination.length;
      const affected=origin===list?source.slice(Math.min(start,end),Math.max(start,end)+1):[...source.slice(start),...destination.slice(Math.max(0,end))];
      const previous=rectangles(affected);
      list.insertBefore(d.item,before);d.changed=true;d.domChanged=true;invalidate();animate(previous);
      for(const el of d.lists)el.classList.toggle('sort-over',el===list);
      const ids=children(list);say('position',d.title,list.dataset.sortTitle || '',ids.indexOf(d.item)+1,ids.length);
      focusKeyboard(d);
      initVirtual(d,list);
    }
    const contains=(r,x,y)=>x>=r.left && x<=r.right && y>=r.top && y<=r.bottom;
    function preview(){
      const d=drag;if(!d || d.keyboard)return;
      const measured=measure(),target=measured.find(m=>contains(m.rect,d.x,d.y));
      d.valid=Boolean(target);d.ghost.classList.toggle('sort-invalid',!d.valid);
      if(!target)return;
      for(const el of d.lists)el.classList.toggle('sort-over',el===target.list);
      if(target.placeholder && contains(target.placeholder,d.x,d.y))return;
      let nearest=document.elementFromPoint(d.x,d.y)?.closest('[data-sort-id]');
      // Browser hit testing already knows the visible card. Avoid reading the
      // geometry/style of hundreds of offscreen cards on every pointer move.
      while(nearest && nearest.parentElement!==target.list)nearest=nearest.parentElement.closest('[data-sort-id]');
      if(nearest===d.item)return;
      if(!nearest){
        const candidates=children(target.list).filter(el=>el!==d.item);
        if(!candidates.length){insert(target.list,null);return;}
        // A gap in the current grid retains the preview until the pointer
        // reaches a card. A cross-list drop in padding chooses a visible card.
        if(d.item.parentElement===target.list)return;
        let distance=Infinity;for(const el of candidates){const r=layoutRect(el);if(r.bottom<0 || r.top>innerHeight)continue;
          const metric=Math.hypot(d.x-r.left-r.width/2,d.y-r.top-r.height/2);if(metric<distance){distance=metric;nearest=el;}
        }
        if(!nearest){insert(target.list,null);return;}
      }
      const r=layoutRect(nearest);
      const before=target.axis==='vertical'?d.y<r.top+r.height/2:target.axis==='horizontal'?d.x<r.left+r.width/2:
        d.y<r.top || d.y<=r.bottom && d.x<r.left+r.width/2;
      insert(target.list,before?nearest:nextNode(target.list,nearest));
    }
    function edge(value,lo,hi){const size=Math.min(60,(hi-lo)/4);return value<lo+size?-Math.min(1,(lo+size-value)/size):value>hi-size?Math.min(1,(value-hi+size)/size):0;}
    function tick(time){
      frame=0;const d=drag;if(!d || d.keyboard)return;
      const factor=Math.min(2,(time-d.lastTime)/16.67);d.lastTime=time;
      const r=scroll.getBoundingClientRect();let scrolled=false;
      if(d.x>=r.left && d.x<=r.right){const old=scroll.scrollTop;scroll.scrollTop+=edge(d.y,r.top,r.bottom)*16*factor;scrolled=old!==scroll.scrollTop;}
      for(const m of measure())if(m.axis==='horizontal' && contains(m.rect,d.x,d.y)){
        const old=m.list.scrollLeft;m.list.scrollLeft+=edge(d.x,m.rect.left,m.rect.right)*14*factor;scrolled ||= old!==m.list.scrollLeft;
      }
      if(scrolled)invalidate();
      d.ghost.style.transform=`translate3d(${d.x-d.offsetX}px,${d.y-d.offsetY}px,0)`;
      preview();schedule();
    }
    function schedule(){if(drag && !drag.keyboard && !frame)frame=requestAnimationFrame(tick);}
    function restore(d){
      resetVirtual(d);if(!d.domChanged)return;
      const before=rectangles(d.lists.flatMap(children));for(const [list,nodes] of d.originals)list.append(...nodes);animate(before);
    }
    function clear(d){
      if(frame)cancelAnimationFrame(frame);frame=0;cache=null;drag=null;pending=null;
      resetVirtual(d);
      d?.ghost?.remove();d?.item.classList.remove('sort-placeholder','sort-keyboard');d?.handle.setAttribute('aria-pressed','false');
      for(const list of d?.lists || [])list.classList.remove('sort-over');root.classList.remove('sort-active');
    }
    function cancel(){
      if(saving)return;
      if(drag){const d=drag;restore(d);clear(d);d.handle.focus({preventScroll:true});say('cancelled');}
      else pending=null;
      onBusyChange(false);
    }
    async function finish(){
      if(!drag){pending=null;onBusyChange(false);return;}
      const d=drag;if(!d.valid){cancel();return;}
      const list=d.item.parentElement,all=sequence(list),index=all.indexOf(d.item),from=d.origin.dataset.sortList,to=list.dataset.sortList;
      const same=from===to && d.originals.get(d.origin).filter(el=>el.hasAttribute('data-sort-id')).every((el,i)=>all[i]===el);
      const command={item:d.id,from,to,...(all[index+1]?{before:all[index+1].dataset.sortId}:all[index-1]?{after:all[index-1].dataset.sortId}:{})};
      if(d.virtual && !same)flushVirtual(d);
      clear(d);if(same){onBusyChange(false,{item:d.id,to});return;}
      saving=true;root.classList.add('sort-saving');
      try{const committed=await onCommit(command);if(committed===false){restore(d);say('cancelled');}else say('saved');}
      catch{restore(d);say('failed');}
      finally{saving=false;root.classList.remove('sort-saving');onBusyChange(false,{item:d.id,to});}
    }
    function pointerDown(event){
      const handle=event.target.closest('[data-sort-handle]');if(!handle || busy() || event.button!==0 || event.isPrimary===false)return;
      const item=handle.closest('[data-sort-id]'),list=item?.parentElement;if(!list?.hasAttribute('data-sort-list'))return;
      event.preventDefault();handle.focus({preventScroll:true});
      pending={handle,item,list,x:event.clientX,y:event.clientY,id:event.pointerId};
      handle.setPointerCapture?.(event.pointerId);onBusyChange(true);
    }
    function pointerMove(event){
      if(!pending && !drag || drag?.keyboard || pending && event.pointerId!==pending.id || drag && event.pointerId!==drag.pointerId)return;
      if(pending && Math.hypot(event.clientX-pending.x,event.clientY-pending.y)>=7){const p=pending;pending=null;begin(p.item,p.list,p.handle,{x:p.x,y:p.y},false,p.id);}
      if(drag){event.preventDefault();drag.x=event.clientX;drag.y=event.clientY;schedule();}
    }
    function pointerUp(event){
      if(drag?.keyboard)return;
      if(drag && event.pointerId!==drag.pointerId)return;
      if(pending && event.pointerId!==pending.id)return;
      if(!pending && !drag)return;
      if(drag){drag.x=event.clientX;drag.y=event.clientY;preview();suppressUntil=performance.now()+100;}
      finish();
    }
    function keyDown(event){
      if(saving)return;
      if(drag && (event.key==='Escape' || event.key==='Tab')){if(event.key==='Escape')event.preventDefault();cancel();return;}
      const handle=event.target.closest('[data-sort-handle]');if(!handle)return;
      if(event.key===' ' || event.key==='Enter'){
        event.preventDefault();if(drag?.keyboard){finish();return;}if(busy())return;
        const item=handle.closest('[data-sort-id]'),list=item.parentElement,rect=item.getBoundingClientRect();onBusyChange(true);
        begin(item,list,handle,{x:rect.left,y:rect.top},true);return;
      }
      if(!drag?.keyboard || !event.key.startsWith('Arrow'))return;
      event.preventDefault();const d=drag,list=d.item.parentElement,ids=sequence(list),index=ids.indexOf(d.item),delta=['ArrowUp','ArrowLeft'].includes(event.key)?-1:1;
      if(event.ctrlKey){const target=d.lists[d.lists.indexOf(list)+delta];if(target)insert(target,children(target)[0] || null);}
      else if(index+delta>=0 && index+delta<ids.length)insert(list,delta<0?ids[index-1]:ids[index+2] || null);
    }
    root.addEventListener('pointerdown',pointerDown);
    document.addEventListener('pointermove',pointerMove,{passive:false});
    document.addEventListener('pointerup',pointerUp);
    document.addEventListener('pointercancel',event=>{if(event.pointerId===pending?.id || event.pointerId===drag?.pointerId)cancel();});
    document.addEventListener('keydown',event=>{if(event.key==='Escape' && (pending || drag)){event.preventDefault();cancel();}else keyDown(event);});
    root.addEventListener('click',event=>{if(event.target.closest('[data-sort-handle]') || performance.now()<suppressUntil){event.preventDefault();event.stopImmediatePropagation();}},{capture:true});
    root.addEventListener('dragstart',event=>{if(event.target.closest('[data-sort-id]'))event.preventDefault();});
    root.addEventListener('scroll',invalidate,true);window.addEventListener('resize',invalidate);window.addEventListener('blur',()=>{if(pending || drag)cancel();});
    motion.addEventListener('change',()=>{cancelAnimations();invalidate();});
    return {get busy(){return busy();},cancel};
  }
  window.Sortable={create};
})();
