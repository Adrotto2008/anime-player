'use strict';
const {execFileSync}=require('child_process');
const path=require('path');
const {prepareBuildConfig}=require('./build-config');
const root=path.resolve(__dirname,'..');
// Never read AppData, implicit environment keys, or a previous build resource.
prepareBuildConfig({root,configFile:process.env.SUPABASE_CONFIG_FILE});
execFileSync(process.execPath,[path.join(__dirname,'check.js')],{cwd:root,stdio:'inherit'});
const target={win32:'--win',darwin:'--mac',linux:'--linux'}[process.platform];
if(!target)throw new Error('Unsupported packaging platform.');
const args=[require.resolve('electron-builder/cli.js'),target];
if(process.platform==='win32')args.push('portable','nsis','--x64');
args.push('--publish','never');
execFileSync(process.execPath,args,{cwd:root,stdio:'inherit',windowsHide:true});
execFileSync(process.execPath,[path.join(__dirname,'release-verify.js')],{cwd:root,stdio:'inherit',windowsHide:true});
