import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpClient, UrlPolicy } from '../../src/source-engine/http.mjs';

export async function tempDirectory(prefix = 'test') {
  const root = path.resolve('work');
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, prefix + '-'));
}
export async function localServer(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: 'http://127.0.0.1:' + server.address().port,
    close: async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); } };
}
export function localClient(extra = {}) {
  return new HttpClient({ policy: new UrlPolicy({ allowLocal: true }), delay: async () => {}, random: () => 0, ...extra });
}
export const work = { provider: 'test', providerId: 'w1', title: 'Example', format: 'TV', year: 2020,
  episodes: 12, audio: 'ja', ids: { mal: 100 } };
export function unit(number, id = number) {
  return { provider: 'test', workId: 'w1', id, number: String(number) };
}
