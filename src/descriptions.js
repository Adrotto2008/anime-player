'use strict';
const crypto=require('crypto');

const LANGUAGES=new Set(['it','en']);
const textValue=value=>typeof value==='string'?value:'';
function hash(text){return crypto.createHash('sha256').update(textValue(text),'utf8').digest('hex');}
function descriptionFields(record={}){
  const original=textValue(record.descriptionOriginal ?? record.description);
  const translations={};
  for(const language of LANGUAGES){
    const entry=record.descriptionTranslations?.[language];
    if(entry && typeof entry.text==='string' && entry.originalHash===hash(original) && typeof entry.provider==='string')
      translations[language]={text:entry.text,originalHash:entry.originalHash,provider:entry.provider,updatedAt:Math.max(0,Number(entry.updatedAt)||0)};
  }
  return {description:original,descriptionOriginal:original,
    descriptionLanguage:typeof record.descriptionLanguage==='string'?record.descriptionLanguage:'unknown',
    descriptionSource:typeof record.descriptionSource==='string'?record.descriptionSource:(record.description?'legacy':'unknown'),
    descriptionTranslations:translations};
}

function createDescriptionService({provider=null,now=Date.now,timeoutMs=15000}={}){
  const pending=new Map(),failures=new Map();
  async function resolve(record,language){
    const fields=descriptionFields(record),original=fields.descriptionOriginal,target=String(language||'').toLowerCase();
    if(!original)return{text:'',status:'empty',language:target,translations:fields.descriptionTranslations};
    if(!LANGUAGES.has(target))return{text:original,status:'original',language:fields.descriptionLanguage,translations:fields.descriptionTranslations};
    const cached=fields.descriptionTranslations[target];
    if(cached)return{text:cached.text,status:'translated',language:target,provider:cached.provider,translations:fields.descriptionTranslations};
    const key=`${target}:${hash(original)}`;
    if(!provider)return{text:original,status:'unavailable',language:fields.descriptionLanguage,translations:fields.descriptionTranslations};
    if(failures.get(key)>now())return{text:original,status:'unavailable',language:fields.descriptionLanguage,translations:fields.descriptionTranslations};
    if(pending.has(key))return pending.get(key);
    const work=(async()=>{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error('Translation timed out')),timeoutMs);
      try{
        const response=await provider(original,target,{signal:controller.signal});
        const translated=typeof response==='string'?response:textValue(response?.text);
        const providerName=typeof response==='object'&&typeof response.provider==='string'?response.provider:'';
        if(!translated.trim() || !providerName)throw new Error('Translation provider returned no verified result');
        const translations={...fields.descriptionTranslations,[target]:{text:translated,originalHash:hash(original),provider:providerName,updatedAt:now()}};
        return{text:translated,status:'translated',language:target,provider:providerName,translations};
      }catch{
        failures.set(key,now()+10*60*1000);
        return{text:original,status:'unavailable',language:fields.descriptionLanguage,translations:fields.descriptionTranslations};
      }finally{clearTimeout(timer);}
    })();
    pending.set(key,work);
    try{return await work;}finally{pending.delete(key);}
  }
  return {resolve,hash};
}

module.exports={createDescriptionService,descriptionFields,hashDescription:hash};
