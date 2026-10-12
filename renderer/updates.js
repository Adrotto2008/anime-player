/* Isolated view: release notes are text, never HTML or privileged links. */
(() => {
'use strict';
window.UpdateView=function({h,api,language,onState}){
  const it=language==='it',tr=(a,b)=>it?a:b;
  const statusNames={idle:tr('Pronto per la verifica.','Ready to check.'),checking:tr('Controllo in corso…','Checking…'),current:tr('Nessun aggiornamento disponibile.','You are up to date.'),available:tr('Nuova versione disponibile.','New version available.'),downloading:tr('Download in corso…','Downloading…'),downloaded:tr('Aggiornamento scaricato.','Update downloaded.'),cancelled:tr('Download interrotto. Puoi riprovare.','Download interrupted. Retry when ready.'),error:tr('Aggiornamento non riuscito.','Update failed.'),unsupported:tr('Installazione non disponibile per questo formato.','Installation unavailable for this format.'),installing:tr('Salvataggio e riavvio…','Saving and restarting…')};
  const version=h('p'),last=h('p',{class:'muted small'}),status=h('p',{role:'status','aria-live':'polite'}),reason=h('p',{class:'muted small'}),release=h('p'),notes=h('pre',{class:'update-notes'}),meter=h('progress',{max:100,value:0,'aria-label':tr('Download aggiornamento','Update download')}),details=h('p',{class:'muted small'}),warning=h('p',{class:'muted small'});
  const checkAtStartup=h('input',{type:'checkbox','data-update':'automatic'}),onQuit=h('input',{type:'checkbox','data-update':'on-quit'});
  const act=async(channel,...args)=>{try{const next=await api.invoke(channel,...args);if(next){update(next);onState(next);}}catch(error){status.textContent=error.message;}};
  const button=(id,label,channel)=>h('button',{class:'btn','data-update':id,onclick:()=>act(channel)},label);
  const check=button('check',tr('Controlla aggiornamenti','Check for updates'),'updates:check');
  const download=button('download',tr('Scarica aggiornamento','Download update'),'updates:download');
  const install=button('install',tr('Aggiorna e riavvia','Update and restart'),'updates:install');
  const later=h('button',{class:'btn','data-update':'later',onclick:()=>act('updates:later',true)},tr('Più tardi (installa alla chiusura)','Later (install on exit)'));
  const releases=button('releases',tr('Apri release ufficiale','Open official release'),'updates:releases');
  checkAtStartup.addEventListener('change',()=>act('updates:configure',{checkAtStartup:checkAtStartup.checked}));
  onQuit.addEventListener('change',()=>act('updates:later',onQuit.checked));
  const root=h('section',{class:'form-section','data-updates':true},h('h3',null,tr('Aggiornamenti','Updates')),version,last,status,reason,release,notes,meter,details,warning,
    h('label',{class:'update-toggle'},checkAtStartup,tr('Controlla automaticamente all’avvio','Automatically check at startup')),
    h('label',{class:'update-toggle','data-update':'quit-option'},onQuit,tr('Installa alla prossima chiusura volontaria','Install on next voluntary exit')),
    h('div',{class:'row update-actions'},check,download,install,later,releases));
  const bytes=n=>((Number(n)||0)/1048576).toFixed(1)+' MB';
  function update(s){
    if(!s)return;
    version.textContent=tr('Versione installata: ','Installed version: ')+s.currentVersion;
    last.textContent=tr('Ultima verifica: ','Last check: ')+(s.preferences.lastChecked?new Date(s.preferences.lastChecked).toLocaleString(language):tr('mai','never'));
    status.textContent=s.error || statusNames[s.status] || s.status;
    reason.textContent=s.reason || '';reason.hidden=!s.reason;
    release.textContent=s.release?tr('Nuova versione: ','New version: ')+s.release.version+(s.release.date?' · '+new Date(s.release.date).toLocaleDateString(language):''):'';
    notes.textContent=s.release?.notes || tr('Changelog non disponibile.','Release notes unavailable.');notes.hidden=!s.release;
    meter.hidden=!s.progress;meter.value=Math.min(100,s.progress?.percent||0);
    details.hidden=!s.progress;details.textContent=s.progress?`${Math.min(100,s.progress.percent).toFixed(1)}% · ${bytes(s.progress.transferred)} / ${bytes(s.progress.total)} · ${bytes(s.progress.bytesPerSecond)}/s`:'';
    checkAtStartup.checked=s.preferences.checkAtStartup;checkAtStartup.disabled=s.busy;
    check.disabled=s.busy || ['checking','downloading','downloaded','installing'].includes(s.status);
    download.hidden=!s.installable||!s.release||['downloaded','installing'].includes(s.status);download.disabled=s.busy || !['available','error','cancelled'].includes(s.status);
    install.hidden=later.hidden=s.status!=='downloaded';install.disabled=s.busy||s.playing;
    warning.textContent=s.playing?tr('Interrompi la riproduzione prima di installare. Puoi continuare a scaricare.','Stop playback before installing. Downloads can continue.'):'';warning.hidden=!s.playing;
    onQuit.checked=s.installOnQuit;onQuit.parentElement.hidden=s.status!=='downloaded';
    releases.hidden=s.installable||s.format==='source';
  }
  return {root,update,load:()=>act('updates:state')};
};
})();
