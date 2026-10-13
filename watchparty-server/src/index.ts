import {RoomObject} from './room';
import {InboxObject} from './inbox';
import {PartyEnv,Actor,body,json,deny,failure} from './types';
import {identity,guestToken,friendship} from './auth';
import Protocol from '../../src/watchparty-protocol';
// Preserve the existing SQLite namespace and v1 migration.
export class MyDurableObject extends RoomObject{}
export class InviteInbox extends InboxObject{}
const rooms=(env:PartyEnv,code:string)=>env.MY_DURABLE_OBJECT.getByName('room:'+code);
const inbox=(env:PartyEnv,id:string)=>env.INVITE_INBOX.getByName('user:'+id);
async function rate(request:Request,env:PartyEnv,kind:string){const ip=request.headers.get('CF-Connecting-IP')||'local';const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(ip));const name=Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('');await env.INVITE_INBOX.getByName('limit:'+name).admit(kind);}
function randomCode(){const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';return Array.from(crypto.getRandomValues(new Uint8Array(8)),v=>alphabet[v%32]).join('');}
export default {
  async fetch(request:Request,env:PartyEnv):Promise<Response>{try{
    const path=new URL(request.url).pathname;
    if(path==='/health'&&request.method==='GET')return json({ok:true,protocol:1,service:'watchparty-server',maxParticipants:Math.max(2,Math.min(64,Number(env.ROOM_MAX_PARTICIPANTS)||16)),accounts:!!(env.SUPABASE_URL&&env.SUPABASE_PUBLIC_KEY),guests:!!env.PARTY_SIGNING_KEY});
    const socket=path.match(/^\/api\/v1\/rooms\/([A-HJ-NP-Z2-9]{8})\/socket$/);
    if(socket&&request.method==='GET')return rooms(env,socket[1]).fetch(request);
    const inboxSocket=path.match(/^\/api\/v1\/inbox\/([a-f0-9-]{36})\/socket$/);
    if(inboxSocket&&request.method==='GET')return inbox(env,inboxSocket[1]).fetch(request);
    if(request.method!=='POST')deny(404,'Endpoint inesistente');
    await rate(request,env,path==='/api/v1/guests'?'guest':path==='/api/v1/rooms'?'create':'api');const input=await body(request);
    if(path==='/api/v1/guests'){let previous:Actor|undefined;if(request.headers.get('Authorization')?.startsWith('Guest '))previous=await identity(request,env);return json(await guestToken(env,input.name,previous));}
    const actor=await identity(request,env);
    if(path==='/api/v1/rooms'){for(let attempt=0;attempt<3;attempt++){const code=randomCode();try{await rooms(env,code).create(actor,code,!!input.private);return json({code,...await rooms(env,code).ticket(actor)});}catch(error){if(!(error instanceof Error)||!error.message.includes('Codice già'))throw error;}}return deny(503,'Creazione stanza non disponibile');}
    if(path==='/api/v1/inbox/ticket'){if(actor.guest)deny(403,'Gli inviti amici richiedono un account');return json({userId:actor.id,...await inbox(env,actor.id).ticket(actor)});}
    if(path==='/api/v1/inbox/list'){if(actor.guest)deny(403,'Accesso richiesto');return json({invites:await inbox(env,actor.id).list()});}
    if(path==='/api/v1/inbox/dismiss'){if(actor.guest)deny(403,'Accesso richiesto');return json(await inbox(env,actor.id).dismiss(input.id));}
    const operation=path.match(/^\/api\/v1\/rooms\/([^/]+)\/(ticket|invite)$/);if(!operation)deny(404,'Endpoint inesistente');const code=Protocol.code(operation![1]);
    if(operation![2]==='ticket'){const result=await rooms(env,code).ticket(actor,input.invite);if(input.invite&&!result.pending&&!actor.guest)await inbox(env,actor.id).dismiss(input.invite);return json({code,...result});}
    await friendship(request,env,actor,String(input.userId));const invitation=await rooms(env,code).invite(actor,String(input.userId));await inbox(env,String(input.userId)).add(invitation);return json({ok:true});
  }catch(error){const result=failure(error);return json({error:result.message},result.status);}}
} satisfies ExportedHandler<PartyEnv>;
