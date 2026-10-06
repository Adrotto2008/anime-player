const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'lib:get', 'library:export', 'library:import', 'series:search', 'series:create', 'series:update', 'series:delete', 'series:refresh', 'series:ratings',
  'patterns:detect', 'episodes:addPattern', 'episodes:addList', 'episodes:addM3U', 'episodes:setSources', 'episodes:delete', 'episodes:mark',
  'player:play', 'player:playUrl', 'player:stop', 'player:preset', 'player:state',
  'settings:set', 'mpv:detect', 'mpv:browse', 'presets:list', 'stats:get',
]);
const ON = new Set(['lib:changed', 'player:state', 'player:error']);

contextBridge.exposeInMainWorld('animeApi', {
  invoke: (ch, ...args) => (INVOKE.has(ch) ? ipcRenderer.invoke(ch, ...args) : Promise.reject(new Error('canale non consentito: ' + ch))),
  on: (ch, cb) => { if (ON.has(ch)) ipcRenderer.on(ch, (_e, payload) => cb(payload)); },
});
