import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { invariant, safeError } from './errors.mjs';

// mpv receives only a private local URL. All upstream redirects/DNS/headers
// remain under the same validated HTTP client used by the resolver.
export async function mediaProxy(client, source, { signal } = {}) {
  const route = '/' + randomUUID(), streams = new Set(), failures = [];
  const server = http.createServer(async (req, res) => {
    let upstream;
    try {
      invariant(req.url === route && ['GET', 'HEAD'].includes(req.method), 'proxy_request_rejected');
      const headers = { ...source.headers };
      if (req.headers.range) {
        invariant(/^bytes=\d+-\d*$/.test(req.headers.range), 'proxy_range_rejected');
        headers.Range = req.headers.range;
      }
      upstream = await client.open(source.url, { method: req.method, headers, signal, requestTimeoutMs: 30 * 60 * 1000,
        allowStatuses: [416] });
      streams.add(upstream);
      const selected = Object.fromEntries(Object.entries(upstream.headers).filter(([k]) =>
        ['content-type', 'content-length', 'content-range', 'accept-ranges'].includes(k)));
      invariant(!/text\/html|application\/json/i.test(selected['content-type'] || ''), 'not_media');
      res.writeHead(upstream.statusCode, selected);
      res.once('close', () => upstream?.destroy());
      for await (const b of upstream) {
        if (!res.write(b)) await new Promise(resolve => {
          const done=()=>{res.removeListener('drain',done);res.removeListener('close',done);resolve();};
          res.once('drain',done);res.once('close',done);
        });
        if (res.destroyed) break;
      }
      res.end();
    } catch (e) {
      failures.push(safeError(e)); if (failures.length > 50) failures.shift();
      if (!res.headersSent) res.writeHead(502); res.destroy();
    } finally { upstream?.destroy(); streams.delete(upstream); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: 'http://127.0.0.1:' + server.address().port + route,
    stats: () => ({ failures }), close: async () => {
      for (const s of streams) s.destroy(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    } };
}
