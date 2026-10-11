'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {Store}=require('../src/store');
const {compressLibraryForCloud,expandLibraryFromCloud,mergeLibrarySnapshots}=require('../src/cloud');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'anime-player-description-'));const file=path.join(dir,'library.json');const store=new Store(file);t.after(()=>{clearTimeout(store._timer);fs.rmSync(dir,{recursive:true,force:true});});return{store,file,dir};}
test('original and exact-revision translations survive save, reopen, export/import and cloud merge',t=>{
  const {store,file,dir}=fixture(t),series=store.addSeries({title:'Synopsis fixture',description:'Original synopsis',descriptionLanguage:'en',descriptionSource:'AniList'});
  const entry={text:'Descrizione tradotta',provider:'fixture',originalHash:require('../src/descriptions').hashDescription('Original synopsis'),updatedAt:1};
  assert.equal(store.setDescriptionTranslation(series.id,'it',entry),true);store.setSettings({descriptionMode:'original'});store.save(true);
  const reopened=new Store(file);t.after(()=>clearTimeout(reopened._timer));
  const saved=reopened.getSeries(series.id);assert.equal(saved.descriptionOriginal,'Original synopsis');assert.equal(saved.descriptionTranslations.it.text,entry.text);assert.equal(reopened.data.settings.descriptionMode,'original');
  const exportPath=path.join(dir,'export.json');fs.writeFileSync(exportPath,JSON.stringify(reopened.snapshot()));
  const imported=new Store(path.join(dir,'import.json'));t.after(()=>clearTimeout(imported._timer));imported.importData(JSON.parse(fs.readFileSync(exportPath,'utf8')));
  assert.equal(imported.getSeries(series.id).descriptionTranslations.it.text,entry.text);
  const remote=expandLibraryFromCloud(compressLibraryForCloud(reopened.snapshot()));
  const merged=mergeLibrarySnapshots(imported.snapshot(),remote);
  assert.equal(merged.series[0].descriptionOriginal,'Original synopsis');assert.equal(merged.series[0].descriptionTranslations.it.text,entry.text);assert.equal(merged.settings.descriptionMode,'original');
});
test('refresh invalidates only translations whose original synopsis changed',t=>{
  const {store}=fixture(t),series=store.addSeries({title:'Synopsis fixture',description:'First',descriptionLanguage:'en',descriptionSource:'AniList'});
  store.setDescriptionTranslation(series.id,'it',{text:'Uno',provider:'fixture',originalHash:require('../src/descriptions').hashDescription('First'),updatedAt:1});
  store.refreshSeriesMetadata(series.id,{description:'Second',descriptionLanguage:'en',descriptionSource:'AniList'});
  assert.equal(series.descriptionOriginal,'Second');assert.deepEqual(series.descriptionTranslations,{});
});
