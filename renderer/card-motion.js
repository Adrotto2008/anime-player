/* Small damped springs. Only active nodes receive animation frames. */
(function(){
  'use strict';
  const preference=matchMedia('(prefers-reduced-motion: reduce)'),active=new Map(),states=new WeakMap();
  let frame=0,last=0;
  const spring=(value=0)=>({value,target:value,velocity:0});
  function advance(s,dt,k=240,damping=25,epsilon=.08,velocity=.3){
    s.velocity+=((s.target-s.value)*k-s.velocity*damping)*dt;
    s.value+=s.velocity*dt;
    if(Math.abs(s.target-s.value)<epsilon && Math.abs(s.velocity)<velocity){s.value=s.target;s.velocity=0;}
    return s.value!==s.target || s.velocity!==0;
  }
  function wake(){if(!frame){last=performance.now();frame=requestAnimationFrame(tick);}}
  function state(el,kind){let s=states.get(el);if(!s){s={kind,x:spring(),y:spring(),rx:spring(),ry:spring(),scale:spring(1),resolve:null};states.set(el,s);}active.set(el,s);el.style.willChange=kind==='offset'?'translate':'transform';return s;}
  function paint(el,s){
    if(s.kind==='offset')el.style.translate=`${s.x.value}px ${s.y.value}px`;
    else el.style.transform=`perspective(900px) translate3d(${s.x.value}px,${s.y.value}px,0) rotateX(${s.rx.value}deg) rotateY(${s.ry.value}deg) scale(${s.scale.value})`;
  }
  function tick(time){frame=0;const dt=Math.min(.032,Math.max(.001,(time-last)/1000));last=time;
    for(const [el,s] of active){let moving=false;
      for(const key of ['x','y','rx','ry','scale']){
        if(preference.matches){s[key].value=s[key].target;s[key].velocity=0;}
        else moving=advance(s[key],dt,s.kind==='ghost'?300:240,s.kind==='ghost'?26:25,key==='scale'?.00004:.08,key==='scale'?.00015:.3)||moving;
      }
      paint(el,s);
      if(!moving || !el.isConnected){active.delete(el);el.style.willChange='';const done=s.resolve;s.resolve=null;done?.();}
    }
    if(active.size)frame=requestAnimationFrame(tick);
  }
  function offset(el,x,y,from){const s=state(el,'offset');
    if(from){s.x.value=from.x;s.y.value=from.y;}
    s.x.target=x;s.y.target=y;paint(el,s);wake();
  }
  function position(el){const s=active.get(el);if(s?.kind==='offset')return {x:s.x.value,y:s.y.value};const parts=el.style.translate.split(' ');return {x:parseFloat(parts[0])||0,y:parseFloat(parts[1])||0};}
  function clear(el){const s=states.get(el);active.delete(el);states.delete(el);s?.resolve?.();el.style.translate='';el.style.transform='';el.style.willChange='';}
  function ghost(el,x,y,vx=0,vy=0){const s=state(el,'ghost');s.x.value=s.x.target=x;s.y.value=s.y.target=y;
    s.rx.target=preference.matches?0:Math.max(-5,Math.min(5,-vy*.16));s.ry.target=preference.matches?0:Math.max(-7,Math.min(7,vx*.16));s.scale.target=preference.matches?1:1.035;paint(el,s);wake();}
  function land(el,x,y){const s=state(el,'ghost');s.x.target=x;s.y.target=y;s.rx.target=s.ry.target=0;s.scale.target=1;
    el.classList.add('sort-landing');wake();return new Promise(resolve=>{s.resolve=resolve;});}
  function hover(el,x,y,inside){const s=state(el,'hover');const moving=inside && !preference.matches;s.rx.target=moving?-y*4:0;s.ry.target=moving?x*5:0;s.y.target=moving?-5:0;s.scale.target=moving?1.016:1;el.classList.toggle('card-raised',inside);wake();}
  function idle(elements){return Promise.all(elements.map(el=>{const s=active.get(el);if(!s)return;
    return new Promise(resolve=>{const previous=s.resolve;s.resolve=()=>{previous?.();resolve();};});
  }));}
  preference.addEventListener('change',wake);
  window.CardMotion={offset,position,clear,ghost,land,hover,idle,get active(){return active.size;}};
})();
