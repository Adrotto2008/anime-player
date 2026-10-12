'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('node:assert/strict'),{spawnSync}=require('child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anime-updates-electron-')),result=path.join(dir,'result.json');
try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const args=[path.join(__dirname,'updates-electron.js'),'--result='+result,'--profile='+path.join(dir,'profile')];
  if(env.UPDATE_EVIDENCE_DIR){fs.mkdirSync(env.UPDATE_EVIDENCE_DIR,{recursive:true});args.push('--screenshot='+path.join(env.UPDATE_EVIDENCE_DIR,'updates.png'));}
  const child=spawnSync(require('electron'),args,{env,timeout:45000,encoding:'utf8',windowsHide:false});const report=fs.existsSync(result)?JSON.parse(fs.readFileSync(result)):null;
  if(env.UPDATE_EVIDENCE_DIR&&report)fs.copyFileSync(result,path.join(env.UPDATE_EVIDENCE_DIR,'updates-electron.json'));
  assert.equal(child.status,0,child.stderr+'\n'+JSON.stringify(report));assert.equal(report?.ok,true);console.log('Real Electron updates:',report.cases.length,'checks passed.');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
