(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PlaybackShortcuts=api;})(globalThis,function(){
  'use strict';
  const DEFAULTS={next:'PGDWN',previous:'PGUP',skipIntro:'Ctrl+O',skipEnding:'Ctrl+E',partyStatus:'Ctrl+Alt+w',partyResync:'Ctrl+Alt+r',partyResyncAll:'Ctrl+Alt+R'};
  const ACTIONS={next:'ap-next',previous:'ap-prev',skipIntro:'ap-skip-intro',skipEnding:'ap-skip-ending',partyStatus:'ap-party-status',partyResync:'ap-party-resync',partyResyncAll:'ap-party-resync-all'};
  const aliases={PageDown:'PGDWN',PageUp:'PGUP',ArrowLeft:'LEFT',ArrowRight:'RIGHT',ArrowUp:'UP',ArrowDown:'DOWN',Enter:'ENTER',Escape:'ESC',Backspace:'BS',Delete:'DEL',Insert:'INS',' ':'SPACE',Tab:'TAB',Home:'HOME',End:'END'};
  const special=new Set(['PGDWN','PGUP','LEFT','RIGHT','UP','DOWN','ENTER','ESC','BS','DEL','INS','SPACE','TAB','HOME','END','PAUSE','PRINT',...Array.from({length:24},(_,i)=>'F'+(i+1))]);
  function normalize(raw){
    if(typeof raw!=='string'||raw.length>80||/[\r\n\x00-\x1f]/.test(raw))throw Error('Combinazione non valida / Invalid shortcut');
    raw=raw.trim();if(!raw)return '';
    const parts=raw.split('+'),keyRaw=parts.pop(),mods=new Set();
    for(const part of parts){const mod={ctrl:'Ctrl',control:'Ctrl',alt:'Alt',shift:'Shift',meta:'Meta'}[part.toLowerCase()];if(!mod||mods.has(mod))throw Error('Modificatori non validi / Invalid modifiers');mods.add(mod);}
    let key=aliases[keyRaw]||keyRaw;
    if(special.has(key.toUpperCase()))key=key.toUpperCase();
    else if(!/^[\p{L}\p{N}]$/u.test(key))throw Error('Usa una lettera, un numero o un tasto speciale / Use a letter, number or special key');
    if(!special.has(key)){if(/^[a-zA-Z]$/.test(key)&&mods.has('Shift'))key=key.toUpperCase();mods.delete('Shift');}
    return [...['Ctrl','Alt','Shift','Meta'].filter(x=>mods.has(x)),key].join('+');
  }
  function capture(event){
    if(event.repeat||['Control','Alt','Shift','Meta','CapsLock'].includes(event.key))return null;
    if(event.isComposing||event.key==='Dead'||event.getModifierState?.('AltGraph'))throw Error('Combinazione non supportata / Unsupported shortcut');
    return normalize([event.ctrlKey&&'Ctrl',event.altKey&&'Alt',event.shiftKey&&'Shift',event.metaKey&&'Meta',aliases[event.key]||event.key].filter(Boolean).join('+'));
  }
  function effective(raw){
    const result={...DEFAULTS,...(raw||{})};
    // An older custom binding keeps its key when a new default would collide.
    for(const action of ['partyResync','partyResyncAll'])if(!Object.hasOwn(raw||{},action)){
      const key=normalize(result[action]);
      for(const other of Object.keys(ACTIONS))if(other!==action&&Object.hasOwn(raw||{},other))try{if(normalize(raw[other])===key)result[action]='';}catch{}
    }
    return result;
  }
  function parse(raw){
    if(raw!=null && (typeof raw!=='object'||Array.isArray(raw)))throw Error('Preferenze scorciatoie non valide / Invalid shortcut preferences');
    const result={},seen=new Set();
    for(const action of Object.keys(DEFAULTS)){
      const key=normalize(effective(raw)[action]);
      if(key&&seen.has(key))throw Error('Combinazione duplicata: '+key);seen.add(key);result[action]=key;
    }
    return result;
  }
  function validate(raw){
    const result=parse(raw);
    for(const [action,key]of Object.entries(result)){
      if(/^(Ctrl\+[0-6]|Alt\+[1-6])$/.test(key))throw Error('Conflitto Anime4K: '+key);
      // Immediate feedback for the common mpv controls; the live player checks its complete binding list too.
      if(['SPACE','ENTER','ESC','LEFT','RIGHT','UP','DOWN','BS','q','Q','f','p','m','s','i','I','o','O','v','a','j','J','l','L','d','b','9','0','1','2','3','4','5','6','7','8','Ctrl+h'].includes(key))throw Error('Conflitto con mpv: '+key);
      if(['PGDWN','PGUP'].includes(key)&&key!==DEFAULTS[action])throw Error('Conflitto navigazione: '+key);
    }
    return result;
  }
  // A malformed legacy binding stays in preferences and is reported, never interpolated in input.conf.
  function bindings(raw){const result={};for(const [action,key]of Object.entries(effective(raw)))if(Object.hasOwn(ACTIONS,action)){try{result[action]=normalize(key);}catch{result[action]='';}}return result;}
  function display(raw){try{const key=normalize(raw),parts=key.split('+'),letter=parts.at(-1);if(/^[A-Z]$/.test(letter)){parts[parts.length-1]=letter.toLowerCase();parts.splice(parts.length-1,0,'Shift');}return parts.join(' + ');}catch{return raw;}}
  return {DEFAULTS,ACTIONS,normalize,capture,effective,parse,validate,bindings,display};
});
