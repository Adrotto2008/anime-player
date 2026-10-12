import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { inspectHls, parseHls } from './hls.mjs';
import { mediaProxy } from './file-proxy.mjs';
import { invariant, safeError } from './errors.mjs';

const quoted = value => String(value || '').replace(/["\r\n\\]/g, '');

export async function playbackProxy(client, source, { signal, audio, subtitles, maxHeight } = {}) {
  invariant(source.state === 'http_media_verified', 'source_not_verified');
  if (source.type === 'file') return mediaProxy(client, source, { signal, maxRequests: 10000 });
  const plan = await inspectHls(client, source, { signal, audio, subtitles, maxHeight });
  const routes = new Map(), byUrl = new Map(), streams = new Set(), failures = [];
  function route(uri) {
    if (!byUrl.has(uri)) {
      const id = randomUUID(); routes.set('/item/' + id, uri); byUrl.set(uri, '/item/' + id);
    }
    return byUrl.get(uri);
  }
  const master = ['#EXTM3U', '#EXT-X-VERSION:7'];
  for (const [type, list] of [['AUDIO', plan.audio], ['SUBTITLES', plan.subtitles]]) {
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      master.push('#EXT-X-MEDIA:TYPE=' + type + ',GROUP-ID="' + type.toLowerCase() + '",NAME="'
        + quoted(t.name) + '",LANGUAGE="' + quoted(t.language || 'und') + '",DEFAULT=' + (i === 0 ? 'YES' : 'NO')
        + ',AUTOSELECT=YES,URI="' + route(t.uri) + '"');
    }
  }
  if (plan.master) {
    const v = plan.variant;
    master.push('#EXT-X-STREAM-INF:BANDWIDTH=' + Math.max(1, v.bandwidth || 1)
      + (v.width && v.height ? ',RESOLUTION=' + v.width + 'x' + v.height : '')
      + (v.codecs ? ',CODECS="' + quoted(v.codecs) + '"' : '')
      + (plan.audio.length ? ',AUDIO="audio"' : '') + (plan.subtitles.length ? ',SUBTITLES="subtitles"' : ''),
      route(plan.media.url));
  }
  const initial = plan.master ? '/master.m3u8' : route(plan.media.url);
  const server = http.createServer(async (req, res) => {
    let upstream;
    try {
      invariant(['GET', 'HEAD'].includes(req.method), 'proxy_request_rejected');
      if (req.url === '/master.m3u8' && plan.master) {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); res.end(master.join('\n') + '\n'); return;
      }
      const remote = routes.get(req.url); invariant(remote, 'proxy_request_rejected');
      const headers = { ...source.headers };
      if (req.headers.range) {
        invariant(/^bytes=\d+-\d*$/.test(req.headers.range), 'proxy_range_rejected');
        headers.Range = req.headers.range;
      }
      upstream = await client.open(remote, { method: req.method, headers, signal, requestTimeoutMs: 30 * 60 * 1000 });
      invariant([200, 206].includes(upstream.statusCode), 'playback_source_failed', { status: upstream.statusCode });
      streams.add(upstream); res.once('close', () => upstream.destroy());
      const outgoing = Object.fromEntries(Object.entries(upstream.headers).filter(([k]) =>
        ['content-type', 'content-length', 'content-range', 'accept-ranges'].includes(k)));
      let first = true, playlistChunks = [], isPlaylist = false, playlistBytes = 0;
      for await (const b of upstream) {
        if (first) {
          first = false;
          isPlaylist = b.subarray(0, 64).toString('utf8').replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U')
            || /mpegurl/i.test(upstream.headers['content-type'] || '');
          if (!isPlaylist) res.writeHead(upstream.statusCode, outgoing);
        }
        if (isPlaylist) {
          playlistBytes += b.length; invariant(playlistBytes <= 4 * 1024 ** 2, 'response_too_large');
          playlistChunks.push(b);
        } else {
          if (!res.write(b)) await new Promise(resolve => {
            const done = () => { res.removeListener('drain', done); res.removeListener('close', done); resolve(); };
            res.once('drain', done); res.once('close', done);
          });
          if (res.destroyed) break;
        }
      }
      if (isPlaylist) {
        const text = Buffer.concat(playlistChunks).toString('utf8');
        parseHls(text, upstream.finalUrl);
        const rewritten = text.split(/\r?\n/).map(line => {
          const l = line.trim();
          if (l && !l.startsWith('#')) return route(new URL(l, upstream.finalUrl).href);
          return line.replace(/URI="([^"]+)"/g, (_all, uri) =>
            'URI="' + route(new URL(uri, upstream.finalUrl).href) + '"');
        }).join('\n');
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); res.end(rewritten);
      } else res.end();
    } catch (e) {
      failures.push({ ...safeError(e), httpStatus: e.details?.status || null });
      if (!res.headersSent) res.writeHead(502); res.destroy();
    } finally { if (upstream) { upstream.destroy(); streams.delete(upstream); } }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: 'http://127.0.0.1:' + server.address().port + initial,
    stats: () => ({ routes: routes.size, failures }),
    close: async () => {
      for (const s of streams) s.destroy();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    } };
}
