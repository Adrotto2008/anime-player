'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert');const {execFileSync}=require('child_process');
const result=process.argv.find(x=>x.startsWith('--result='))?.slice(9) || path.join(fs.mkdtempSync(path.join(os.tmpdir(),'anime-imdb-result-')),'result.json');
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
try {execFileSync(require('electron'),[path.join(__dirname,'ratings-renderer-electron.js'),`--result=${result}`],{env,windowsHide:true,timeout:45000,stdio:'pipe'});const r=JSON.parse(fs.readFileSync(result,'utf8'));assert.equal(r.ok,true,r.error);console.log('IMDb Electron regressions:',r.cases.join('; '));}
catch(error){if(fs.existsSync(result))console.error(fs.readFileSync(result,'utf8'));throw error;}
