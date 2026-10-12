'use strict';
const fs=require('fs'),path=require('path');
class MpvDevice{
  constructor(profile){this.file=path.join(profile,'mpv-device.json');this.data=null;try{this.data=JSON.parse(fs.readFileSync(this.file,'utf8'));if(this.data?.complete!==true||typeof this.data.path!=='string'||!this.data.path)throw Error('Configurazione mpv non valida.');}catch(e){this.data=null;if(e.code!=='ENOENT')this.error='Configurazione dispositivo mpv illeggibile: riparazione necessaria.';}}
  complete(result,installDirectory=''){if(!result?.ok||!result.path)throw Error('Verifica mpv necessaria.');const data={complete:true,path:result.path,version:result.version,installDirectory};fs.mkdirSync(path.dirname(this.file),{recursive:true});if(this.error)fs.copyFileSync(this.file,this.file+'.corrupt-'+Date.now()+'.bak',fs.constants.COPYFILE_EXCL);fs.writeFileSync(this.file+'.tmp',JSON.stringify(data,null,2),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);this.data=data;this.error=null;}
  async inspect(manager,settings){
    if(this.error)return {ok:false,complete:false,repair:true,error:this.error};
    const configured=this.data?.path||settings.mpvPath;
    // A previously chosen path is never silently replaced by another installation.
    const result=configured?await manager.validate(configured):await manager.find();
    if(result.ok){if(!this.data)this.complete(result,settings.mpvInstallDirectory);return {...result,complete:true};}
    return {...result,complete:false,repair:!!(this.data||configured||settings.onboardingComplete)};
  }
}
module.exports={MpvDevice};
