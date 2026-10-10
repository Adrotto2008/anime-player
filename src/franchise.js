'use strict';

const SEASON_FORMATS = new Set(['TV', 'TV_SHORT', 'ONA']);
const MOVIE_RELATIONS = new Set(['PREQUEL', 'SEQUEL', 'SIDE_STORY']);

function relationNodes(media) {
  return (media?.related || []).filter((item) => item?.id && item.type === 'ANIME');
}

/** Resolve only an unbranched PREQUEL/SEQUEL chain. Ambiguous graphs fall back to the seed. */
async function resolveFranchise(seedId, fetchByIds, { maxItems = 24 } = {}) {
  const seedKey = String(seedId);
  const visited = new Set();
  const mediaById = new Map();
  let frontier = [seedKey];
  let requests = 0;

  while (frontier.length && visited.size < maxItems && requests < maxItems) {
    const ids = frontier.filter((id) => !visited.has(String(id))).slice(0, maxItems - visited.size);
    if (!ids.length) break;
    ids.forEach((id) => visited.add(String(id)));
    const records = await fetchByIds(ids);
    requests++;
    for (const media of records || []) if (media?.anilistId != null) mediaById.set(String(media.anilistId), media);
    const next = new Set();
    for (const media of records || []) {
      for (const item of relationNodes(media)) {
        if (SEASON_FORMATS.has(item.format) && ['PREQUEL', 'SEQUEL'].includes(item.relation) && !visited.has(String(item.id))) next.add(String(item.id));
      }
    }
    frontier = [...next];
  }

  const seed = mediaById.get(seedKey);
  if (!seed) throw new Error('Opera AniList iniziale non trovata.');
  const mains = [...mediaById.values()].filter((item) => SEASON_FORMATS.has(item.format));
  if (!mains.some((item) => String(item.anilistId) === seedKey)) mains.push(seed);

  const edges = [];
  for (const media of mains) for (const rel of relationNodes(media)) {
    if (!['PREQUEL', 'SEQUEL'].includes(rel.relation) || !SEASON_FORMATS.has(rel.format) || !mediaById.has(String(rel.id))) continue;
    edges.push({ from: String(media.anilistId), to: String(rel.id), relation: rel.relation });
  }
  const distinctEdges = [...new Map(edges.map((edge) => [`${edge.from}:${edge.to}`, edge])).values()];
  const incoming = new Map(); const outgoing = new Map();
  for (const edge of distinctEdges) {
    const from = edge.relation === 'PREQUEL' ? edge.to : edge.from;
    const to = edge.relation === 'PREQUEL' ? edge.from : edge.to;
    outgoing.set(from, [...(outgoing.get(from) || []), to]);
    incoming.set(to, [...(incoming.get(to) || []), from]);
  }
  const ambiguous = [...incoming.values(), ...outgoing.values()].some((ids) => new Set(ids).size > 1);
  if (ambiguous) return { seed, items: [seed], movies: [], ambiguous: true, requests };

  const roots = mains.filter((item) => !(incoming.get(String(item.anilistId)) || []).length);
  let current = roots.length === 1 ? String(roots[0].anilistId) : seedKey;
  const ordered = []; const orderedIds = new Set();
  while (current && mediaById.has(current) && !orderedIds.has(current)) {
    orderedIds.add(current); ordered.push(mediaById.get(current));
    current = (outgoing.get(current) || [])[0];
  }
  // Disconnected or cyclic relations are not enough evidence to group.
  if (ordered.length !== mains.length || !ordered.some((item) => String(item.anilistId) === seedKey)) {
    return { seed, items: [seed], movies: [], ambiguous: true, requests };
  }

  const movieIds = new Set();
  for (const media of ordered) for (const rel of relationNodes(media)) {
    if (rel.format === 'MOVIE' && MOVIE_RELATIONS.has(rel.relation)) movieIds.add(String(rel.id));
  }
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
    const explicitSeason = String(record.title || '').match(/season\s*(\d+)|(\d+)(?:st|nd|rd|th)\s*season|\bS(\d+)\b|\bPart\s*(\d+)\b/i);
    const chartSeason = explicitSeason ? Number(explicitSeason.slice(1).find(Boolean)) : number === 1 ? 1 : null;
    return {
      ...record,
      franchiseId: String(franchiseId), franchiseTitle,
      franchiseOrder: number || null,
      franchiseType: record.format === 'MOVIE' ? 'movie' : ['SPECIAL', 'OVA'].includes(record.format) ? 'special' : 'season',
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

function mapRatingEpisode(records, chartSeason, episodeNumber, detectSeasonFromTitle) {
  for (const series of records || []) {
    if (series.franchiseType === 'movie' || series.format === 'MOVIE') continue;
    const explicit = String(series.title || '').match(/season\s*(\d+)|(\d+)(?:st|nd|rd|th)\s*season|\bS(\d+)\b|\bPart\s*(\d+)\b/i);
    const seasonNumber = series.franchiseSeasonNumber != null
      ? Number(series.franchiseSeasonNumber)
      : series.franchiseId ? (explicit ? Number(explicit.slice(1).find(Boolean)) : null) : detectSeasonFromTitle(series.title);
    if (seasonNumber !== Number(chartSeason)) continue;
    const episode = (series.episodes || []).find((item) => Number(item.number) === Number(episodeNumber));
    if (episode) return { series, episode };
  }
  return null;
}

module.exports = { resolveFranchise, applyFranchiseMetadata, planFranchiseAddition, mapRatingEpisode, SEASON_FORMATS, MOVIE_RELATIONS };
