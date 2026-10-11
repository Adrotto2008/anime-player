'use strict';
const fs=require('fs');
const path=require('path');
const {redact}=require('./source-state');
const LIMIT=50;
const messages={
  'ipc-timeout':'mpv non risponde alla connessione di controllo.',
  'ipc-disconnected':'La connessione di controllo con mpv si è interrotta.',
  'load-timeout':'La sorgente non è stata caricata entro il tempo previsto.',
  'track-timeout':'mpv non ha comunicato le tracce audio e sottotitoli.',
  'network-error':'mpv ha segnalato un errore di rete durante la riproduzione.',
  'source-error':'mpv non riesce a riprodurre questa sorgente.',
  'abnormal':'mpv è terminato in modo anomalo.',
  'unknown-exit':'mpv è terminato senza comunicare il motivo.',
};
function exitMessage(result) {
  return `${messages[result.reason] || 'La riproduzione si è interrotta.'}${result.error ? ' '+redact(result.error) : ''} Dettagli nella diagnostica player in Impostazioni.`;
}
class PlaybackDiagnostics {
  constructor(userData) {this.file=path.join(userData,'playback-diagnostics.json');}
  read() {
    try {const stat=fs.statSync(this.file);if(stat.size>1024*1024)return [];
      const data=JSON.parse(fs.readFileSync(this.file,'utf8'));return Array.isArray(data)?data.slice(-LIMIT):[];
    } catch {return [];}
  }
  record(cur,result) {
    // Explicit whitelist: never serialize arguments, headers, settings, cookies or raw source objects.
    const record={at:new Date().toISOString(),reason:result.reason || 'unknown-exit',requestedReason:result.requestedReason || null,appIntent:cur.stopReason || null,
      code:result.code ?? null,signal:result.signal || null,eof:!!result.eof,endReason:result.endReason || null,
      connected:!!result.connected,loaded:!!result.loaded,forced:!!result.forced,
      elapsedMs:Math.max(0,Date.now()-(cur.startedAt || Date.now())),position:cur.pos || 0,duration:cur.dur || 0,
      seriesId:cur.series?.id || null,episodeId:cur.ep?.id || null,sourceId:cur.source?.id || null,provider:cur.source?.provider || null,
      networkEvidence:redact(result.networkEvidence).slice(-1000),error:redact(result.error).slice(-1000),stderr:redact(result.stderr).slice(-4000),stdout:redact(result.stdout).slice(-4000)};
    const records=this.read();records.push(record);
    fs.mkdirSync(path.dirname(this.file),{recursive:true});
    const tmp=this.file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(records.slice(-LIMIT),null,2));fs.renameSync(tmp,this.file);
    return record;
  }
}
module.exports={PlaybackDiagnostics,exitMessage};
