(function(root){
  'use strict';
  root.WatchPartyUI={create({api,h,toast,toastAction,refresh,go,language,avatar,openDialog}){
    let party={connection:'idle',invites:[],telemetry:{},preferences:{sync:{}}},friends=[],signature='';
    const tr=(it,en)=>language()==='it'?it:en;
    const names={idle:['Nessuna stanza','No room'],approval:['In attesa dell’host','Waiting for host approval'],connecting:['Connessione…','Connecting…'],connected:['Connesso','Connected'],reconnecting:['Riconnessione…','Reconnecting…'],synced:['Sincronizzato','Synchronized'],correcting:['Correzione graduale','Correcting drift'],loading:['Caricamento sorgente','Loading source'],source:['Sorgente richiesta','Source needed'],version:['Edizione differente','Different edition'],buffering:['Buffering','Buffering'],'host-buffering':['Host in buffering','Host buffering'],'local-pause':['Pausa individuale','Individual pause'],detached:['Fuori sincronizzazione','Out of sync'],stopped:['Player chiuso','Player closed']};
    const label=value=>names[value]?tr(...names[value]):value||'—';
    const run=async(channel,...args)=>{try{return await api.invoke(channel,...args);}catch(error){toast(error.message||String(error),'error');return null;}};
    const button=(text,fn,disabled=false,style='')=>h('button',{class:'btn '+style,disabled,onclick:fn},text);
    const identity=p=>({display_name:p.name,avatar_url:p.avatarUrl});
    const metric=()=>{const t=party.telemetry||{};return `RTT ${t.rtt==null?'—':Math.round(t.rtt)+' ms'} · Δ ${t.drift==null?'—':Math.round(t.drift*1000)+' ms'} · ${t.state==='host'?'Host':label(t.state)}`;};
    const currentPosition=()=>{const p=party.room?.playback;if(!p)return '—';const seconds=Math.max(0,p.position);return `${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')}`;};
    function receive(value){
      const oldIds=new Set((party.invites||[]).map(i=>i.id));party=value;
      for(const invite of party.invites||[])if(!oldIds.has(invite.id))toastAction(tr(`${invite.from} ti invita a un Watch Party`,`${invite.from} invited you to a Watch Party`),tr('Entra','Join'),()=>run('watchparty:acceptInvite',invite.id));
      for(const node of document.querySelectorAll('.party-live'))node.textContent=metric();
      for(const node of document.querySelectorAll('.party-position'))node.textContent=currentPosition();
      const r=party.room;const next=JSON.stringify([party.connection,party.error,party.authenticated,party.needsSource,party.code,r?.code,r?.hostId,r?.participants,r?.permissions,r?.pending,r?.bans,r?.playback?.content,party.invites,party.preferences]);
      if(next!==signature){signature=next;refresh();}
    }
    function sourceDialog(){
      openDialog(tr('Sorgente equivalente','Equivalent source'),close=>{
        const input=h('input',{class:'input',type:'url',placeholder:'https://…','aria-label':tr('URL del video','Video URL')});
        return [h('p',null,tr('Incolla una sorgente della stessa edizione.','Paste a source for the same edition.')),input,h('div',{class:'foot'},button(tr('Apri','Open'),async()=>{if(input.value.trim()&&await run('watchparty:source',{url:input.value.trim()})!==null)close();},false,'primary'))];
      });
    }
    function page(){
      const r=party.room,host=r?.hostId===party.participantId,panels=[];
      const title=h('header',{class:'head'},h('div',null,h('span',{class:'eyebrow'},'ANIME PLAYER'),h('h1',null,'Watch Party')));
      if(party.error)panels.push(h('p',{class:'party-error',role:'alert'},party.error));
      panels.push(h('div',{class:'party-connection','data-party-connection':party.connection},h('span',{class:'chip '+(party.connection==='connected'?'ok':'')},label(party.connection)),h('span',{class:'muted small party-live'},metric())));
      if(!r){
        const name=h('input',{class:'input',maxlength:48,placeholder:tr('Nome ospite','Guest name'),value:tr('Ospite','Guest'),'data-party':'guest-name'});
        const privateRoom=h('input',{type:'checkbox','data-party':'private'}),code=h('input',{class:'input party-code',maxlength:8,placeholder:'ABCDEFG2','aria-label':tr('Codice stanza','Room code'),'data-party':'join-code'});
        panels.push(h('section',{class:'panel party-panel'},h('h2',null,tr('Crea stanza','Create room')),party.authenticated?h('p',{class:'muted'},tr('Userai il tuo account Anime Player.','Your Anime Player account will be used.')):name,h('label',{class:'party-check'},privateRoom,tr('Privata: invito o approvazione host','Private: invitation or host approval')),button(tr('Crea stanza','Create room'),()=>run('watchparty:create',{name:name.value,private:privateRoom.checked}),party.connection!=='idle','primary')));
        panels.push(h('section',{class:'panel party-panel'},h('h2',null,tr('Unisciti tramite codice','Join with code')),h('div',{class:'row'},code,button(tr('Entra','Join'),()=>run('watchparty:join',{code:code.value,name:name.value}),party.connection!=='idle','primary')),party.connection==='approval'?button(tr('Annulla richiesta','Cancel request'),()=>run('watchparty:leave')):null));
      }else{
        panels.push(h('section',{class:'panel party-panel'},h('div',{class:'party-heading'},h('div',null,h('h2',null,tr('Stanza','Room')+' '+r.code),h('p',{class:'muted small'},r.private?tr('Privata','Private'):tr('Pubblica tramite codice','Public via code'))),h('div',{class:'row'},button(tr('Copia codice','Copy code'),()=>run('watchparty:copyCode')),button(tr('Esci','Leave'),()=>run('watchparty:leave'),false,'danger'))),
          h('h3',null,r.playback?.content.title||tr('Scegli un contenuto nella libreria','Choose content from the library')),h('p',{class:'party-position'},currentPosition()),
          h('div',{class:'row'},button(tr('Risincronizza','Resync'),()=>run('watchparty:resync'),party.connection!=='connected','primary'),button(tr('Pausa individuale','Individual pause'),()=>run('watchparty:pauseLocal')),button(tr('Pausa/ripresa per tutti','Shared pause/play'),()=>run('watchparty:command','playPause',{paused:!r.playback?.paused}),!r.playback||!host&&!r.permissions.playPause)),
          party.needsSource?h('div',{class:'party-source'},h('p',null,tr('Scegli una sorgente equivalente. Il controllo della durata resta attivo.','Choose an equivalent source. Duration checks remain active.')),button(tr('Sorgente URL','Source URL'),sourceDialog),button(tr('File locale','Local file'),()=>run('watchparty:source',{mode:'file'}))):null));
        const target=h('input',{class:'input',type:'number',min:0,step:1,placeholder:tr('Secondi','Seconds'),'aria-label':tr('Posizione condivisa in secondi','Shared position in seconds')});
        panels.push(h('section',{class:'panel party-panel'},h('h2',null,tr('Partecipanti','Participants')),h('div',{class:'social-list'},r.participants.map(p=>h('article',{class:'social-user'},avatar(identity(p)),h('div',{class:'social-user-copy'},h('b',null,p.name+(p.id===r.hostId?' · HOST':'')),h('span',{class:'muted small'},[p.guest?tr('Ospite','Guest'):tr('Account','Account'),p.connected?tr('Connesso','Connected'):tr('Offline temporaneo','Temporarily offline'),p.localPaused?tr('Fuori sincronizzazione','Out of sync'):p.buffering?'Buffering':''].filter(Boolean).join(' · '))),host&&p.id!==r.hostId?h('div',{class:'social-actions'},button(tr('Espelli','Kick'),()=>run('watchparty:moderate','kick',p.id)),button('Ban',()=>run('watchparty:moderate','ban',p.id),false,'danger')):null))),h('div',{class:'row'},target,button(tr('Sposta tutti','Shared seek'),()=>run('watchparty:command','seek',{position:Number(target.value)}),!host&&!r.permissions.seek))));
        if(host){const labels={playPause:tr('Play/pausa','Play/pause'),seek:tr('Timeline','Timeline'),content:tr('Cambio contenuto','Content changes'),skip:tr('Skip opening/ending','Opening/ending skip')};
          panels.push(h('section',{class:'panel party-panel'},h('h2',null,tr('Permessi partecipanti','Participant permissions')),h('p',{class:'muted small'},tr('L’host conserva tutti i controlli. Abilita le azioni condivise per gli altri.','The host retains all controls. Enable shared actions for other participants.')),Object.entries(labels).map(([key,text])=>{const checkbox=h('input',{type:'checkbox',checked:r.permissions[key],onchange:()=>run('watchparty:permissions',{...r.permissions,[key]:checkbox.checked})});return h('label',{class:'party-check'},checkbox,text);}),
            ...(r.pending||[]).map(p=>h('div',{class:'row'},h('span',null,p.name),button(tr('Ammetti','Approve'),()=>run('watchparty:moderate','approve',p.id)),button(tr('Rifiuta','Reject'),()=>run('watchparty:moderate','reject',p.id)))),
            ...Object.entries(r.bans||{}).map(([id,name])=>h('div',{class:'row'},h('span',null,name+' · Ban'),button(tr('Revoca ban','Revoke ban'),()=>run('watchparty:moderate','unban',id))))));
          if(party.authenticated)panels.push(h('section',{class:'panel party-panel'},h('h2',null,tr('Invita amici','Invite friends')),button(tr('Mostra amici','Show friends'),async()=>{const list=await run('friends:list');friends=list||[];refresh();}),h('div',{class:'social-list'},friends.map(p=>h('article',{class:'social-user','data-party-friend':p.id},avatar(p),h('b',null,p.display_name||p.username),button(tr('Invita','Invite'),async()=>{const result=await run('watchparty:invite',p.id);if(result)toast(tr('Invito inviato','Invitation sent'));}))))));
        }
      }
      if(party.invites?.length)panels.push(h('section',{class:'panel party-panel'},h('h2',null,tr('Inviti ricevuti','Received invitations')),party.invites.map(i=>h('div',{class:'row'},h('span',null,i.from),button(tr('Accetta','Accept'),()=>run('watchparty:acceptInvite',i.id),false,'primary'),button(tr('Rifiuta','Decline'),()=>run('watchparty:dismissInvite',i.id))))));
      const share=h('input',{type:'checkbox',checked:party.preferences.shareSource,onchange:()=>run('watchparty:configure',{shareSource:share.checked})});
      const settings=party.preferences.sync||{},inputs={};const settingsLabels={deadband:tr('Tolleranza senza correzione (s)','Deadband (s)'),hardSeek:tr('Soglia seek (s)','Seek threshold (s)'),maxRateDelta:tr('Correzione massima velocità','Maximum speed correction'),rateWindow:tr('Finestra correzione (s)','Correction window (s)'),seekCooldownMs:tr('Pausa tra seek (ms)','Seek cooldown (ms)'),durationTolerance:tr('Tolleranza durata','Duration tolerance')};
      panels.push(h('details',{class:'panel party-panel'},h('summary',null,tr('Preferenze sincronizzazione','Synchronization preferences')),h('label',{class:'party-check'},share,tr('Condividi URL pubblici senza parametri o credenziali','Share public URLs without parameters or credentials')),h('p',{class:'muted small'},tr('I file locali non vengono trasmessi. Per un ospite il ban riguarda questa identità temporanea.','Local files are not transmitted. Guest bans apply to this temporary identity.')),Object.entries(settingsLabels).map(([key,text])=>{const input=h('input',{class:'input',type:'number',step:'any',value:settings[key]});inputs[key]=input;return h('label',{class:'party-setting'},text,input);}),button(tr('Salva soglie','Save thresholds'),()=>run('watchparty:configure',{sync:Object.fromEntries(Object.entries(inputs).map(([k,node])=>[k,Number(node.value)]))}))));
      return h('div',{class:'page party-page'},title,...panels);
    }
    function banner(){const r=party.room;if(!r)return null;return h('div',{class:'party-banner',role:'status'},h('button',{class:'btn sm',onclick:()=>go({name:'watchparty'})},'Watch Party · '+r.code),h('div',{class:'party-avatars'},r.participants.slice(0,16).map(p=>h('span',{title:p.name+(p.id===r.hostId?' · HOST':'')},avatar(identity(p))))),h('span',{class:'muted small'},label(party.connection)));}
    return {page,banner,receive};
  }};
})(globalThis);
