'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert'),{execFileSync}=require('child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anime-linked-runner-')),result=path.join(dir,'result.json');
const evidence=process.env.PHASE3B_EVIDENCE_DIR;
try{const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  execFileSync(require('electron'),[path.join(__dirname,'franchise-links-electron.js'),`--result=${result}`,...(evidence?[`--screenshots=${evidence}`]:[])],{env,windowsHide:true,timeout:50000,stdio:'pipe'});
  const report=JSON.parse(fs.readFileSync(result,'utf8'));if(evidence)fs.writeFileSync(path.join(evidence,'electron-results.json'),JSON.stringify(report,null,2));assert.equal(report.ok,true,report.error);console.log('Franchise links Electron:',report.cases.join('; '));
}catch(e){if(fs.existsSync(result))console.error(fs.readFileSync(result,'utf8'));throw e;}
finally{fs.rmSync(dir,{recursive:true,force:true});}
