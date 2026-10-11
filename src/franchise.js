'use strict';

const SEASON_FORMATS = new Set(['TV', 'TV_SHORT', 'ONA']);
const MOVIE_RELATIONS = new Set(['PREQUEL', 'SEQUEL', 'SIDE_STORY']);

function relationNodes(media) {
  return (media?.related || []).filter((item) => item?.id && item.type === 'ANIME');
}

// PREQUEL/SEQUEL describes story chronology, not necessarily another season.
// A known one-shot must not become the root of a series (including ONA releases).
function isSeason(media) {
  return SEASON_FORMATS.has(media?.format) && Number(media.episodeCount) !== 1;
}

function orderSeasons(mains) {
  if (!mains.length || mains.some((media) => media.anilistId == null)) return null;
  const byId = new Map(mains.map((media) => [String(media.anilistId), media]));
  const incoming = new Map(); const outgoing = new Map();
  for (const media of mains) for (const rel of relationNodes(media)) {
    if(['SPIN_OFF','SUMMARY','ALTERNATIVE','ALTERNATIVE_VERSION'].includes(rel.relation) && byId.has(String(rel.id)))return null;
    if (!['PREQUEL', 'SEQUEL'].includes(rel.relation) || !byId.has(String(rel.id))) continue;
    const from = String(rel.relation === 'PREQUEL' ? rel.id : media.anilistId);
    const to = String(rel.relation === 'PREQUEL' ? media.anilistId : rel.id);
    if (!outgoing.has(from)) outgoing.set(from, new Set());
    if (!incoming.has(to)) incoming.set(to, new Set());
    outgoing.get(from).add(to); incoming.get(to).add(from);
  }
  if ([...incoming.values(), ...outgoing.values()].some((ids) => ids.size > 1)) return null;
  const roots = mains.filter((media) => !incoming.has(String(media.anilistId)));
  if (roots.length !== 1) return null;
  let current = String(roots[0].anilistId);
  const ordered = []; const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current); ordered.push(byId.get(current));
    current = [...(outgoing.get(current) || [])][0];
  }
  return !current && ordered.length === mains.length ? ordered : null;
}

/** Resolve only an unbranched PREQUEL/SEQUEL chain. Ambiguous graphs fall back to the seed. */
async function resolveFranchise(seedId, fetchByIds, { maxItems = 24 } = {}) {
  const seedKey = String(seedId);
  const visited = new Set();
  const mediaById = new Map();
  let frontier = [seedKey];
  let requests = 0;
  let incomplete = false;

  while (frontier.length && visited.size < maxItems && requests < maxItems) {
    const ids = frontier.filter((id) => !visited.has(String(id))).slice(0, maxItems - visited.size);
    if (!ids.length) break;
    ids.forEach((id) => visited.add(String(id)));
    const records = await fetchByIds(ids);
    requests++;
    for (const media of records || []) if (media?.anilistId != null) mediaById.set(String(media.anilistId), media);
    if (ids.some((id) => !mediaById.has(String(id)))) incomplete = true;
    const next = new Set();
    for (const media of records || []) {
      if (!isSeason(media)) continue;
      for (const item of relationNodes(media)) {
        if (SEASON_FORMATS.has(item.format) && ['PREQUEL', 'SEQUEL'].includes(item.relation) && !visited.has(String(item.id))) next.add(String(item.id));
      }
    }
    frontier = [...next];
  }

  const seed = mediaById.get(seedKey);
  if (!seed) throw new Error('Opera AniList iniziale non trovata.');
  if (!isSeason(seed)) return { seed, items: [seed], movies: [], ambiguous: false, requests };
  const ordered = orderSeasons([...mediaById.values()].filter(isSeason));
  // Disconnected or cyclic relations are not enough evidence to group.
  if (!ordered || incomplete || frontier.length || !ordered.some((item) => String(item.anilistId) === seedKey)) {
    return { seed, items: [seed], movies: [], ambiguous: true, requests };
  }

  const movieIds = new Set();
  const weakMovies=new Set();
  for (const media of ordered) for (const rel of relationNodes(media)) {
    if (rel.format === 'MOVIE' && MOVIE_RELATIONS.has(rel.relation)) movieIds.add(String(rel.id));
    if(rel.format === 'MOVIE' && ['SPIN_OFF','ALTERNATIVE','ALTERNATIVE_VERSION','SUMMARY'].includes(rel.relation))weakMovies.add(String(rel.id));
  }
  for(const id of weakMovies)movieIds.delete(id);
  const unresolvedMovies = [...movieIds].filter((id) => !mediaById.has(id)).slice(0, Math.max(0, maxItems - mediaById.size));
  if (unresolvedMovies.length && requests < maxItems) {
    const movieRecords = await fetchByIds(unresolvedMovies); requests++;
    for (const media of movieRecords || []) if (media?.anilistId != null && media.format === 'MOVIE') mediaById.set(String(media.anilistId), media);
  }
  const movies = [...movieIds].map((id) => mediaById.get(id)).filter((item) => item?.format === 'MOVIE')
    .sort((a, b) => (Number(a.year) || 0) - (Number(b.year) || 0) || String(a.title).localeCompare(String(b.title)));
  return { seed, items: ordered, movies, ambiguous: false, requests };
}

function applyFranchiseMetadata(records, { franchiseId, franchiseTitle, items }) {
  const seasonNumberById = new Map(items.map((item, index) => [String(item.anilistId), index + 1]));
  return records.map((record) => {
    const number = seasonNumberById.get(String(record.anilistId));
    const explicitSeason = String(record.title || '').match(/season\s*(\d+)|(\d+)(?:st|nd|rd|th)\s*season|\bS(\d+)\b/i);
    const chartSeason = explicitSeason ? Number(explicitSeason.slice(1).find(Boolean)) : null;
    return {
      ...record,
      franchiseId: String(franchiseId), franchiseTitle,
      franchiseOrder: number || null,
      franchiseType: record.category || (record.format === 'MOVIE' ? 'movie' : ['SPECIAL', 'OVA'].includes(record.format) ? 'special' : 'season'),
      ...(number ? { franchiseSeasonNumber: chartSeason } : {}),
    };
  });
}

function planFranchiseAddition(mediaRecords, libraryRecords) {
  const existingById = new Map((libraryRecords || []).filter((item) => item.anilistId != null).map((item) => [String(item.anilistId), item]));
  const seen = new Set(); const plan = [];
  for (const media of mediaRecords || []) {
    if (media?.anilistId == null) continue;
    const id = String(media.anilistId);
    if (seen.has(id)) continue;
    seen.add(id);
    plan.push({ media, existing: existingById.get(id) || null });
  }
  return plan;
}

// Repair only the old automatic one-shot-root mistake, with saved relation
// evidence and an unambiguous remaining season chain. Never delete a record.
function legacyFranchiseRepairs(records) {
  const groups = new Map(); const repairs = [];
  for (const record of records || []) if (record?.franchiseId) {
    const key = String(record.franchiseId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  for (const [key, members] of groups) {
    if (members.some(record=>record.franchiseMembership?.manual)) continue;
    const root = members.find((record) => String(record.anilistId) === key);
    if (!root || root.franchiseType !== 'season' || !SEASON_FORMATS.has(root.format) || Number(root.episodeCount) !== 1) continue;
    const ordered = orderSeasons(members.filter(isSeason));
    if (!ordered) continue;
    const first = ordered[0];
    const linked = relationNodes(root).some((rel) => rel.relation === 'SEQUEL' && String(rel.id) === String(first.anilistId))
      || relationNodes(first).some((rel) => rel.relation === 'PREQUEL' && String(rel.id) === key);
    if (!linked) continue;
    const grouped = members.filter((record) => !SEASON_FORMATS.has(record.format) || isSeason(record));
    const metadata = applyFranchiseMetadata(grouped, { franchiseId: first.anilistId, franchiseTitle: first.title, items: ordered });
    for (const record of members) {
      const fixed = metadata.find((item) => item.id === record.id);
      const patch = Object.fromEntries(['franchiseId', 'franchiseTitle', 'franchiseOrder', 'franchiseType', 'franchiseSeasonNumber']
        .map((field) => [field, fixed ? fixed[field] ?? null : null]));
      repairs.push({ record, patch });
    }
  }
  return repairs;
}

module.exports = { resolveFranchise, applyFranchiseMetadata, planFranchiseAddition, legacyFranchiseRepairs, SEASON_FORMATS, MOVIE_RELATIONS };
