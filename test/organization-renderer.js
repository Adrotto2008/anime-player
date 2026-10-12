'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{spawnSync}=require('child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anime-organization-runner-')),result=path.join(dir,'result.json');
// Native compositor/input timing must be identical with and without exported evidence.
// Keep the same real PNG capture/write path; a normal run uses disposable scratch.
const evidence=process.env.PHASE5_EVIDENCE_DIR || path.join(dir,'evidence');
try{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawnSync(require('electron'),[path.join(__dirname,'organization-electron.js'),'--result='+result,...(evidence?['--evidence='+evidence]:[])],{env,windowsHide:false,timeout:150000,encoding:'utf8'});
  const report=fs.existsSync(result)?JSON.parse(fs.readFileSync(result,'utf8')):null;
  if(evidence && report){fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(path.join(evidence,'electron-results.json'),JSON.stringify(report,null,2));}
  assert.ok(report,child.stderr || child.error?.message || 'Electron did not produce a report');
  assert.equal(report.ok,true,report.error);assert.equal(child.status,0,child.stderr);
  console.log('Organization Electron:',report.cases.join('; '));console.log('Synthetic benchmarks:',JSON.stringify(report.benchmarks));
}finally{fs.rmSync(dir,{recursive:true,force:true});}
