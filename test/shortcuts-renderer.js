'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('node:assert/strict'),{spawnSync}=require('child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anime-shortcuts-run-')),result=path.join(dir,'result.json');
try{const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawnSync(require('electron'),[path.join(__dirname,'shortcuts-electron.js'),'--result='+result,'--profile='+path.join(dir,'profile')],{env,timeout:35000,encoding:'utf8',windowsHide:false});
  const report=fs.existsSync(result)?JSON.parse(fs.readFileSync(result,'utf8')):null;
  if(env.PHASE6_EVIDENCE_DIR&&report)fs.writeFileSync(path.join(env.PHASE6_EVIDENCE_DIR,'ui-results.json'),JSON.stringify(report,null,2));
  assert.ok(report,child.stderr||child.error?.message);assert.equal(report.ok,true,report.error);assert.equal(child.status,0,child.stderr);console.log('Shortcuts Electron:',report.cases.join('; '));
}finally{fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
