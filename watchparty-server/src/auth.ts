import {Actor,PartyEnv,deny} from './types';
import Protocol from '../../src/watchparty-protocol';
const encoder=new TextEncoder();
function encode(value:Uint8Array){return btoa(String.fromCharCode(...value)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');}
function decode(value:string){return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));}
async function key(env:PartyEnv){if(!env.PARTY_SIGNING_KEY||env.PARTY_SIGNING_KEY.length<32)deny(503,'Identità ospite non configurata');return crypto.subtle.importKey('raw',encoder.encode(env.PARTY_SIGNING_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
export async function guestToken(env:PartyEnv,name:string,existing?:Actor){
  const actor={id:existing?.id||'guest:'+crypto.randomUUID(),name:String(name||'Ospite').trim().slice(0,48)||'Ospite',avatarUrl:null,guest:true,until:Date.now()+3600000};
  const payload=encode(encoder.encode(JSON.stringify(actor))),signature=await crypto.subtle.sign('HMAC',await key(env),encoder.encode(payload));
  return {token:payload+'.'+encode(new Uint8Array(signature)),expires:actor.until};
}
export async function identity(request:Request,env:PartyEnv):Promise<Actor>{
  const header=request.headers.get('Authorization')||'';
  if(header.startsWith('Guest ')){
    try{const [payload,signature,...extra]=header.slice(6).split('.');if(extra.length||!payload||!signature)throw Error();
      if(!await crypto.subtle.verify('HMAC',await key(env),decode(signature),encoder.encode(payload)))throw Error();
      const actor=JSON.parse(new TextDecoder().decode(decode(payload)));if(!actor.guest||!/^guest:[a-f0-9-]{36}$/.test(actor.id)||actor.until<=Date.now())throw Error();return actor;
    }catch{return deny(401,'Identità ospite scaduta o non valida');}
  }
  if(!header.startsWith('Bearer ')||header.length>12000)deny(401,'Accesso richiesto');
  if(!env.SUPABASE_URL||!env.SUPABASE_PUBLIC_KEY)deny(503,'Account non configurati');
  const headers={Authorization:header,apikey:env.SUPABASE_PUBLIC_KEY};
  const response=await fetch(env.SUPABASE_URL+'/auth/v1/user',{headers,signal:AbortSignal.timeout(8000)});
  if(!response.ok)deny(401,'Sessione account scaduta');const user:any=await response.json();
  if(!/^[a-f0-9-]{36}$/.test(user.id)||user.is_anonymous)deny(401,'Account non valido');
  // Display metadata is never used for authorization. Fetch the profile under caller RLS.
  const profileResponse=await fetch(env.SUPABASE_URL+'/rest/v1/profiles?select=display_name,username,avatar_url&id=eq.'+user.id,{headers,signal:AbortSignal.timeout(8000)});
  const rows:any=profileResponse.ok?await profileResponse.json():[];const p=rows[0]||{};
  const avatarUrl=Protocol.publicUrl(p.avatar_url);
  return {id:user.id,name:String(p.display_name||p.username||'Utente').slice(0,48),avatarUrl,guest:false,until:Date.now()+300000};
}
export async function friendship(request:Request,env:PartyEnv,actor:Actor,target:string){
  if(actor.guest||!/^[a-f0-9-]{36}$/.test(target)||target===actor.id)deny(403,'Seleziona un amico registrato');
  const query='select=user_id,friend_id&or='+encodeURIComponent(`(and(user_id.eq.${actor.id},friend_id.eq.${target}),and(user_id.eq.${target},friend_id.eq.${actor.id}))`);
  const response=await fetch(env.SUPABASE_URL+'/rest/v1/friendships?'+query,{headers:{Authorization:request.headers.get('Authorization')!,apikey:env.SUPABASE_PUBLIC_KEY},signal:AbortSignal.timeout(8000)});
  if(!response.ok||!(await response.json() as any[]).length)deny(403,'Amicizia non verificata');
}
