const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'lib:get', 'library:export', 'library:import', 'series:search', 'series:create', 'series:update', 'series:delete', 'series:refresh', 'series:ratings', 'series:discoverSources',
  'patterns:detect', 'episodes:addPattern', 'episodes:addList', 'episodes:addM3U', 'episodes:setSources', 'episodes:checkSources', 'episodes:delete', 'episodes:mark', 'episodes:rate',
  'episodes:skipTimes', 'player:play', 'player:playUrl', 'player:stop', 'player:preset', 'player:seekRelative', 'player:seekAbsolute', 'player:skipIntro', 'player:skipEnding', 'player:skipSegment', 'player:state',
  'settings:set', 'mpv:detect', 'mpv:browse', 'mpv:install', 'mpv:openGuide', 'presets:list', 'stats:get', 'app:version',
  'auth:state', 'auth:signUp', 'auth:signIn', 'auth:signOut', 'profile:get', 'profile:mine', 'profile:update',
  'favorites:list', 'favorites:set', 'friends:search', 'friends:requests', 'friends:request', 'friends:respond', 'friends:list', 'friends:remove',
  'watchRooms:create', 'watchRooms:join', 'watchRooms:subscribe', 'watchRooms:broadcast', 'watchRooms:unsubscribe', 'sync:run',
]);
const ON = new Set(['lib:changed', 'player:state', 'player:error', 'player:skip-offer', 'sync:state', 'watchRoom:playback', 'watchRoom:presence']);

contextBridge.exposeInMainWorld('animeApi', {
  invoke: (ch, ...args) => (INVOKE.has(ch) ? ipcRenderer.invoke(ch, ...args) : Promise.reject(new Error('canale non consentito: ' + ch))),
  on: (ch, cb) => { if (ON.has(ch)) ipcRenderer.on(ch, (_e, payload) => cb(payload)); },
});
