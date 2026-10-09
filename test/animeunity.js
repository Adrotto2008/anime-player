'use strict';

const assert = require('assert');
const { AnimeUnityClient, selectExactMatch, extractUrl } = require('../src/animeunity');

function response(body, { status = 200, headers = {} } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (name) => headers[name.toLowerCase()] || null, getSetCookie: () => headers['set-cookie'] ? [headers['set-cookie']] : [] },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

async function main() {
  const calls = [];
  const direct = new Map([[501, 'https://media.example/video-1.m3u8'], [502, 'https://media.example/video-2.m3u8'], [503, 'https://media.example/video-3.m3u8']]);
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ url: parsed.toString(), options });
    if (parsed.pathname === '/') return response('<meta name="csrf-token" content="token123">', { headers: { 'set-cookie': 'sessionid=abc; Path=/' } });
    if (parsed.pathname === '/livesearch') {
      assert.strictEqual(options.method, 'POST');
      assert.strictEqual(options.headers['X-CSRF-TOKEN'], 'token123');
      assert.match(options.headers.Cookie, /sessionid=abc/);
      return response({ records: [{ id: 22, title: 'Yuru Yuri', title_eng: 'Yuru Yuri', slug: 'yuru-yuri', date: '2011', episodes_count: 12 }] });
    }
    if (parsed.pathname === '/info_api/22-yuru-yuri') return response({ episodes_count: 3 });
    if (parsed.pathname === '/info_api/22-yuru-yuri/0') return response([
      { id: 503, number: '3' }, { id: 501, number: '1' }, { id: 502, number: '2' },
    ]);
    if (/^\/embed-url\//.test(parsed.pathname)) {
      const id = Number(parsed.pathname.split('/').pop());
      return response(`https://player.example/embed/${id}?token=signature`);
    }
    if (parsed.hostname === 'player.example') {
      const id = Number(parsed.pathname.split('/').pop());
      return response(`<script src="https://analytics.example/script.js"></script><script>window.downloadUrl = "${direct.get(id)}";</script>`);
    }
    throw new Error(`Richiesta inattesa: ${url}`);
  };

  assert.strictEqual(selectExactMatch([
    { id: 1, title: 'Yuru Yuri', year: 2011, episodeCount: 12 },
    { id: 2, title: 'Yuru Yuri', year: 2015, episodeCount: 12 },
  ], ['Yuru Yuri'], { year: 2011, episodeCount: 12 }).id, 1);
  assert.strictEqual(selectExactMatch([
    { id: 1, title: 'Yuru Yuri' }, { id: 2, title: 'Yuru Yuri' },
  ], ['Yuru Yuri']), null, 'matching ambiguo non sceglie un risultato arbitrariamente');
  assert.strictEqual(selectExactMatch([{ id: 1, title: 'Yuru Yuri', year: 2015, episodeCount: 12 }], ['Yuru Yuri'], { year: 2011, episodeCount: 12 }), null, 'anno incompatibile non viene accettato come match');
  assert.strictEqual(extractUrl('<script>window.downloadUrl="javascript:alert(1)"</script>', 'https://x.example'), null);

  const client = new AnimeUnityClient({ fetchImpl, baseUrl: 'https://animeunity.test', concurrency: 2 });
  const found = await client.findSources({ titles: ['Yuru Yuri'], year: 2011, episodeCount: 12 });
  assert.deepStrictEqual(found.map((item) => item.number), [1, 2, 3], 'usa numeri reali e ordina i risultati anche quando l’API li restituisce fuori ordine');
  assert.deepStrictEqual(found.map((item) => item.url), [...direct.values()], 'risolve separatamente gli URL diretti per ogni ID episodio');
  assert.strictEqual(new Set(found.map((item) => item.url)).size, 3, 'episodi consecutivi non condividono lo stesso URL');
  assert.ok(found.every((item) => item.provider === 'animeunity' && item.referer.startsWith('https://player.example/')));
  assert.deepStrictEqual(calls.filter((call) => call.url.includes('/embed-url/')).map((call) => call.url.split('/').pop()).sort(), ['501', '502', '503']);
  console.log('AnimeUnity: matching, CSRF/sessione, tre episodi mappati a URL distinti e riferimenti per sorgente verificati con risposte simulate.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
