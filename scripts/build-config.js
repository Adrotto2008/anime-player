'use strict';
const fs=require('fs'),path=require('path');
const {readConfig}=require('../src/cloud');
function prepareBuildConfig({root,configFile,readFile=fs.readFileSync,writeFile=fs.writeFileSync}={}){
  let config={};
  if(configFile){
    let input;
    try{input=JSON.parse(readFile(path.resolve(root,configFile),'utf8'));}
    catch{throw new Error('Explicit Supabase build configuration is missing or invalid.');}
    if(!input||Array.isArray(input)||Object.keys(input).some(key=>!['url','publishableKey'].includes(key)))
      throw new Error('Build configuration accepts only url and publishableKey; no credentials or sessions.');
    let url;try{url=new URL(input.url);}catch{throw new Error('Invalid Supabase build URL.');}
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)
      throw new Error('Supabase build URL must be HTTPS without credentials, query or fragment.');
    const result=readConfig({SUPABASE_URL:input.url,SUPABASE_PUBLISHABLE_KEY:input.publishableKey});
    if(!result.configured)throw new Error('Explicit build configuration rejected: '+result.error);
    config={url:result.url,publishableKey:result.key};
  }
  const dir=path.join(root,'.build-resources');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  // Replace stale checkout resources without reading them. Default is offline.
  writeFile(path.join(dir,'supabase-config.json'),JSON.stringify(config),{mode:0o600});
  return config;
}
module.exports={prepareBuildConfig};
