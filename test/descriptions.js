'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createDescriptionService,descriptionFields}=require('../src/descriptions');

test('legacy text becomes an unknown-origin original without changing its value',()=>{
  const old={description:'legacy <b>text</b>'};
  const next=descriptionFields(old);
  assert.equal(next.descriptionOriginal,old.description);
  assert.equal(next.descriptionLanguage,'unknown');
  assert.deepEqual(next.descriptionTranslations,{});
});

test('translations are cached by language and exact source revision, preserving the original',async()=>{
  let calls=0;
  const service=createDescriptionService({provider:async(text,language)=>{calls++;return{text:`${language}:${text}`,provider:'test'};},now:()=>123});
  const record={descriptionOriginal:'English text',descriptionLanguage:'en',descriptionSource:'AniList'};
  const first=await service.resolve(record,'it');
  const second=await service.resolve({...record,descriptionTranslations:first.translations},'it');
  assert.equal(first.text,'it:English text');
  assert.equal(second.text,first.text);
  assert.equal(calls,1);
  assert.equal(record.descriptionOriginal,'English text');
  assert.equal(first.translations.it.originalHash,service.hash(record.descriptionOriginal));
  assert.equal(first.translations.it.updatedAt,123);
});

test('changed original invalidates only stale translation and never truncates long text',async()=>{
  const text='public synopsis '.repeat(500);
  const service=createDescriptionService({provider:async(source,language)=>({text:`translated ${source}`,provider:'test'})});
  const old=await service.resolve({descriptionOriginal:text,descriptionTranslations:{}},'it');
  const updated=await service.resolve({descriptionOriginal:`${text}!`,descriptionTranslations:old.translations},'it');
  assert.ok(updated.text.length>4500);
  assert.notEqual(updated.translations.it.originalHash,old.translations.it.originalHash);
  assert.ok(updated.text.endsWith('!'));
});

test('provider failure falls back to the full original and is not cached as a translation',async()=>{
  const service=createDescriptionService({provider:async()=>{throw new Error('offline');}});
  const record={descriptionOriginal:'Original synopsis',descriptionTranslations:{}};
  const result=await service.resolve(record,'it');
  assert.equal(result.text,'Original synopsis');
  assert.equal(result.status,'unavailable');
  assert.deepEqual(result.translations,{});
});

test('identical concurrent translation requests share one provider call',async()=>{
  let calls=0,release;
  const gate=new Promise(resolve=>release=resolve);
  const service=createDescriptionService({provider:async()=>{calls++;await gate;return{text:'tradotto',provider:'test'};}});
  const record={descriptionOriginal:'source',descriptionTranslations:{}};
  const a=service.resolve(record,'it'),b=service.resolve(record,'it');
  await new Promise(resolve=>setImmediate(resolve));
  release();
  assert.deepEqual(await Promise.all([a,b]),await Promise.all([a,b]));
  assert.equal(calls,1);
});
