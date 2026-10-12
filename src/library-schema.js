'use strict';
// Root keys emitted by supported 0.5.34–0.5.45 libraries. Older snapshots
// omit newer optional keys; no unknown root extension is safe to discard.
const ROOT_KEYS=Object.freeze(['settings','settingsUpdatedAt','organization','series','franchises','franchiseLinks','deletedFranchises','deletedSeries','deletedEpisodes','updatedAt','cloudDirty']);
function validateRoot(input){
  if(!input || typeof input!=='object' || Array.isArray(input) || !Array.isArray(input.series))throw Error('Struttura della libreria non valida.');
  const unknown=Object.keys(input).filter(key=>!ROOT_KEYS.includes(key));
  if(unknown.length)throw Error('Libreria incompatibile: contiene campi root non riconosciuti. Conserva il file originale e usa una versione compatibile o un backup verificato; nessun dato verrà eliminato.');
  for(const key of ['franchises','franchiseLinks','deletedFranchises','deletedSeries','deletedEpisodes'])if(input[key]!=null&&!Array.isArray(input[key]))throw Error(`Elenco ${key} non valido.`);
  if(input.settings!=null && (typeof input.settings!=='object'||Array.isArray(input.settings)))throw Error('Impostazioni non valide.');
  return input;
}
function validateCloudEnvelope(input){
  if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(key=>!['library','history','sync'].includes(key)))throw Error('Snapshot cloud incompatibile; stato locale conservato.');
  validateRoot(input.library);
  if(input.history!=null&&!Array.isArray(input.history))throw Error('Cronologia cloud non valida.');
  if(input.sync!=null&&(typeof input.sync!=='object'||Array.isArray(input.sync)||Object.keys(input.sync).some(key=>!['mappings','favorites','removedFavorites','history','settingsUpdatedAt','libraryRevision'].includes(key))))throw Error('Stato sync incompatibile; stato locale conservato.');
  return input;
}
module.exports={ROOT_KEYS,validateRoot,validateCloudEnvelope};
