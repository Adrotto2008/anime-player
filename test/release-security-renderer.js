'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('node:assert/strict'),{spawnSync}=require('child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anime-release-security-')),result=path.join(dir,'result.json');
try{const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const child=spawnSync(require('electron'),[path.join(__dirname,'release-security-electron.js'),'--result='+result,'--profile='+path.join(dir,'profile')],{env,timeout:30000,encoding:'utf8',windowsHide:false});
 const report=fs.existsSync(result)?JSON.parse(fs.readFileSync(result,'utf8')):null;if(env.PHASE7_EVIDENCE_DIR&&report){fs.mkdirSync(env.PHASE7_EVIDENCE_DIR,{recursive:true});fs.writeFileSync(path.join(env.PHASE7_EVIDENCE_DIR,'security-final.json'),JSON.stringify(report,null,2));}
 assert.ok(report,child.stderr||child.error?.message);assert.equal(report.ok,true,report.error);assert.equal(child.status,0,child.stderr);console.log('Release security Electron: '+report.cases.join('; '));
}finally{fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
