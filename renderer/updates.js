/* Isolated view: release notes are text, never HTML or privileged links. */
(() => {
'use strict';
window.UpdatePrompt=function({h,api,language,onState,onClose,onVersions}){
  const tr=(it,en)=>language==='it'?it:en;
  let current,closed=false;
  const version=h('p'),status=h('p',{role:'status','aria-live':'polite'}),notes=h('pre',{class:'update-notes'}),meter=h('progress',{max:100,value:0,'aria-label':tr('Download aggiornamento','Update download')});
  const close=h('button',{class:'btn','data-update-prompt':'close',onclick:()=>{closed=true;onClose();}},tr('Più tardi','Later'));
  const submit=h('button',{class:'btn primary','data-update-prompt':'update',onclick:async()=>{
    submit.disabled=true;
    try{
      if(!current.installable){await api.invoke('updates:releases');return;}
      if(current.status!=='downloaded')onState(await api.invoke('updates:download'));
      // Closing the popup cancels the requested restart, never the download.
      if(!closed&&current.status==='downloaded'&&!current.playing)onState(await api.invoke('updates:install'));
    }catch(error){status.textContent=error.message;}
    finally{if(!closed)submit.disabled=!!current.busy||current.playing&&current.status==='downloaded'||['downloading','installing'].includes(current.status);}
  }},tr('Aggiorna','Update'));
  const root=h('section',{'data-update-prompt':true},version,status,notes,meter,h('div',{class:'row update-actions'},close,submit,h('button',{class:'btn','data-update-prompt':'versions',onclick:()=>{closed=true;onVersions();}},tr('Visualizza tutte le versioni','View all versions'))));
  function update(s){
    if(!s||closed)return;current=s;
    version.textContent=tr('È disponibile Anime Player ','Anime Player is available: ')+s.release?.version+tr(' (installata: ',' (installed: ')+s.currentVersion+').';
    notes.textContent=s.release?.notes||'';notes.hidden=!s.release?.notes;
    meter.hidden=s.status!=='downloading';meter.value=Math.min(100,s.progress?.percent||0);
    status.textContent=s.error||(s.status==='downloading'?tr('Download in corso… ','Downloading… ')+Math.min(100,s.progress?.percent||0).toFixed(1)+'%':s.status==='installing'?tr('Salvataggio e riavvio…','Saving and restarting…'):s.status==='downloaded'&&s.playing?tr('Aggiornamento scaricato. Chiudi il popup e interrompi la riproduzione prima di riavviare da Versioni.','Update downloaded. Close this popup and stop playback before restarting from Versions.'):s.reason||tr('Aggiorna per scaricare la nuova versione e riavviare.','Update to download the new version and restart.'));
    submit.textContent=!s.installable?tr('Apri aggiornamento','Open update'):s.status==='downloaded'?tr('Aggiorna e riavvia','Update and restart'):tr('Aggiorna','Update');
    submit.disabled=!!s.busy||s.status==='downloaded'&&s.playing||['downloading','installing'].includes(s.status);
  }
  return {root,update};
};
window.UpdateView=function({h,api,language,onState}){
  const it=language==='it',tr=(a,b)=>it?a:b;
  const statusNames={idle:tr('Pronto per la verifica.','Ready to check.'),checking:tr('Controllo in corso…','Checking…'),current:tr('Nessun aggiornamento disponibile.','You are up to date.'),available:tr('Nuova versione disponibile.','New version available.'),downloading:tr('Download in corso…','Downloading…'),downloaded:tr('Aggiornamento scaricato.','Update downloaded.'),cancelled:tr('Download interrotto. Puoi riprovare.','Download interrupted. Retry when ready.'),error:tr('Aggiornamento non riuscito.','Update failed.'),unsupported:tr('Installazione non disponibile per questo formato.','Installation unavailable for this format.'),installing:tr('Salvataggio e riavvio…','Saving and restarting…')};
  const latestStable=h('p'),version=h('p'),last=h('p',{class:'muted small'}),status=h('p',{role:'status','aria-live':'polite'}),reason=h('p',{class:'muted small'}),release=h('p'),notes=h('pre',{class:'update-notes'}),meter=h('progress',{max:100,value:0,'aria-label':tr('Download aggiornamento','Update download')}),details=h('p',{class:'muted small'}),warning=h('p',{class:'muted small'});
  const mode=h('select',{class:'input','data-update':'mode'},...['automatic','manual','pinned'].map((v,i)=>h('option',{value:v},[tr('Automatica','Automatic'),tr('Manuale','Manual'),tr('Versione bloccata','Pinned version')][i])));
  const popup=h('input',{type:'checkbox','data-update':'popup'}),pin=h('p',{class:'muted small'});
  mode.addEventListener('change',()=>act('updates:configure',{mode:mode.value,pinnedVersion:mode.value==='pinned'?(currentState.status==='downloaded'?currentState.release.version:currentState.currentVersion):null}));
  popup.addEventListener('change',()=>act('updates:configure',{popupAtStartup:popup.checked}));
  let currentState,page=1;
  const history=h('div',{class:'release-history'}),historyStatus=h('p',{role:'status'}),prev=h('button',{class:'btn',onclick:()=>loadPage(page-1)},tr('Precedenti','Previous')),next=h('button',{class:'btn',onclick:()=>loadPage(page+1)},tr('Successive','Next'));
  async function loadPage(target){prev.disabled=next.disabled=true;historyStatus.textContent=tr('Caricamento versioni…','Loading versions…');try{const result=await api.invoke('updates:list',target);page=result.page;if(page===1)latestStable.textContent=tr('Ultima versione stabile: ','Latest stable version: ')+(result.releases[0]?.version||tr('non disponibile','unavailable'));history.replaceChildren(...result.releases.map(r=>{const choose=h('button',{class:'btn','data-incompatible':String(!r.installable),disabled:!r.installable||currentState?.busy||currentState?.preferences.mode==='pinned',onclick:()=>{
    const confirm=h('button',{class:'btn primary',onclick:async()=>{confirm.disabled=true;const result=await act('updates:select',r.version);if(result?.status==='available')dialog.remove();else confirm.disabled=false;}},tr('Conferma selezione','Confirm selection'));
    const dialog=h('section',{class:'panel',role:'group'},h('p',null,tr('Selezionare ','Select ')+r.version+'? '+tr('Prima dell’installazione verrà creato un backup verificato. Non garantisce un ripristino completo.','A verified backup will be created before installation. Full rollback is not guaranteed.')),confirm,h('button',{class:'btn',onclick:()=>dialog.remove()},tr('Annulla','Cancel')));card.append(dialog);
  }},r.direction==='downgrade'?tr('Seleziona downgrade','Select downgrade'):tr('Seleziona versione','Select version'));const card=h('article',{class:'panel release-card'},h('h3',null,r.version+(r.current?tr(' · Installata',' · Installed'):'')),h('p',{class:'muted small'},r.date?new Date(r.date).toLocaleDateString(language):'', ' · '+r.direction),h('pre',{class:'update-notes'},r.notes||tr('Nessun changelog','No release notes')),h('p',null,r.reason||tr('Compatibile; il pacchetto verrà verificato alla selezione.','Compatible; package will be verified on selection.')),choose);return card;}));historyStatus.textContent=tr('Pagina ','Page ')+page;prev.disabled=page===1;next.disabled=!result.hasMore;}catch(e){historyStatus.textContent=e.message;prev.disabled=page===1;next.disabled=true;}}
  const checkAtStartup=h('input',{type:'checkbox','data-update':'automatic'}),onQuit=h('input',{type:'checkbox','data-update':'on-quit'});
  const act=async(channel,...args)=>{try{const next=await api.invoke(channel,...args);if(next){update(next);onState(next);}return next;}catch(error){status.textContent=error.message;}};
  const button=(id,label,channel)=>h('button',{class:'btn','data-update':id,onclick:()=>act(channel)},label);
  const check=button('check',tr('Controlla aggiornamenti','Check for updates'),'updates:check');
  const download=button('download',tr('Scarica aggiornamento','Download update'),'updates:download');
  const install=button('install',tr('Installa versione e riavvia','Install version and restart'),'updates:install');
  const later=h('button',{class:'btn','data-update':'later',onclick:()=>act('updates:later',true)},tr('Più tardi (installa alla chiusura)','Later (install on exit)'));
  const releases=button('releases',tr('Apri release ufficiale','Open official release'),'updates:releases');
  checkAtStartup.addEventListener('change',()=>act('updates:configure',{checkAtStartup:checkAtStartup.checked}));
  onQuit.addEventListener('change',()=>act('updates:later',onQuit.checked));
  const root=h('section',{class:'form-section','data-updates':true},h('h3',null,tr('Aggiornamenti','Updates')),version,latestStable,last,status,reason,release,notes,meter,details,warning,
    h('label',null,tr('Modalità aggiornamenti','Update mode'),mode),pin,
    h('label',{class:'update-toggle'},popup,tr('Mostra popup all’avvio','Show startup popup')),
    h('label',{class:'update-toggle'},checkAtStartup,tr('Controlla automaticamente all’avvio','Automatically check at startup')),
    h('label',{class:'update-toggle','data-update':'quit-option'},onQuit,tr('Installa alla prossima chiusura volontaria','Install on next voluntary exit')),
    h('div',{class:'row update-actions'},check,download,install,later,releases),h('h3',null,tr('Cronologia versioni','Version history')),historyStatus,history,h('div',{class:'row'},prev,next));
  const bytes=n=>((Number(n)||0)/1048576).toFixed(1)+' MB';
  function update(s){
    if(!s)return;currentState=s;mode.value=s.preferences.mode||'automatic';mode.disabled=s.busy;popup.checked=s.preferences.popupAtStartup!==false;popup.disabled=s.busy;pin.textContent=s.preferences.mode==='pinned'?tr('Versione bloccata: ','Pinned version: ')+s.preferences.pinnedVersion:'';
    version.textContent=tr('Versione installata: ','Installed version: ')+s.currentVersion;
    last.textContent=tr('Ultima verifica: ','Last check: ')+(s.preferences.lastChecked?new Date(s.preferences.lastChecked).toLocaleString(language):tr('mai','never'));
    status.textContent=s.error || (s.status==='available'&&s.release?.direction==='downgrade'?tr('Downgrade selezionato.','Downgrade selected.'):statusNames[s.status]) || s.status;
    reason.textContent=s.reason || '';reason.hidden=!s.reason;
    release.textContent=s.release?tr('Versione selezionata/disponibile: ','Selected/available version: ')+s.release.version+(s.release.date?' · '+new Date(s.release.date).toLocaleDateString(language):''):'';
    notes.textContent=s.release?.notes || tr('Changelog non disponibile.','Release notes unavailable.');notes.hidden=!s.release;
    meter.hidden=!s.progress;meter.value=Math.min(100,s.progress?.percent||0);
    details.hidden=!s.progress;details.textContent=s.progress?`${Math.min(100,s.progress.percent).toFixed(1)}% · ${bytes(s.progress.transferred)} / ${bytes(s.progress.total)} · ${bytes(s.progress.bytesPerSecond)}/s`:'';
    checkAtStartup.checked=s.preferences.checkAtStartup;checkAtStartup.disabled=s.busy;
    for(const button of history.querySelectorAll('button'))button.disabled=!!s.busy||s.preferences.mode==='pinned'||['downloading','downloaded','installing'].includes(s.status)||button.dataset.incompatible==='true';
    check.disabled=s.busy || ['checking','downloading','downloaded','installing'].includes(s.status);
    download.hidden=!s.installable||!s.release||['downloaded','installing'].includes(s.status);download.disabled=s.busy || (s.preferences.mode==='pinned'&&s.release?.version!==s.preferences.pinnedVersion) || !['available','error','cancelled'].includes(s.status);
    install.hidden=later.hidden=s.status!=='downloaded';install.disabled=s.busy||s.playing;
    warning.textContent=s.playing?tr('Interrompi la riproduzione prima di installare. Puoi continuare a scaricare.','Stop playback before installing. Downloads can continue.'):'';warning.hidden=!s.playing;
    onQuit.checked=s.installOnQuit;onQuit.parentElement.hidden=s.status!=='downloaded';
    releases.hidden=s.installable||s.format==='source';
  }
  return {root,update,load:async()=>{await act('updates:state');await loadPage(1);}};
};
})();
