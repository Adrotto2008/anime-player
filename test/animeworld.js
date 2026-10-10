'use strict';

const assert = require('assert');
const { AnimeWorldClient, titleKey, selectExactMatch } = require('../src/animeworld');

function response({ status = 200, body = '', cookies = [] } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { getSetCookie: () => cookies, get: () => null },
    text: async () => String(body),
    json: async () => typeof body === 'string' ? JSON.parse(body) : body,
  };
}

async function main() {
  assert.strictEqual(titleKey('Solo Leveling (ITA)'), 'solo leveling');
  assert.strictEqual(titleKey('Jujutsu Kaisen 2nd Season'), 'jujutsu kaisen season 2');
  const exact = selectExactMatch([
    { name: 'Solo Leveling (ITA)', year: 2024, episodes: 12, dub: true, link: 'ita' },
    { name: 'Solo Leveling', year: 2024, episodes: 12, dub: false, link: 'sub' },
    { name: 'Solo Leveling', year: 2025, episodes: 13, dub: false, link: 'wrong-year' },
  ], ['Solo Leveling'], { year: 2024, episodeCount: 12 });
  assert.strictEqual(exact.link, 'sub');
  assert.strictEqual(selectExactMatch([{ name: 'Mob Psycho 100 III' }], ['Mob Psycho 100']), null);
  assert.strictEqual(selectExactMatch([{ name: "L'attacco dei Giganti (ITA)", altTitle: 'Shingeki no Kyojin (ITA)', link: 'correct' },
    { name: "L'attacco dei Giganti 2", altTitle: 'Shingeki no Kyojin Season 2', link: 'wrong-season' }], ['Shingeki no Kyojin']).link, 'correct');

  const requests = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url); requests.push({ url: parsed, options });
    if (parsed.pathname === '/') {
      return response({ body: '<meta id="csrf-token" content="token-test">', cookies: ['sessionId=session-test; Path=/; HttpOnly'] });
    }
    if (parsed.pathname === '/api/search/v2') {
      return response({ body: { animes: [{ name: 'Demo Show', jtitle: 'Demo Original', choseTitle: 'Demo Alias', year: '2024', episodes: '2', dub: '0', link: 'demo-show', identifier: 'abc123', anilistId: 123, malId: 456, animeTypeName: 'OVA', stateName: 'Finito' }] } });
    }
    if (parsed.pathname === '/play/demo-show.abc123') {
      return response({ body: `
        <div class="tabs servers-tabs">
          <span class="tab server-tab active" data-name="9"></span>
          <span class="tab server-tab" data-name="10"></span>
        </div>
        <div class="server active" data-name="9"><ul>
          <li class="episode"><a data-episode-id="e1" data-id="a1" data-episode-num="1"></a></li>
          <li class="episode"><a data-episode-id="e2" data-id="a2" data-episode-num="2"></a></li>
        </ul></div>
        <div class="server" data-name="10"><ul>
          <li class="episode"><a data-episode-id="e1" data-id="b1" data-episode-num="1"></a></li>
        </ul></div>` });
    }
    if (parsed.pathname === '/api/episode/info') {
      const id = parsed.searchParams.get('id');
      return response({ body: { grabber: `https://video.example/${id}.m3u8` } });
    }
    throw new Error(`Unexpected AnimeWorld request: ${parsed.href}`);
  };
  const client = new AnimeWorldClient({ fetchImpl, baseUrl: 'https://animeworld.test', concurrency: 2 });
  const mapped = await client.search('Demo Original');
  assert.strictEqual(mapped[0].altTitle, 'Demo Original');
  assert.strictEqual(mapped[0].anilistId, 123); assert.strictEqual(mapped[0].malId, 456);
  assert.strictEqual(mapped[0].format, 'OVA'); assert.strictEqual(mapped[0].status, 'Finito');
  assert.deepStrictEqual(mapped[0].aliases, ['Demo Alias']);
  const sources = await client.findSources({ titles: ['Demo Show'], year: 2024, episodeCount: 2 });
  assert.deepStrictEqual(sources.map((item) => item.number).sort(), [1, 1, 2]);
  assert.ok(sources.some((item) => item.url === 'https://video.example/a2.m3u8'));
  const search = requests.find((item) => item.url.pathname === '/api/search/v2');
  assert.strictEqual(search.options.method, 'POST');
  assert.strictEqual(search.options.headers['csrf-token'], 'token-test');
  assert.match(search.options.headers.Cookie, /sessionId=session-test/);
  const partialSearch = new AnimeWorldClient();
  partialSearch.searchCatalogue = async () => [];
  partialSearch.search = async (title) => { if (title === 'Broken alias') throw new Error('Temporary search error'); return [{ name: 'Demo Show', link: 'match' }]; };
  partialSearch._episodeSources = async () => [{ number: 1, url: 'https://video.test/one.mp4' }];
  assert.strictEqual((await partialSearch.findSources({ titles: ['Demo Show', 'Broken alias'] })).length, 1, 'a failing alias cannot discard an exact result from another query');
  console.log('  ok AnimeWorld exact matching, session/CSRF, episode parsing and source fallback');
}

main().catch((error) => { console.error('AnimeWorld tests failed:', error); process.exitCode = 1; });
