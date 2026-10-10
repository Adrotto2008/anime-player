'use strict';
const assert = require('assert');
const { titleKey, parseTitle, searchTitles, matchOptions, evaluateCandidate, candidateDiagnostics } = require('../src/source-match');
const { AnimeUnityClient, parseSearchRecords, selectExactMatch: unityMatch } = require('../src/animeunity');
const { AnimeWorldClient, selectExactMatch: worldMatch } = require('../src/animeworld');
const { providerTitles } = require('../src/source-state');

// Public AniList/provider names and metadata observed 2026-10-10. No media URLs.
const seasons = [
  [113415, 'Jujutsu Kaisen', 'Jujutsu Kaisen', 2020, 24],
  [145064, 'Jujutsu Kaisen 2nd Season', 'Jujutsu Kaisen 2', 2023, 23],
  [172463, 'Jujutsu Kaisen Season 3: The Culling Game Part 1', 'Jujutsu Kaisen 3', 2026, 12],
  [195604, 'Black Clover Season 2', 'Black Clover 2', 2026, null],
  [108632, 'Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season', 'Re:Zero kara Hajimeru Isekai Seikatsu 2', 2020, 13],
  [119661, 'Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season Part 2', 'Re:Zero kara Hajimeru Isekai Seikatsu 2 Part 2', 2021, 12],
  [189046, 'Re:Zero kara Hajimeru Isekai Seikatsu 4th Season', 'Re:Zero kara Hajimeru Isekai Seikatsu 4', 2026, 19],
];
function record(name, extra = {}) { return { id: 1, title: name, name, link: 'https://provider.test/play/1', dub: false, ...extra }; }
function matches(item, titles, options) {
  assert.strictEqual(unityMatch([item], titles, options), item);
  assert.strictEqual(worldMatch([item], titles, options), item);
}
function rejected(item, titles, options, reason) {
  assert.strictEqual(unityMatch([item], titles, options), null);
  assert.strictEqual(worldMatch([item], titles, options), null);
  if (reason) assert.ok(evaluateCandidate(item, titles, options).reasons.includes(reason), reason);
}

(async () => {
  assert.strictEqual(titleKey('Jujutsu Kaisen 2nd Season'), titleKey('Jujutsu Kaisen Season 2'));
  assert.notStrictEqual(titleKey('Jujutsu Kaisen 2'), titleKey('Jujutsu Kaisen'));
  assert.deepStrictEqual([parseTitle('Example Season 2 Part 2').season, parseTitle('Example Season 2 Part 2').part], [2, 2]);
  assert.strictEqual(parseTitle('Example 2nd Season 2nd Cour').part, 2);
  assert.ok(searchTitles(['Jujutsu Kaisen Season 3: The Culling Game Part 1']).includes('Jujutsu Kaisen 3'));
  assert.ok(searchTitles(['Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season']).includes('Re:Zero kara Hajimeru Isekai Seikatsu 2'));
  assert.ok(searchTitles(['Example'], { franchiseTitle: 'Related Franchise' }).includes('Related Franchise'));
  assert.strictEqual(matchOptions({ franchiseOrder: 4 }).seasonNumber, undefined, 'split-cour graph order is not a season number');

  for (const [anilistId, title, provider, year, episodeCount] of seasons) {
    const series = { anilistId, title, year, episodeCount, format: 'TV', status: episodeCount ? 'FINISHED' : 'RELEASING' };
    const options = matchOptions(series); const item = record(provider, { anilistId, year, episodeCount, format: 'TV' });
    for (const alias of providerTitles(series)) assert.ok(searchTitles(providerTitles(series)).some(query => query.toLowerCase() === alias.toLowerCase()), 'generated queries must not replace verified spellings');
    matches(item, [title], options);
    matches({ ...item, anilistId: null }, providerTitles(series), options);
    // The general rule also succeeds without the hand-maintained aliases.
    matches({ ...item, anilistId: null }, [title], options);
    rejected({ ...item, anilistId: anilistId + 1 }, [title], options, 'anilist_id_mismatch');
    rejected({ ...item, year: year - 1 }, [title], options, 'year_mismatch');
    for (const format of ['MOVIE', 'OVA', 'SPECIAL']) rejected({ ...item, format }, [title], options, 'format_mismatch');
    for (const suffix of [' Recap', ' Remake', " Director's Cut"]) rejected({ ...item, title: provider + suffix, name: provider + suffix, aliases: [title] }, [title], options, 'variant_mismatch');
    for (const select of [unityMatch, worldMatch]) {
      assert.strictEqual(select([item, { ...item, id: 2, link: 'other' }], [title], options), null);
      assert.strictEqual(select([{ ...item, id: 2, link: 'dub', dub: true }, item], [title], options), item);
    }
  }
  const options = { year: 2026, episodeCount: 12, format: 'TV' };
  const third = record('Example 3', { year: 2026, episodeCount: 12, format: 'TV' });
  matches(third, ['Example Season 3: Arc One Part 1'], options);
  rejected({ ...third, year: null }, ['Example Season 3: Arc One Part 1'], options, 'insufficient_metadata');
  rejected({ ...third, episodeCount: null }, ['Example Season 3: Arc One'], options, 'insufficient_metadata');
  rejected({ ...third, title: 'Example 3: Arc Two', name: 'Example 3: Arc Two' }, ['Example Season 3: Arc One', 'Example Season 3'], options, 'subtitle_mismatch');
  rejected(third, ['Example Season 3 Part 2', 'Example Season 3'], options, 'part_mismatch');
  rejected({ ...third, title: 'Example 3 Part 2', name: 'Example 3 Part 2', aliases: ['Example Season 3'] }, ['Example Season 3'], options, 'part_mismatch');
  rejected(record('Example', { aliases: ['Generic'] }), ['Example Season 2', 'Generic'], options, 'season_missing');
  rejected(record('Example 2', { aliases: ['Example'] }), ['Example'], {}, 'season_mismatch');
  rejected(record('Example Season 2', { aliases: ['Example Season 3'] }), ['Example Season 2'], {}, 'conflicting_title_metadata');
  rejected(record('Example Season 2'), ['Example Season 2', 'Example Season 3'], {}, 'conflicting_title_metadata');
  rejected(record('Mob Psycho 100 III'), ['Mob Psycho 100'], {});
  rejected(record('86'), ['86 Season 2'], options);
  matches(record('作品の名前'), ['English Title', '作品の名前'], {});
  matches(record('Different Translation', { anilistId: 123 }), ['作品の名前'], { anilistId: 123 });
  rejected(record('Different Translation', { anilistId: 123, malId: 456 }), ['作品の名前'], { anilistId: 123, malId: 789 }, 'mal_id_mismatch');
  rejected(record('Example', { year: 1999 }), ['Example'], { year: 2026 }, 'year_mismatch');
  rejected(record('Example', { episodeCount: 6 }), ['Example'], { episodeCount: 12, status: 'FINISHED' }, 'episode_count_mismatch');
  matches(record('Example', { episodeCount: 6 }), ['Example'], { episodeCount: 12, status: 'RELEASING' });
  const parsed = parseSearchRecords({ records: [{ id: 1, slug: 'example', title_eng: 'Example', anilist_id: 123, mal_id: 456, type: 'TV', status: 'Terminato' }] }, 'https://provider.test');
  assert.strictEqual(parsed[0].anilistId, 123); assert.strictEqual(parsed[0].format, 'TV');
  const diag = candidateDiagnostics([third], ['Example Season 3'], options, third)[0];
  assert.ok(diag.selected); assert.deepStrictEqual(diag.reasons, []); assert.ok(diag.evidence.includes('structured_title'));

  for (const Client of [AnimeUnityClient, AnimeWorldClient]) {
    const client = new Client(); const queries = []; let resolved = 0;
    client.search = async query => { queries.push(query); return query === 'Jujutsu Kaisen 3' ? [record('Jujutsu Kaisen 3', { anilistId: 172463, year: 2026, episodeCount: 12 })] : []; };
    client.searchCatalogue = async () => [];
    client.getEpisodeSources = client._episodeSources = async () => { resolved++; return [{ number: 1, url: 'https://media.test/1.mp4', resolutionState: 'resolved' }]; };
    assert.strictEqual((await client.findSources({ titles: [seasons[2][1]], anilistId: 172463, ...options })).length, 1);
    assert.ok(queries.includes('Jujutsu Kaisen 3')); assert.strictEqual(resolved, 1);
    assert.strictEqual(client.lastDiscovery.status, 'found');
    client.search = async () => [record('Example Season 2', { anilistId: 999 })];
    await client.findSources({ titles: ['Example Season 2'], anilistId: 123 });
    assert.strictEqual(client.lastDiscovery.status, 'title_rejected'); assert.strictEqual(resolved, 1);
    client.search = async () => [];
    await client.findSources({ titles: ['Absent'] });
    assert.strictEqual(client.lastDiscovery.status, 'title_not_found');
    client.search = async () => [record('Example')];
    client.getEpisodeSources = client._episodeSources = async () => [];
    await client.findSources({ titles: ['Example'] });
    assert.strictEqual(client.lastDiscovery.status, 'episodes_not_found');
    client.getEpisodeSources = client._episodeSources = async () => { client.lastDiscovery.requestedEpisodesFound = 1; return []; };
    await client.findSources({ titles: ['Example'] });
    assert.strictEqual(client.lastDiscovery.status, 'media_unresolved');
  }
  // Catalogue retrieval must finish before selection; later aliases can reveal ambiguity.
  const world = new AnimeWorldClient();
  world.search = async () => [];
  world.searchCatalogue = async title => [record(title, { link: title })];
  world._episodeSources = async () => { throw new Error('Must not resolve an ambiguous title'); };
  assert.deepStrictEqual(await world.findSources({ titles: ['Translation One', 'Translation Two'] }), []);
  assert.strictEqual(world.lastDiscovery.status, 'title_rejected');
  assert.ok(world.lastDiscovery.candidates.every(item => item.reasons.includes('ambiguous')));
  console.log('Season matching: seven required seasons on both matchers, IDs, structured fallback, variants, parts, arcs, ambiguity, query generation and discovery states passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
