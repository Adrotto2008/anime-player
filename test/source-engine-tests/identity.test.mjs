import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCandidate, chooseCandidate, chooseUnit, normalizeTitle, parseEpisodeLabel, formatOf } from '../../src/source-engine/identity.mjs';
import { work, unit } from './helpers.mjs';

for (const f of ['TV', 'TV_SHORT', 'MOVIE', 'OVA', 'ONA', 'SPECIAL']) {
  test('exact independent identity: ' + f, () => {
    const t = { ...work, format: f };
    assert.equal(chooseCandidate(t, [{ ...t }]).status, 'matched');
  });
}
for (const [field, changed, code] of [
  ['format', 'MOVIE', 'format_conflict'], ['year', 2021, 'year_conflict'],
  ['audio', 'it', 'audio_conflict'], ['episodes', 11, 'episode_count_conflict'],
  ['ids', { mal: 999 }, 'mal_id_conflict'], ['title', 'Example Recap', 'edition_conflict'],
  ['title', 'Example Part 2', 'part_unproven'], ['title', 'Example 2', 'season_unproven'],
]) {
  test('reject conflicting ' + field + ': ' + code, () => {
    const a = assessCandidate({ ...work, ids: {} }, { ...work, ids: {}, [field]: changed });
    if (field === 'ids') assert(assessCandidate(work, { ...work, ids: changed }).reasons.includes(code));
    else assert(a.reasons.includes(code), JSON.stringify(a.reasons));
    assert.notEqual(chooseCandidate(work, [{ ...work, [field]: changed }]).status, 'matched');
  });
}
test('matching ID cannot turn a different title into an accepted work', () => {
  assert.notEqual(chooseCandidate(work, [{ ...work, title: 'Completely unrelated' }]).status, 'matched');
});
test('equivalent 2nd Season vs 2 spelling requires a common catalogue ID', () => {
  const t = { ...work, title: 'Example 2nd Season Part 2' }, c = { ...work, title: 'Example 2 Part 2' };
  assert.equal(chooseCandidate(t, [c]).status, 'matched');
  assert.notEqual(chooseCandidate({ ...t, ids: {} }, [{ ...c, ids: {} }]).status, 'matched');
  assert.notEqual(chooseCandidate(t, [{ ...c, title: 'Example 2 Part 1' }]).status, 'matched');
  assert.notEqual(chooseCandidate(t, [{ ...c, title: 'Example Subtitle 2 Part 2' }]).status, 'matched');
});
test('an exact weak title does not provide enough evidence', () => {
  assert.equal(chooseCandidate({ title: 'Example' }, [{ provider: 'test', providerId: '1', title: 'Example' }]).status, 'review_required');
});
test('fallback without a catalogue ID needs title, format, year and count together', () => {
  const target = { ...work, ids: {} }, candidate = { ...work, ids: {} };
  assert.equal(chooseCandidate(target, [candidate]).status, 'matched');
  assert.equal(chooseCandidate(target, [{ ...candidate, episodes: null }]).status, 'review_required');
});
test('unverified alias and search query cannot authorise a match', () => {
  const t = { ...work, title: 'Other', aliases: ['Example'], searchQueries: ['Example'] };
  assert.notEqual(chooseCandidate(t, [work]).status, 'matched');
});
test('verified alias with provenance is permitted', () => {
  const t = { ...work, title: 'Other', aliases: [{ title: 'Example', verified: true, source: 'catalog:100' }] };
  assert.equal(chooseCandidate(t, [work]).status, 'matched');
});
test('a generic alternative title cannot hide a recap edition', () => {
  const c = { ...work, title: 'Example Recap', titles: ['Example'] };
  assert.equal(chooseCandidate(work, [c]).status, 'title_rejected');
});
test('two editions are ambiguous; ordering never settles it', () => {
  const editions = [work, { ...work, providerId: 'w2' }];
  assert.equal(chooseCandidate(work, editions).status, 'ambiguous');
  assert.equal(chooseCandidate(work, editions.reverse()).status, 'ambiguous');
});
test('contradictory AniList and MAL IDs reject shared bundled OVA ID', () => {
  const t = { ...work, title: 'Memory Snow', ids: { anilist: 100049, mal: 36286 }, format: 'OVA', year: 2018 };
  const c = { ...t, title: 'The Frozen Bond', ids: { anilist: 100049, mal: 38414 }, year: 2019 };
  const a = assessCandidate(t, c);
  assert(a.reasons.includes('mal_id_conflict')); assert(a.reasons.includes('year_conflict'));
  assert.equal(a.decision, 'rejected');
});
test('no broad punctuation removal of sequel numbers or beta', () => {
  assert.notEqual(normalizeTitle('Steins;Gate 0'), normalizeTitle('Steins;Gate'));
  assert.notEqual(normalizeTitle('Episode 23β'), normalizeTitle('Episode 23'));
  assert.notEqual(normalizeTitle('Example Part 2'), normalizeTitle('Example'));
  assert.equal(normalizeTitle('Ｅｘａｍｐｌｅ (ITA)'), 'example');
  assert.equal(formatOf('TV Short'), 'TV_SHORT');
});
test('duplicated provider ID with differing metadata is a schema failure', () => {
  assert.throws(() => chooseCandidate(work, [work, { ...work, year: 2021 }]), { code: 'conflicting_provider_record' });
});
test('duplicate copy of the same record is deduplicated', () => {
  assert.equal(chooseCandidate(work, [work, { ...work }]).status, 'matched');
});
test('decimal, zero and range labels preserve content boundaries', () => {
  const units = [unit('0'), unit('5'), unit('5.5'), unit('268-269'), unit('23β')];
  assert.equal(chooseUnit(work, { number: '5.50' }, units).selected.id, '5.5');
  assert.equal(chooseUnit(work, { number: '0' }, units).selected.id, '0');
  assert.equal(chooseUnit(work, { number: '268' }, units).status, 'episode_missing');
  assert.equal(chooseUnit(work, { number: '268-269' }, units).selected.id, '268-269');
  assert.equal(chooseUnit(work, { number: '23' }, units).status, 'episode_missing');
  assert.equal(parseEpisodeLabel('01.00').value, '1');
});
test('episodes 1 and 10, and two cour episode 1s, never collide', () => {
  assert.equal(chooseUnit(work, { number: 1 }, [unit(1), unit(10)]).selected.number, '1');
  assert.equal(chooseUnit(work, { number: 1 }, [unit(1, 'a'), unit(1, 'b')]).status, 'unit_ambiguous');
});
test('foreign work unit is excluded even when the episode number matches', () => {
  assert.equal(chooseUnit(work, { number: 1 }, [{ ...unit(1), workId: 'other' }]).status, 'episode_missing');
});
test('single OVA is a media part; a bundle of two cannot be collapsed', () => {
  const t = { ...work, format: 'OVA', episodes: 1 };
  assert.equal(chooseUnit(t, { single: true }, [unit(1)]).selected.kind, 'media_part');
  assert.equal(chooseUnit({ ...t, episodes: 2 }, { single: true }, [unit(1), unit(2)]).status, 'unit_review_required');
  assert.equal(chooseUnit(work, { single: true }, [unit(1)]).status, 'unit_review_required');
});
test('opaque labels require an exact opaque label or ID', () => {
  assert.equal(chooseUnit(work, { number: 3 }, [unit('Special')]).status, 'episode_missing');
  assert.equal(chooseUnit(work, { number: 'Special' }, [unit('Special')]).status, 'unit_matched');
  assert.equal(chooseUnit(work, { number: '' }, [unit('')]).status, 'episode_missing');
});
test('adversarial permutation matrix: 1000 conflicting identities remain rejected', () => {
  for (let i = 0; i < 1000; i++) {
    const target = { ...work, title: 'Series ' + i, ids: { mal: i + 1, anilist: i + 2000 } };
    const wrong = { ...target, providerId: 'wrong', ids: { mal: i + 2, anilist: i + 2000 } };
    const result = chooseCandidate(target, i % 2 ? [wrong, target] : [target, wrong]);
    assert.equal(result.status, 'matched'); assert.equal(result.selected.providerId, 'w1');
    assert.equal(chooseCandidate(target, [wrong]).status, 'title_rejected');
  }
});
