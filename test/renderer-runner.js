'use strict';
const fs=require('fs');const os=require('os');const path=require('path');const assert=require('assert');const {execFileSync}=require('child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anime-player-electron-test-'));
const result=path.join(dir,'result.json');
try {
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  execFileSync(require('electron'),[path.join(__dirname,'renderer-electron.js'),`--result=${result}`],{env,windowsHide:true,timeout:45000,stdio:'pipe'});
  const report=JSON.parse(fs.readFileSync(result,'utf8'));assert.strictEqual(report.ok,true,report.error);
  console.log('Electron DOM/input regressions:',report.cases.join(', '));
} catch(error) {if(fs.existsSync(result))console.error(fs.readFileSync(result,'utf8'));throw error;}
finally{fs.rmSync(dir,{recursive:true,force:true});}
