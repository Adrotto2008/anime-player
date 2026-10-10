// Metadati: AniList (serie) + Kitsu (titoli e miniature degli episodi). Solo API pubbliche.
const ANILIST = 'https://graphql.anilist.co';
const KITSU = 'https://kitsu.io/api/edge';
const ANISKIP = 'https://api.aniskip.com/v2/skip-times';

const stripHtml = (s) => String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#039;/g, "'").trim();
const normalizeRating = (value) => {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n > 10 ? n / 10 : n;
};

async function anilist(query, variables) {
  const r = await fetch(ANILIST, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query, variables }) });
  if (!r.ok) throw new Error(`AniList ha risposto ${r.status}`);
  const j = await r.json();
  if (j.errors) throw new Error(j.errors[0].message);
  return j.data;
}

async function translateDescriptionToItalian(description) {
  const source = stripHtml(description);
  if (!source) return source;
  const text = source.slice(0, 4500);
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=it&dt=t&q=${encodeURIComponent(text)}`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`Google Translate ha risposto ${r.status}`);
    const data = await r.json();
    const translated = Array.isArray(data[0]) ? data[0].map((part) => part && part[0]).filter(Boolean).join('') : '';
    return translated.trim() || source;
  } catch (err) {
    console.warn('Traduzione descrizione non disponibile:', err.message);
    return source;
  }
}

const FIELDS = `id idMal title { romaji english native } synonyms duration coverImage { extraLarge large medium } bannerImage description(asHtml: false)
  genres averageScore episodes seasonYear format status nextAiringEpisode { airingAt episode } streamingEpisodes { title thumbnail }
  characters(sort: ROLE, perPage: 8) { edges { role node { name { full } image { medium } } } }
  relations { edges { relationType node { id title { romaji english } type format seasonYear coverImage { medium large } } } }`;

function normalize(m) {
  return {
    anilistId: m.id,
    malId: m.idMal || null,
    title: (m.title && (m.title.english || m.title.romaji)) || 'Senza titolo',
    altTitle: m.title && m.title.romaji,
    titleAliases: [...new Set([m.title?.english, m.title?.romaji, m.title?.native, ...(m.synonyms || [])].filter(Boolean))],
    averageDuration: m.duration ? Number(m.duration) * 60 : null,
    cover: m.coverImage && (m.coverImage.extraLarge || m.coverImage.large || m.coverImage.medium),
    banner: m.bannerImage || null,
    description: stripHtml(m.description),
    genres: m.genres || [],
    score: m.averageScore ? m.averageScore / 10 : null,
    scoreSource: m.averageScore ? 'AniList' : null,
    year: m.seasonYear || null,
    format: m.format || null,
    type: m.type || null,
    status: m.status || null,
    nextAiringAt: m.nextAiringEpisode && m.nextAiringEpisode.airingAt ? m.nextAiringEpisode.airingAt * 1000 : null,
    nextEpisode: m.nextAiringEpisode && m.nextAiringEpisode.episode ? m.nextAiringEpisode.episode : null,
    episodeCount: m.episodes || null,
    streamingEpisodes: m.streamingEpisodes || [],
    cast: (m.characters?.edges || []).filter((x) => x.node?.name?.full).map((x) => ({
      name: x.node.name.full,
      role: x.role || null,
      image: x.node.image?.medium || null,
    })),
    related: (m.relations?.edges || []).filter((x) => x.node?.id && x.node?.type === 'ANIME').map((x) => ({
      id: x.node.id,
      title: (x.node.title && (x.node.title.english || x.node.title.romaji)) || 'Senza titolo',
      relation: x.relationType || null,
      format: x.node.format || null,
      type: x.node.type || null,
      year: x.node.seasonYear || null,
      cover: x.node.coverImage?.large || x.node.coverImage?.medium || null,
    })),
  };
}

function aniSkipUrl(malId, episodeNumber, episodeLength) {
  const params = new URLSearchParams();
  for (const type of ['op', 'ed', 'mixed-op', 'mixed-ed', 'recap']) params.append('types[]', type);
  params.set('episodeLength', String(Number.isFinite(Number(episodeLength)) && Number(episodeLength) > 0 ? Number(episodeLength) : 1500));
  return `${ANISKIP}/${encodeURIComponent(malId)}/${encodeURIComponent(episodeNumber)}?${params}`;
}

async function fetchAniSkipTimes(malId, episodeNumber, episodeLength) {
  if (!malId || !Number.isInteger(Number(episodeNumber))) return [];
  const r = await fetch(aniSkipUrl(malId, episodeNumber, episodeLength), { headers: { Accept: 'application/json' } });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`AniSkip ha risposto ${r.status}`);
  const data = await r.json();
  return (data.found && Array.isArray(data.results) ? data.results : [])
    .filter((x) => x && Number.isFinite(Number(x.interval?.startTime)) && Number.isFinite(Number(x.interval?.endTime)))
    .map((x) => ({ skipType: x.skipType || 'unknown', start: Number(x.interval.startTime), end: Number(x.interval.endTime) }));
}

async function searchAnime(text) {
  const d = await anilist(`query($s:String){Page(perPage:12){media(search:$s,type:ANIME,sort:SEARCH_MATCH){${FIELDS}}}}`, { s: text });
  return d.Page.media.map(normalize);
}

async function getAnime(id, options = {}) {
  const d = await anilist(`query($id:Int){Media(id:$id,type:ANIME){${FIELDS}}}`, { id });
  const anime = normalize(d.Media);
  if (options.language === 'it' && anime.description) anime.description = await translateDescriptionToItalian(anime.description);
  return anime;
}

async function getAnimeBatch(ids, options = {}) {
  const uniqueIds = [...new Set((ids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))].slice(0, 24);
  if (!uniqueIds.length) return [];
  const d = await anilist(`query($ids:[Int]){Page(perPage:24){media(id_in:$ids,type:ANIME){${FIELDS}}}}`, { ids: uniqueIds });
  const results = (d.Page.media || []).map(normalize);
  if (options.language === 'it') {
    for (const anime of results) if (anime.description) anime.description = await translateDescriptionToItalian(anime.description);
  }
  return results;
}

async function kitsuJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/vnd.api+json' } });
  if (!r.ok) throw new Error(`Kitsu ha risposto ${r.status}`);
  return r.json();
}

async function kitsuIdFor(anilistId, title) {
  try {
    const j = await kitsuJson(`${KITSU}/mappings?filter[externalSite]=anilist/anime&filter[externalId]=${anilistId}&include=item`);
    const item = (j.included || []).find((x) => x.type === 'anime');
    if (item) return item.id;
  } catch { /* si prova la ricerca testuale */ }
  const j = await kitsuJson(`${KITSU}/anime?filter[text]=${encodeURIComponent(title)}&page[limit]=12`);
  const {titleKey} = require('./animeworld');
  const matches=(j.data || []).filter(item=>[item.attributes?.canonicalTitle,...Object.values(item.attributes?.titles || {}),...(item.attributes?.abbreviatedTitles || [])]
    .some(name=>titleKey(name)===titleKey(title)));
  return matches.length===1 ? matches[0].id : null;
}

// Ritorna [{number, title, thumb, rating}]; se Kitsu non basta usa gli streamingEpisodes di AniList.
async function fetchEpisodes({ anilistId, kitsuId, title, streamingEpisodes, episodeCount }) {
  const out = new Map();
  let kid = kitsuId;
  try {
    if (!kid) kid = await kitsuIdFor(anilistId, title);
    for (let offset = 0; kid && offset < 400; offset += 20) {
      const j = await kitsuJson(`${KITSU}/anime/${kid}/episodes?page[limit]=20&page[offset]=${offset}&sort=number`);
      for (const e of j.data) {
        const a = e.attributes;
        if (!a.number) continue;
        if (Number.isInteger(episodeCount) && episodeCount > 0 && a.number > episodeCount) continue;
        const rating = normalizeRating(a.averageRating != null ? a.averageRating : a.ratingAverage);
        out.set(a.number, {
          number: a.number,
          title: a.canonicalTitle || (a.titles && (a.titles.en_us || a.titles.en_jp)) || '',
          thumb: a.thumbnail && (a.thumbnail.original || a.thumbnail.large) || null,
          duration: a.length || null,
          durationUnit: 'minutes', durationSource: 'Kitsu',
          rating,
          ratingSource: rating == null ? null : 'Kitsu',
        });
      }
      if (!j.links || !j.links.next) break;
    }
  } catch { /* si va avanti con quello che c'è */ }
  for (const s of streamingEpisodes || []) {
    const m = /^Episode\s+(\d+)\s*[-–:]\s*(.*)$/i.exec(s.title || '');
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isInteger(episodeCount) && episodeCount > 0 && n > episodeCount) continue;
    const cur = out.get(n) || { number: n, title: '', thumb: null, rating: null, ratingSource: null };
    if (!cur.title) cur.title = m[2]; if (!cur.thumb) cur.thumb = s.thumbnail || null;
    out.set(n, cur);
  }
  return { kitsuId: kid, episodes: [...out.values()].sort((a, b) => a.number - b.number) };
}

const cleanTitleForImdb = (title) => {
  let t = String(title || '').trim();
  t = t.replace(/[:–-]\s*(season\s*\d+|\d+(?:st|nd|rd|th)\s*season|the\s+final\s+season.*|final\s+season.*|part\s*\d+|cour\s*\d+|entertainment\s+district.*|swordsmith\s+village.*|hashira\s+training.*|mugen\s+train.*|shibuya\s+incident.*|yuukaku-hen.*)/gi, '');
  t = t.replace(/\s+(season\s*\d+|\d+(?:st|nd|rd|th)\s*season|the\s+final\s+season.*|final\s+season.*|part\s*\d+|cour\s*\d+|s\d+|entertainment\s+district.*|swordsmith\s+village.*|hashira\s+training.*|mugen\s+train.*|shibuya\s+incident.*|yuukaku-hen.*)\b/gi, '');
  t = t.replace(/\s+(II|III|IV|V|VI)$/i, '');
  return t.trim();
};

const detectSeasonFromTitle = (title) => {
  const t = String(title || '');
  const m = t.match(/season\s*(\d+)/i) ||
            t.match(/(\d+)(?:st|nd|rd|th)\s*season/i) ||
            t.match(/\bS(\d+)\b/i) ||
            t.match(/\bPart\s*(\d+)\b/i);
  return m ? Number(m[1]) : 1;
};

async function searchImdbId(title, altTitle) {
  const candidates = [
    cleanTitleForImdb(title),
    title,
    cleanTitleForImdb(altTitle),
    altTitle,
  ].filter(Boolean);
  const seen = new Set();
  for (const c of candidates) {
    const key = c.toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const q = key.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!q) continue;
    const first = q[0];
    try {
      const res = await fetch(`https://v3.sg.media-imdb.com/suggestion/${first}/${q}.json`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data.d) && data.d.length > 0) {
        const {titleKey}=require('./animeworld');
        const matches=data.d.filter(x=>['tvSeries','tvMiniSeries'].includes(x.qid) || x.q==='TV series')
          .filter(x=>candidates.some(name=>titleKey(cleanTitleForImdb(name))===titleKey(x.l)));
        if(matches.length===1)return {id:matches[0].id,title:matches[0].l};
      }
    } catch { /* si passa al prossimo candidato */ }
  }
  return null;
}

async function fetchImdbData({ imdbId, title, altTitle }) {
  let targetId = imdbId;
  if (!targetId) {
    const found = await searchImdbId(title, altTitle);
    if (found) targetId = found.id;
  }
  if (!targetId) return null;

  try {
    let hasNext = true;
    let cursor = null;
    const fetchedEdges = [];
    let titleText = '';
    let overallRating = null;
    let voteCount = null;
    let seasonsList = [];

    while (hasNext && fetchedEdges.length < 1000) {
      const cursorArg = cursor ? `, after: "${cursor}"` : '';
      const query = `
        query {
          title(id: "${targetId}") {
            id
            titleText { text }
            ratingsSummary { aggregateRating voteCount }
            episodes {
              seasons { number }
              episodes(first: 250${cursorArg}) {
                total
                pageInfo { hasNextPage endCursor }
                edges {
                  node {
                    id
                    titleText { text }
                    series { episodeNumber { episodeNumber seasonNumber } }
                    ratingsSummary { aggregateRating voteCount }
                  }
                }
              }
            }
          }
        }
      `;
      const res = await fetch('https://caching.graphql.imdb.com', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'x-imdb-client-name': 'imdb-web-next-localized',
        },
        body: JSON.stringify({ query }),
      });
      if (!res.ok) break;
      const json = await res.json();
      const t = json.data && json.data.title;
      if (!t) break;
      if (!titleText && t.titleText) titleText = t.titleText.text;
      if (overallRating == null && t.ratingsSummary) overallRating = t.ratingsSummary.aggregateRating;
      if (voteCount == null && t.ratingsSummary) voteCount = t.ratingsSummary.voteCount;
      if (!seasonsList.length && t.episodes && t.episodes.seasons) seasonsList = t.episodes.seasons.map((s) => s.number);

      const epData = t.episodes && t.episodes.episodes;
      if (!epData) break;
      const edges = epData.edges || [];
      fetchedEdges.push(...edges);

      const pageInfo = epData.pageInfo;
      if (pageInfo && pageInfo.hasNextPage && pageInfo.endCursor && edges.length > 0) {
        cursor = pageInfo.endCursor;
      } else {
        hasNext = false;
      }
    }

    if (!fetchedEdges.length && overallRating == null) return null;

    const seasonsMap = new Map();
    for (const sNum of seasonsList.filter((n) => Number.isInteger(n) && n > 0)) {
      seasonsMap.set(sNum, []);
    }

    for (const edge of fetchedEdges) {
      const node = edge.node;
      if (!node) continue;
      const epNum = node.series && node.series.episodeNumber;
      if (!epNum) continue;
      const s = epNum.seasonNumber;
      const ep = epNum.episodeNumber;
      if (!Number.isInteger(s) || s <= 0 || !Number.isInteger(ep) || ep <= 0) continue;
      if (!seasonsMap.has(s)) seasonsMap.set(s, []);
      seasonsMap.get(s).push({
        number: ep,
        title: (node.titleText && node.titleText.text) || '',
        rating: node.ratingsSummary ? node.ratingsSummary.aggregateRating : null,
        id: node.id,
      });
    }

    const seasons = [];
    for (const [season, eps] of seasonsMap.entries()) {
      eps.sort((a, b) => a.number - b.number);
      seasons.push({ season, episodes: eps });
    }
    seasons.sort((a, b) => a.season - b.season);

    let maxEpisodes = 0;
    for (const s of seasons) {
      if (s.episodes.length > maxEpisodes) maxEpisodes = s.episodes.length;
      for (const ep of s.episodes) {
        if (ep.number > maxEpisodes) maxEpisodes = ep.number;
      }
    }

    return {
      imdbId: targetId,
      title: titleText || title || '',
      overallRating,
      voteCount,
      seasons,
      maxEpisodes,
    };
  } catch (err) {
    console.warn('IMDb fetch error:', err.message);
    return null;
  }
}

function applyImdbRatingsToEpisodes(episodes, imdbChart, title) {
  const series = typeof title === 'object' ? title : {title};
  return require('./episode-ratings').apply({...series,episodes},imdbChart);
}

module.exports = {
  searchAnime,
  getAnime,
  getAnimeBatch,
  fetchEpisodes,
  fetchAniSkipTimes,
  aniSkipUrl,
  stripHtml,
  cleanTitleForImdb,
  detectSeasonFromTitle,
  searchImdbId,
  fetchImdbData,
  applyImdbRatingsToEpisodes,
};
