'use strict';

// Lexical equality stays lossless for numbers, parts and subtitles. Structured
// equivalence is a separate decision, supported by identity/metadata evidence.
function titleKey(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\((?:ita|sub\s*ita|ita\s*dub|dub)\)/g, ' ')
    .replace(/\b(?:sub\s*ita|ita\s*dub|dub)\b/g, ' ')
    .replace(/\b(\d+)(?:st|nd|rd|th)\s+season\b/g, 'season $1')
    .replace(/\bseason\s*(\d+)\b/g, 'season $1').replace(/\bs\s*(\d+)\b/g, 'season $1')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function parseTitle(value) {
  const key = titleKey(value);
  const explicit = /\bseason (\d+)\b/.exec(key);
  const queryText = String(value || '').replace(/\b(\d+)(?:st|nd|rd|th)\s+season\b/gi, 'Season $1');
  const querySeason = /\b(?:season|s)\s*\d+\b/i.exec(queryText);
  // A bare number is only a *possible* season; it never becomes an alias by itself.
  const compact = !explicit && /\s(\d{1,2})(?:st|nd|rd|th)?(?=\s*(?::|\(|$)|\s+(?:part|cour)\b)/i.exec(String(value));
  const season = explicit ? Number(explicit[1]) : compact ? Number(compact[1]) : null;
  const partMatch = /\b(?:part|cour)\s*(\d+)\b|\b(\d+)(?:st|nd|rd|th)\s+cour\b/.exec(key);
  const part = partMatch ? Number(partMatch[1] || partMatch[2]) : /\bzenpen\b/.test(key) ? 1 : /\bkouhen\b/.test(key) ? 2 : null;
  const base = explicit ? key.slice(0, explicit.index).trim()
    : compact ? titleKey(String(value).slice(0, compact.index)) : key;
  const tail = explicit ? key.slice(explicit.index + explicit[0].length).trim()
    : compact ? titleKey(String(value).slice(compact.index + compact[0].length)) : '';
  const subtitle = tail.replace(/\b(?:part|cour)\s*\d+\b|\b\d+(?:st|nd|rd|th)\s+cour\b|\b(?:zenpen|kouhen)\b/g, '').trim();
  const variant = /\b(?:recap|summary|compilation|soushuuhen)\b/.test(key) ? 'recap'
    : /\b(?:remake|director s cut|shin henshuu)\b/.test(key) ? 'revision'
    : /\b(?:movie|film|gekijouban)\b/.test(key) ? 'MOVIE'
    : /\b(?:ova|oad)\b/.test(key) ? 'OVA' : /\bspecial\b/.test(key) ? 'SPECIAL' : null;
  const queryBase = querySeason ? queryText.slice(0, querySeason.index).trim() : null;
  return { key, base, queryBase, season, explicitSeason: Boolean(explicit), part, subtitle, variant };
}

const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
function mediaFormat(value) {
  const format = String(value || '').trim().toUpperCase().replace(/ /g, '_');
  return ['TV', 'TV_SHORT', 'ONA', 'OVA', 'MOVIE', 'SPECIAL', 'MUSIC'].includes(format) ? format : null;
}
const namesFor = item => [item.title || item.name, item.altTitle, ...(item.aliases || [])].filter(Boolean);
const uniqueValue = values => { const unique = [...new Set(values.filter(value => value != null))]; return unique.length === 1 ? unique[0] : null; };
function identity(titles, options = {}) {
  const parsed = titles.filter(Boolean).map(parseTitle);
  const explicit = parsed.filter(title => title.explicitSeason).map(title => title.season);
  const seasons = explicit.length ? explicit : parsed.map(title => title.season).filter(value => value != null);
  const parts = parsed.map(title => title.part).filter(value => value != null);
  return {
    parsed,
    season: uniqueValue(seasons) || positive(options.seasonNumber),
    part: uniqueValue(parts),
    conflicting: new Set(seasons).size > 1 || new Set(parts).size > 1,
    variant: parsed.find(title => title.variant)?.variant || null,
  };
}

function evaluateCandidate(item, titles, options = {}) {
  const target = identity(titles, options); const candidate = identity(namesFor(item));
  const reasons = []; const evidence = [];
  if (target.conflicting || candidate.conflicting) reasons.push('conflicting_title_metadata');
  const idPairs = [['anilistId', 'anilist_id'], ['malId', 'mal_id']];
  let sameId = false;
  for (const [field, reason] of idPairs) {
    const wanted = positive(options[field]); const actual = positive(item[field]);
    if (wanted && actual) {
      if (wanted !== actual) reasons.push(`${reason}_mismatch`);
      else { sameId = true; evidence.push(`${reason}_match`); }
    }
  }
  const format = mediaFormat(item.format); const targetFormat = mediaFormat(options.format);
  if (format && targetFormat && format !== targetFormat) reasons.push('format_mismatch');
  if (candidate.variant !== target.variant && (candidate.variant || target.variant)) reasons.push('variant_mismatch');
  if (candidate.variant && targetFormat && mediaFormat(candidate.variant) && candidate.variant !== targetFormat && !reasons.includes('format_mismatch')) reasons.push('format_mismatch');
  if (target.season && candidate.season && target.season !== candidate.season) reasons.push('season_mismatch');
  const count = positive(item.episodeCount ?? item.episodes); const wantedCount = positive(options.episodeCount);
  const year = positive(item.year); const wantedYear = positive(options.year);
  const airing = options.isAiring || options.status === 'RELEASING';
  const yearMatch = year && wantedYear && year === wantedYear;
  const countMatch = count && wantedCount && count === wantedCount;
  if (year && wantedYear && !yearMatch) reasons.push('year_mismatch');
  if (count && wantedCount && !countMatch && !(airing && count < wantedCount)) reasons.push('episode_count_mismatch');
  if (yearMatch) evidence.push('year_match');
  if (countMatch) evidence.push('episode_count_match');
  if (format && format === targetFormat) evidence.push('format_match');
  // Release state only relaxes an incomplete episode count. Provider schedules
  // can lag AniList, so a status difference is not itself an identity conflict.
  const metadataConfirmed = yearMatch && (countMatch || airing && !wantedCount && format && format === targetFormat);
  if (target.part !== candidate.part) {
    // Only an omitted *first* part can be supported by independent evidence.
    // Part 2 never silently becomes an unsplit season, even through a loose alias.
    if (!(target.part === 1 && candidate.part == null && (sameId || metadataConfirmed))) reasons.push('part_mismatch');
  }
  const exact = target.parsed.some(a => a.key && candidate.parsed.some(b => a.key === b.key));
  const arcs = target.parsed.flatMap(a => candidate.parsed.filter(b => a.season && a.season === b.season
    && a.base === b.base && a.subtitle && b.subtitle).map(b => [a.subtitle, b.subtitle]));
  if (!sameId && arcs.length && arcs.every(([a, b]) => a !== b)) reasons.push('subtitle_mismatch');
  const structured = target.parsed.some(a => candidate.parsed.some(b => {
    if (!a.base || a.base !== b.base || !a.season || a.season !== b.season) return false;
    if (!(a.explicitSeason || b.explicitSeason)) return false;
    // Different explicit story arcs are never interchangeable. An omitted arc
    // needs the independent evidence required by structured matching below.
    return !a.subtitle || !b.subtitle || a.subtitle === b.subtitle;
  }));
  const method = sameId ? 'external_id' : exact ? 'exact_title' : structured && metadataConfirmed ? 'structured_title' : null;
  if (!method) reasons.push(structured ? 'insufficient_metadata' : 'title_mismatch');
  // Do not use a generic alias to hide a clearly numbered different season.
  if (!sameId && target.season && !candidate.season && !metadataConfirmed) reasons.push('season_missing');
  if (!sameId && !target.season && candidate.season) reasons.push('season_mismatch');
  if (method) evidence.unshift(method);
  return { accepted: reasons.length === 0, method, reasons, evidence };
}

function selectExactMatch(results, titles, options = {}) {
  const aliases = (Array.isArray(titles) ? titles : [titles]).filter(Boolean);
  const evaluated = (results || []).map(item => ({ item, ...evaluateCandidate(item, aliases, options) })).filter(result => result.accepted);
  // An explicit external identity outranks a title-only guess. Otherwise keep
  // every compatible candidate: no fuzzy score or result ordering breaks a tie.
  const identified = evaluated.filter(result => result.method === 'external_id');
  const matches = (identified.length ? identified : evaluated).map(result => result.item);
  const unique = [...new Map(matches.map(item => [item.link || item.id || item, item])).values()];
  if (unique.length === 1) return unique[0];
  const sub = unique.filter(item => item.dub === false);
  if (sub.length === 1 && unique.every(item => item === sub[0] || item.dub === true
    && item.year === sub[0].year && (item.episodeCount ?? item.episodes) === (sub[0].episodeCount ?? sub[0].episodes)
    && (!positive(item.anilistId) || !positive(sub[0].anilistId) || Number(item.anilistId) === Number(sub[0].anilistId)))) return sub[0];
  return null;
}

function candidateDiagnostics(results, titles, options, match) {
  return results.map(item => {
    const result = evaluateCandidate(item, titles, options);
    const selected = Array.isArray(match) ? match.includes(item) : item === match;
    const reasons = [...result.reasons];
    if (!reasons.length && !selected) reasons.push((Array.isArray(match) ? match.length : match) ? 'alternate_candidate' : 'ambiguous');
    return { id: item.id, title: item.title || item.name, aliases: namesFor(item).slice(1),
      anilistId: item.anilistId, malId: item.malId, format: item.format, status: item.status,
      year: item.year, episodeCount: item.episodeCount ?? item.episodes,
      selected, reasons, evidence: result.evidence, method: result.method };
  });
}

// Resolve ambiguity within each language variant, never by preferring SUB to DUB.
function selectVariantMatches(results, titles, options = {}) {
  return [false, true, null].flatMap(dub => {
    const group = results.filter(item => (item.dub ?? null) === dub);
    const match = selectExactMatch(group, titles, options);
    return match ? [match] : [];
  });
}

function searchTitles(titles, options = {}) {
  const aliases = (Array.isArray(titles) ? titles : [titles]).map(value => String(value || '').trim()).filter(Boolean);
  const queries = [...aliases];
  for (const title of aliases) {
    const parsed = parseTitle(title);
    if (!parsed.explicitSeason || !parsed.base) continue;
    const base = parsed.queryBase || parsed.base;
    if (parsed.part) queries.push(`${base} ${parsed.season} Part ${parsed.part}`);
    queries.push(`${base} ${parsed.season}`, base);
  }
  // Franchise membership helps retrieval only. Never treat its title or graph
  // position (which counts split cours) as proof of season identity.
  if (options.franchiseTitle) queries.push(options.franchiseTitle);
  // Provider searches need the original spelling and punctuation; equal lexical
  // keys do not imply equal recall for two different server-side search queries.
  return [...new Map(queries.filter(query => query.length >= 2 && query.length <= 100).map(query => [query.toLowerCase(), query])).values()];
}

function matchOptions(series) {
  return { anilistId: series.anilistId, malId: series.malId, format: series.format,
    year: series.year, episodeCount: series.episodeCount, status: series.status,
    isAiring: series.status === 'RELEASING', franchiseTitle: series.franchiseTitle,
    seasonNumber: series.franchiseSeasonNumber };
}

module.exports = { titleKey, parseTitle, mediaFormat, evaluateCandidate, selectExactMatch, selectVariantMatches, candidateDiagnostics, searchTitles, matchOptions };
