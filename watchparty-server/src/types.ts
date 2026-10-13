import type {MyDurableObject, InviteInbox} from './index';
export interface PartyEnv {
  MY_DURABLE_OBJECT:DurableObjectNamespace<MyDurableObject>;
  INVITE_INBOX:DurableObjectNamespace<InviteInbox>;
  PARTY_SIGNING_KEY:string;
  SUPABASE_URL:string;
  SUPABASE_PUBLIC_KEY:string;
  ROOM_MAX_PARTICIPANTS?:string;
  RECONNECT_GRACE_MS?:string;
}
export type Actor={id:string;name:string;avatarUrl:string|null;guest:boolean;until:number};
export type Member=Actor&{connected:boolean;offlineUntil?:number;localPaused?:boolean;buffering?:boolean};
export type Room={code:string;private:boolean;hostId:string;members:Record<string,Member>;pending:Record<string,Actor>;rejected?:Record<string,number>;bans:Record<string,string>;allowed:Record<string,boolean>;invites:Record<string,{userId:string;expires:number}>;revision:number;playback:any;createdAt:number};
export const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
export class PartyError extends Error{constructor(public status:number,message:string){super(`[PARTY:${status}] ${message}`);}}
// Cloudflare RPC preserves an Error's message, not its custom status property.
export function failure(error:unknown){const match=error instanceof Error?error.message.match(/\[PARTY:(4\d\d|503)\] ([^\r\n]+)/):null;return match?{status:Number(match[1]),message:match[2]}:{status:503,message:'Servizio temporaneamente non disponibile'};}
export const deny=(status:number,message:string):never=>{throw new PartyError(status,message);};
export async function body(request:Request){
  if(Number(request.headers.get('content-length')||0)>16384)deny(413,'Messaggio troppo grande');
  const reader=request.body?.getReader();if(!reader)deny(400,'JSON richiesto');let size=0;const chunks:Uint8Array[]=[];
  try{while(true){const {value,done}=await reader!.read();if(done)break;size+=value!.byteLength;if(size>16384){await reader!.cancel();deny(413,'Messaggio troppo grande');}chunks.push(value!);}}finally{reader!.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try{const value=JSON.parse(new TextDecoder().decode(bytes));if(!value||typeof value!=='object'||Array.isArray(value))deny(400,'Oggetto JSON richiesto');return value;}catch{return deny(400,'JSON non valido');}
}
export const randomToken=()=>crypto.randomUUID()+crypto.randomUUID();
