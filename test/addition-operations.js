'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createAdditionOperationService}=require('../src/addition-operations');

function harness(addition){
  const events=[];
  const store=Object.assign(new EventEmitter(),{scope:0,getSeries:id=>id==='saved'?{id}:null});
  const service=createAdditionOperationService({store,addSeries:addition,notify:event=>events.push(event),schedule:fn=>setImmediate(fn)});
  return{service,events,store};
}

test('start reports immediately, tracks real phases and remains queryable after navigation',async()=>{
  let release;
  const gate=new Promise(resolve=>release=resolve);
  const {service,events}=harness(async(_payload,{operation:op})=>{
    op.report({phase:'metadata',status:'running',done:0,total:null});
    await gate;
    op.report({phase:'library',status:'completed',done:1,total:1});
    op.track('sources','saved',Promise.resolve({episodesFound:3,episodesAdded:2}));
    return{id:'saved',lib:{series:[{id:'saved'}]}};
  });
  const started=service.start({title:'Demo'});
  assert.ok(started.taskId);
  assert.equal(service.list()[0].status,'running');
  release();
  const result=await service.wait(started.taskId);
  assert.equal(result.status,'completed');
  assert.equal(service.list()[0].seriesId,'saved');
  assert.ok(events.some(event=>event.task.phase==='metadata'));
});

test('cancel prevents late result publication and keeps a previously saved title',async()=>{
  let release,entered;
  const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
  const {service}=harness(async(_payload,{operation:op})=>{
    op.setSeries('saved');
    op.track('metadata','saved',(async()=>{entered();await gate;return{late:true};})());
    return{id:'saved',lib:{series:[{id:'saved'}]}};
  });
  const {taskId}=service.start({title:'Demo'});
  await started;
  assert.equal(service.cancel(taskId),true);
  release();
  const result=await service.wait(taskId);
  assert.equal(result.status,'cancelled');
  assert.equal(result.seriesId,'saved');
});

test('retry uses the same idempotent payload with a fresh generation',async()=>{
  let attempts=0;
  const {service}=harness(async(payload)=>{attempts++;if(attempts===1)throw new Error('temporary');return{id:payload.id,lib:{series:[{id:payload.id}]}};});
  const {taskId}=service.start({id:'saved'});
  assert.equal((await service.wait(taskId)).status,'failed');
  assert.equal(service.retry(taskId),true);
  assert.equal((await service.wait(taskId)).status,'completed');
  assert.equal(attempts,2);
});

test('account switch invalidates a running task before late writes are reported',async()=>{
  let release,entered;
  const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
  const {service,store}=harness(async(_payload,{operation:op})=>{entered();await gate;if(!op.isCurrent())return{cancelled:true};return{id:'saved',lib:{series:[]}};});
  const {taskId}=service.start({title:'Demo'});
  await started;store.scope++;store.emit('changed');release();
  const result=await service.wait(taskId);
  assert.equal(result.status,'cancelled');
});

test('partial provider state survives a later successful job and remains retryable',async()=>{
 const {service}=harness(async(_payload,{operation:op})=>{
  op.track('sources','failed',Promise.resolve({status:'partial'}));
  op.track('sources','ok',new Promise(resolve=>setImmediate(()=>resolve({episodesFound:1}))));
  return{id:'saved'};
 });
 const {taskId}=service.start({title:'Partial'});assert.equal((await service.wait(taskId)).status,'partial');
 assert.equal(service.list()[0].stages.sources.status,'partial');assert.equal(service.retry(taskId),true);
 await service.wait(taskId);service.dispose();
});
