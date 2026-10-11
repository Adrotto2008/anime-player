'use strict';
const TYPES={intro:['op','mixed-op'],ending:['ed','mixed-ed','mixed-ending']};
const NEAR_SECONDS=2;
function decideSkip({episode,time,duration,intervals=episode?.skipTimes,kind}){
  const no=reason=>({ok:false,reason});
  if(!episode)return no('no-episode');
  if(!TYPES[kind])return no('invalid-kind');
  if(typeof time!=='number'||!Number.isFinite(time)||time<0)return no('invalid-time');
  if(typeof duration!=='number'||!Number.isFinite(duration)||duration<=0||time>duration)return no('unknown-duration');
  const valid=(Array.isArray(intervals)?intervals:[]).filter(x=>x&&TYPES[kind].includes(x.skipType)&&typeof x.start==='number'&&typeof x.end==='number'&&Number.isFinite(x.start)&&Number.isFinite(x.end)&&x.start>=0&&x.end>x.start&&x.start<duration&&x.end<=duration);
  if(!valid.length)return no('no-interval');
  const inside=valid.filter(x=>time>=x.start&&time<x.end);
  const near=valid.filter(x=>time<x.start&&x.start-time<=NEAR_SECONDS);
  const candidate=(inside.length?inside:near).sort((a,b)=>a.start-b.start||a.end-b.end)[0];
  if(!candidate)return no('outside-interval');
  return {ok:true,target:candidate.end,segment:{...candidate},reason:inside.length?'inside':'near'};
}
module.exports={decideSkip,NEAR_SECONDS,TYPES};
