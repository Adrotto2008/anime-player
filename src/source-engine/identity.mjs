import { invariant } from './errors.mjs';

export function normalizeTitle(value) {
  return String(value ?? '').normalize('NFKC').normalize('NFKD')
    .replace(/\p{M}/gu, '').toLowerCase()
    .replace(/\((?:ita|sub ita|sub-ita|dub ita)\)|\[(?:ita|sub ita|sub-ita|dub ita)\]/g, ' ')
    .replace(/[’‘\u0060]/g, "'").replace(/[^\p{L}\p{N}+'β]+/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

export function formatOf(value) {
  const s = String(value ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  const known = { TV: 'TV', TV_SHORT: 'TV_SHORT', SERIE_TV: 'TV', MOVIE: 'MOVIE',
    FILM: 'MOVIE', OVA: 'OVA', ONA: 'ONA', SPECIAL: 'SPECIAL', SPECIALI: 'SPECIAL',
    MUSIC: 'MUSIC' };
  return known[s] ?? null;
}

export function integerOrNull(value) {
  if (value == null || value === '' || !/^\d+$/.test(String(value))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function titleStrings(work) {
  const values = [work.title, ...(work.titles || [])];
  for (const a of work.aliases || []) {
    if (a && typeof a === 'object' && a.verified && a.source && a.title) values.push(a.title);
  }
  return [...new Set(values.filter(v => typeof v === 'string' && v.trim()))];
}

export function signature(title) {
  const t = normalizeTitle(title);
  const number = s => s ? Number(s) : null;
  let season = number(t.match(/\b(?:season|stagione)\s*(\d+)\b/)?.[1]
    ?? t.match(/\b(\d+)(?:st|nd|rd|th)?\s+(?:season|stagione)\b/)?.[1]);
  const part = number(t.match(/\b(?:part|parte|cour)\s*(\d+)\b/)?.[1]);
  if (!season) season = number(t.replace(/\b(?:part|parte|cour)\s*\d+\b/g, '').trim().match(/\s(\d+)$/)?.[1]);
  const variants = [];
  for (const [key, pattern] of [
    ['recap', /\b(?:recap|compilation|riassunto|recapitulation|soushuuhen)\b/],
    ['directors_cut', /\bdirector'?s cut\b|\bshin henshuu ban\b/],
    ['remake', /\b(?:remake|reboot)\b/],
    ['ova', /\bova\b/], ['special', /\b(?:special|speciali)\b/],
    ['movie', /\b(?:movie|film)\b/], ['beta', /β|\bbeta\b/],
  ]) if (pattern.test(t)) variants.push(key);
  return { season, part, variants };
}

function similarity(a, b) {
  const x = normalizeTitle(a), y = normalizeTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const xa = new Set(x.split(' ')), ya = new Set(y.split(' '));
  const common = [...xa].filter(t => ya.has(t)).length;
  return common / new Set([...xa, ...ya]).size;
}

function sameSeasonSpelling(a, b) {
  const sa = signature(a), sb = signature(b);
  if (!sa.season || sa.season !== sb.season || sa.part !== sb.part) return false;
  const base = title => normalizeTitle(title)
    .replace(/\b(?:season|stagione)\s*\d+\b|\b\d+(?:st|nd|rd|th)?\s+(?:season|stagione)\b/g, ' ')
    .replace(/\b(?:part|parte|cour)\s*\d+\b/g, ' ').trim()
    .replace(/\s\d+$/, '').replace(/\s+/g, ' ').trim();
  return base(a) !== '' && base(a) === base(b);
}

export function assessCandidate(target, candidate) {
  invariant(target && candidate, 'invalid_work');
  const reasons = [], evidence = [];
  const targetTitles = titleStrings(target), candidateTitles = titleStrings(candidate);
  if (!targetTitles.length || !candidateTitles.length) reasons.push('missing_title');
  let equalTitles = targetTitles.some(a => candidateTitles.some(b => normalizeTitle(a) === normalizeTitle(b)));
  const titleSimilarity = Math.max(0, ...targetTitles.flatMap(a => candidateTitles.map(b => similarity(a, b))));
  if (equalTitles) evidence.push('exact_full_title_or_verified_alias');
  const idMatches = [];
  for (const scheme of ['anilist', 'mal', 'tmdb']) {
    const a = integerOrNull(target.ids?.[scheme]), b = integerOrNull(candidate.ids?.[scheme]);
    if (a && b) {
      if (scheme === 'tmdb' && target.tmdbType !== candidate.tmdbType) reasons.push('tmdb_type_conflict');
      else if (a !== b) reasons.push(scheme + '_id_conflict');
      else { idMatches.push(scheme); evidence.push(scheme + '_id_match'); }
    }
  }
  if (!equalTitles && idMatches.length > 0 && targetTitles.some(a => candidateTitles.some(b => sameSeasonSpelling(a, b)))) {
    equalTitles = true; evidence.push('catalog_id_and_equivalent_season_spelling');
  }
  const tf = formatOf(target.format), cf = formatOf(candidate.format);
  if (tf && cf && tf !== cf) reasons.push('format_conflict');
  if (target.year != null && candidate.year != null && Number(target.year) !== Number(candidate.year))
    reasons.push('year_conflict');
  const tt = signature(target.title || targetTitles[0]), ct = signature(candidate.title || candidateTitles[0]);
  for (const k of ['season', 'part']) {
    const a = target[k] ?? tt[k], b = candidate[k] ?? ct[k];
    if (a != null && b != null && Number(a) !== Number(b)) reasons.push(k + '_conflict');
    else if ((a == null) !== (b == null) && !idMatches.length) reasons.push(k + '_unproven');
  }
  if (tt.variants.join(',') !== ct.variants.join(',')) reasons.push('edition_conflict');
  if (target.audio && candidate.audio && target.audio !== candidate.audio) reasons.push('audio_conflict');
  if (target.audio && !candidate.audio) reasons.push('audio_unknown');
  if (target.subtitles && !candidate.subtitles?.includes(target.subtitles)) reasons.push('subtitles_unproven');
  if (target.episodes != null && candidate.episodes != null && Number(target.episodes) !== Number(candidate.episodes)) {
    if (!candidate.airing || Number(candidate.episodes) > Number(target.episodes)) reasons.push('episode_count_conflict');
  }
  if (tf && cf === tf) evidence.push('format_match');
  if (target.year != null && Number(target.year) === Number(candidate.year)) evidence.push('year_match');
  if (target.episodes != null && Number(target.episodes) === Number(candidate.episodes)) evidence.push('episode_count_match');

  // Catalogue IDs can cover more than one film: title disagreement never auto-selects.
  if (!equalTitles) reasons.push(titleSimilarity >= 0.7 ? 'title_needs_review' : 'title_conflict');
  const fatal = reasons.some(r => !['title_needs_review', 'season_unproven', 'part_unproven',
    'episode_count_conflict', 'audio_unknown', 'subtitles_unproven'].includes(r));
  const supported = idMatches.length > 0 || (evidence.includes('format_match') && evidence.includes('year_match')
    && evidence.includes('episode_count_match'));
  const eligible = equalTitles && supported && reasons.length === 0;
  const score = (equalTitles ? 60 : titleSimilarity * 40) + idMatches.length * 12
    + (evidence.includes('format_match') ? 6 : 0) + (evidence.includes('year_match') ? 6 : 0);
  return { candidate, decision: fatal ? 'rejected' : eligible ? 'eligible' : 'review_required',
    score, reasons: [...new Set(reasons)], evidence };
}

export function chooseCandidate(target, candidates) {
  const seen = new Map();
  const unique = candidates.filter(c => {
    invariant(c.provider && c.providerId != null && String(c.providerId) !== '', 'missing_provider_identity');
    const k = c.provider + ':' + c.providerId;
    const identity = JSON.stringify([c.title, c.ids, c.format, c.year, c.audio]);
    if (seen.has(k)) {
      invariant(seen.get(k) === identity, 'conflicting_provider_record');
      return false;
    }
    seen.set(k, identity); return true;
  });
  const assessments = unique.map(c => assessCandidate(target, c)).sort((a, b) => b.score - a.score);
  const eligible = assessments.filter(a => a.decision === 'eligible');
  if (!unique.length) return { status: 'not_found', selected: null, assessments };
  if (!eligible.length) return { status: assessments.some(a => a.decision === 'review_required')
    ? 'review_required' : 'title_rejected', selected: null, assessments };
  if (eligible.length !== 1) return { status: 'ambiguous', selected: null, assessments };
  const competing = assessments.some(a => a !== eligible[0] && a.decision === 'review_required'
    && (a.evidence.includes('exact_full_title_or_verified_alias') || a.evidence.includes('catalog_id_and_equivalent_season_spelling')));
  if (competing) return { status: 'ambiguous', selected: null, assessments };
  return { status: 'matched', selected: eligible[0].candidate, assessments };
}

export function parseEpisodeLabel(value) {
  const raw = String(value ?? '').normalize('NFKC').trim();
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const [i, f] = raw.split('.');
    const whole = i.replace(/^0+(?=\d)/, ''), frac = f?.replace(/0+$/, '');
    return { kind: frac ? 'decimal' : 'number', value: whole + (frac ? '.' + frac : ''), raw };
  }
  const m = raw.match(/^(\d+)\s*[-–]\s*(\d+)$/);
  if (m && Number(m[1]) <= Number(m[2])) return { kind: 'range', first: String(Number(m[1])),
    last: String(Number(m[2])), raw };
  return { kind: 'opaque', value: raw, raw };
}

export function chooseUnit(work, wanted, units) {
  invariant(work?.provider && work.providerId != null, 'missing_provider_identity');
  invariant(wanted && (wanted.id != null || wanted.number != null || wanted.title || wanted.single), 'missing_unit_selector');
  const valid = units.filter(u => u.provider === work.provider && String(u.workId) === String(work.providerId));
  let matches;
  if (wanted.id != null) matches = valid.filter(u => String(u.id) === String(wanted.id));
  else if (wanted.number != null) {
    const label = parseEpisodeLabel(wanted.number);
    matches = valid.filter(u => {
      const p = parseEpisodeLabel(u.number);
      return p.kind === label.kind && (p.kind === 'range' ? p.first === label.first && p.last === label.last
        : p.value === label.value) && p.value !== '';
    });
  } else if (wanted.title) matches = valid.filter(u => u.title && normalizeTitle(u.title) === normalizeTitle(wanted.title));
  else {
    if (!['MOVIE', 'OVA', 'ONA', 'SPECIAL', 'MUSIC'].includes(formatOf(work.format)) || work.episodes !== 1)
      return { status: 'unit_review_required', selected: null };
    matches = valid.length === 1 ? valid : [];
  }
  if (!matches.length) return { status: 'episode_missing', selected: null };
  if (matches.length !== 1) return { status: 'unit_ambiguous', selected: null };
  const selected = matches[0], p = parseEpisodeLabel(selected.number);
  return { status: 'unit_matched', selected: { ...selected,
    kind: ['MOVIE', 'OVA', 'SPECIAL', 'MUSIC'].includes(formatOf(work.format)) ? 'media_part' : 'episode',
    label: p } };
}
