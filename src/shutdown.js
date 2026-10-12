'use strict';
const {redact}=require('./source-state');
// before-quit can fire again while an asynchronous stop is in progress.
function installShutdown(app, getServices) {
  let finishing=false,finished=false;
  app.on('before-quit',event=>{
    if(finished)return;
    event.preventDefault();
    if(finishing)return;
    finishing=true;
    const {player,store,cloud,updates}=getServices();
    if(player)player.shuttingDown=true;
    try {cloud?.stop();} catch(error) {console.warn('Chiusura sync:',redact(error.message));}
    Promise.resolve().then(()=>player?.stop({reason:'shutdown'}))
      .catch(error=>console.warn('Chiusura player:',redact(error.message)))
      .finally(()=>{
        // The final watch-session callback may have queued another sync after the first stop.
        try {cloud?.stop();} catch(error) {console.warn('Chiusura sync finale:',redact(error.message));}
        let saveError;
        try {store?.save(true,true,{cloud:true});}
        catch(error) {saveError=error;console.error('Salvataggio finale:',redact(error.message));}
        finished=true;
        if(!updates?.finishQuit(saveError))app.quit();
      });
  });
}
module.exports={installShutdown};
