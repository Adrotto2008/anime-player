const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'updates:promptShown','mpv:startup','updates:ready','updates:list','updates:select','updates:state','updates:check','updates:download','updates:later','updates:install','updates:configure','updates:releases',
  'organization:context','organization:move','organization:section',
  'series:videoPreference', 'series:imdbSelect', 'episodes:sourceLanguage', 'player:languageFallback',
  'lib:get', 'library:export', 'library:import', 'series:search', 'series:create', 'series:addStart', 'series:addTasks', 'series:addCancel', 'series:addRetry', 'series:update', 'series:delete', 'series:refresh', 'series:ratings', 'series:discoverSources', 'movie:addLink', 'movie:play','content:addLink',
  'franchise:create','franchise:update','franchise:member','franchise:reorder','franchise:mergePreview','franchise:merge','franchise:delete','franchise:discover','franchise:accept','franchise:reject',
  'franchise:linkPreview','franchise:linkCreate','franchise:linkDecide','franchise:linkManual',
  'patterns:detect', 'episodes:addPattern', 'episodes:addList', 'episodes:addM3U', 'episodes:setSources', 'episodes:checkSources', 'episodes:delete', 'episodes:mark', 'episodes:rate',
  'episodes:skipTimes', 'player:play', 'player:playUrl', 'player:stop', 'player:diagnostics', 'player:preset', 'player:seekRelative', 'player:seekAbsolute', 'player:skipIntro', 'player:skipEnding', 'player:skipSegment', 'player:state',
  'settings:shortcutCapture', 'settings:shortcuts', 'settings:set', 'mpv:detect', 'mpv:browse', 'mpv:install', 'mpv:openGuide', 'presets:list', 'stats:get', 'app:version',
  'auth:state', 'auth:signUp', 'auth:signIn', 'auth:sendPasswordRecovery', 'auth:updatePassword', 'auth:takeRecoveryNotice', 'auth:signOut', 'profile:get', 'profile:mine', 'profile:update',
  'favorites:list', 'favorites:set', 'friends:search', 'friends:requests', 'friends:request', 'friends:respond', 'friends:list', 'friends:remove',
  'watchRooms:create', 'watchRooms:join', 'watchRooms:subscribe', 'watchRooms:broadcast', 'watchRooms:unsubscribe', 'sync:run',
]);
const ON = new Set(['updates:state','lib:changed', 'series:ratingsProgress', 'series:sourcesDiscovered', 'addition:progress', 'player:state', 'player:error', 'player:skip-offer', 'player:language-fallback', 'player:language-warning', 'sync:state', 'auth:recovery', 'watchRoom:playback', 'watchRoom:presence']);

contextBridge.exposeInMainWorld('animeApi', {
  invoke: (ch, ...args) => (INVOKE.has(ch) ? ipcRenderer.invoke(ch, ...args) : Promise.reject(new Error('canale non consentito: ' + ch))),
  on: (ch, cb) => { if (ON.has(ch)) ipcRenderer.on(ch, (_e, payload) => cb(payload)); },
});
