'use strict';
// Electron 44 may reject a copy request while the compositor is switching
// surfaces. Wait for real frames and retry a bounded number of times. Never
// substitute a blank image or silently skip a requested evidence capture.
async function captureSurface(win){
  let last;
  for(let attempt=0;attempt<3;attempt++){
    if(win.isDestroyed())throw Error('Evidence window was destroyed.');
    if(!win.isVisible() || attempt)win.show();
    win.focus();win.webContents.focus();
    try{
      let timer;
      try{await Promise.race([win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'),new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('Evidence frames did not become ready.')),1000);})]);}finally{clearTimeout(timer);}
      const image=await win.webContents.capturePage();if(image.isEmpty())throw Error('Empty compositor image.');return image;
    }
    catch(error){last=error;console.warn('Controlled evidence capture retry '+(attempt+1)+': '+error.message);await new Promise(r=>setTimeout(r,50));}
  }
  throw Error('Evidence capture failed after three real-frame attempts: '+last?.message,{cause:last});
}
module.exports={captureSurface};
