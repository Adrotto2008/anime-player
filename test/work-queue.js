'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createWorkQueue}=require('../src/work-queue');

test('interactive work jumps ahead of pending background work and duplicates coalesce',async()=>{
  const order=[];let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
  const q=createWorkQueue({concurrency:1});
  const first=q.enqueue('first',async()=>{entered();await gate;order.push('first');},{priority:'interactive'});await started;
  const background=q.enqueue('background',async()=>{order.push('background');return'bg';});
  const duplicate=q.enqueue('duplicate',async()=>{order.push('duplicate');return'dup';});
  const shared=q.enqueue('duplicate',async()=>{throw new Error('duplicate should share the first job');},{priority:'interactive'});
  const foreground=q.enqueue('foreground',async()=>{order.push('foreground');return'ui';},{priority:'interactive'});
  release();await Promise.all([first,background,duplicate,shared,foreground]);
  assert.deepEqual(order,['first','duplicate','foreground','background']);
});

test('cancelled work cannot report a late result as applicable',async()=>{
  let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve),queue=createWorkQueue();let current=true;
  const pending=queue.enqueue('cancel',async({isCurrent})=>{entered();await gate;return isCurrent()?{write:true}:{cancelled:true};},{isCurrent:()=>current});
  await started;current=false;release();assert.deepEqual(await pending,{cancelled:true});
});

test('concurrency limit is enforced',async()=>{
  let active=0,max=0;const q=createWorkQueue({concurrency:2});
  await Promise.all(Array.from({length:8},(_,i)=>q.enqueue(String(i),async()=>{active++;max=Math.max(max,active);await new Promise(resolve=>setImmediate(resolve));active--;})));
  assert.equal(max,2);
});
