// Metadati: AniList (serie) + Kitsu (titoli e miniature degli episodi). Solo API pubbliche.
const anilistClient = require('./anilist-client').createAniListClient();
const KITSU = 'https://kitsu.io/api/edge';
const ANISKIP = 'https://api.aniskip.com/v2/skip-times';
const Descriptions=require('./descriptions');
const descriptionService=Descriptions.createDescriptionService();

const stripHtml = (s) => String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#039;/g, "'").trim();
const normalizeRating = (value) => {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n > 10 ? n / 10 : n;
};

async function anilist(query, variables, options) { return anilistClient.request(query, variables, options); }

const FIELDS = `id idMal title { romaji english native } synonyms duration coverImage { extraLarge large medium } bannerImage description(asHtml: false)
  genres tags { id name rank isMediaSpoiler } averageScore episodes seasonYear format status nextAiringEpisode { airingAt episode } streamingEpisodes { title thumbnail }
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
    descriptionOriginal:stripHtml(m.description),descriptionLanguage:'unknown',descriptionSource:'AniList',descriptionTranslations:{},
    relationTags: (m.tags || []).map(({id,name,rank,isMediaSpoiler})=>({id,name,rank,isMediaSpoiler})),
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
  const d = await anilist(`query($s:String){Page(perPage:12){media(search:$s,type:ANIME,sort:SEARCH_MATCH){${FIELDS}}}}`, { s: text },{priority:'interactive'});
  return d.Page.media.map(normalize);
}

async function getAnime(id, options = {}) {
  const cached = anilistClient.getMedia(id);
  const media = cached || (await anilist(`query($id:Int){Media(id:$id,type:ANIME){${FIELDS}}}`, { id: Number(id) },{priority:options.priority})).Media;
  return normalize(media);
}

async function getCachedAnime(id, options = {}) {
  const cached = anilistClient.getMedia(id);
  if (!cached) return null;
  return normalize(cached);
}

async function getAnimeBatch(ids, options = {}) {
  const uniqueIds = [...new Set((ids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))].slice(0, 24);
  if (!uniqueIds.length) return [];
  const cached = new Map(uniqueIds.map(id => [id, anilistClient.getMedia(id)]));
  const missing = uniqueIds.filter(id => !cached.get(id));
  const fetched = missing.length ? (await anilist(`query($ids:[Int]){Page(perPage:24){media(id_in:$ids,type:ANIME){${FIELDS}}}}`, { ids: missing.sort((a, b) => a - b) },{priority:options.priority})).Page.media || [] : [];
  for (const media of fetched) cached.set(Number(media.id), media);
  return uniqueIds.map(id => cached.get(id)).filter(Boolean).map(normalize);
}

async function kitsuJson(url,{signal}={}) {
  const r = await fetch(url, { headers: { Accept: 'application/vnd.api+json' },signal:signal||AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Kitsu ha risposto ${r.status}`);
  return r.json();
}

async function kitsuIdFor(anilistId, title,signal) {
  try {
    const j = await kitsuJson(`${KITSU}/mappings?filter[externalSite]=anilist/anime&filter[externalId]=${anilistId}&include=item`,{signal});
    const item = (j.included || []).find((x) => x.type === 'anime');
    if (item) return item.id;
  } catch { /* si prova la ricerca testuale */ }
  const j = await kitsuJson(`${KITSU}/anime?filter[text]=${encodeURIComponent(title)}&page[limit]=12`,{signal});
  const {titleKey} = require('./animeworld');
  const matches=(j.data || []).filter(item=>[item.attributes?.canonicalTitle,...Object.values(item.attributes?.titles || {}),...(item.attributes?.abbreviatedTitles || [])]
    .some(name=>titleKey(name)===titleKey(title)));
  return matches.length===1 ? matches[0].id : null;
}

// Ritorna [{number, title, thumb, rating}]; se Kitsu non basta usa gli streamingEpisodes di AniList.
async function fetchEpisodes({ anilistId, kitsuId, title, streamingEpisodes, episodeCount,signal }) {
  const out = new Map();
  let kid = kitsuId,issue=null;
  try {
    if (!kid) kid = await kitsuIdFor(anilistId, title,signal);
    for (let offset = 0; kid && offset < 400; offset += 20) {
      const j = await kitsuJson(`${KITSU}/anime/${kid}/episodes?page[limit]=20&page[offset]=${offset}&sort=number`,{signal});
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
  } catch { if(signal?.aborted)return{kitsuId:kid,episodes:[],status:'cancelled',cancelled:true};issue='provider_unavailable'; }
  for (const s of streamingEpisodes || []) {
    const m = /^Episode\s+(\d+)\s*[-–:]\s*(.*)$/i.exec(s.title || '');
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isInteger(episodeCount) && episodeCount > 0 && n > episodeCount) continue;
    const cur = out.get(n) || { number: n, title: '', thumb: null, rating: null, ratingSource: null };
    if (!cur.title) cur.title = m[2]; if (!cur.thumb) cur.thumb = s.thumbnail || null;
    out.set(n, cur);
  }
  return { kitsuId: kid, episodes: [...out.values()].sort((a, b) => a.number - b.number),status:issue?'partial':'completed',...(issue?{issue,unavailable:true}:{}) };
}

const { cleanTitleForImdb } = require('./imdb-client');

const detectSeasonFromTitle = (title) => {
  const t = String(title || '');
  const m = t.match(/season\s*(\d+)/i) ||
            t.match(/(\d+)(?:st|nd|rd|th)\s*season/i) ||
            t.match(/\bS(\d+)\b/i) ||
            t.match(/\bPart\s*(\d+)\b/i);
  return m ? Number(m[1]) : 1;
};

const imdbClient = require('./imdb-client').createImdbClient({clean:cleanTitleForImdb});
async function searchImdbId(title, altTitle, options = {}) {
  const result=await imdbClient.load({...options,title,altTitle,resolveOnly:true});
  return result.selection || null;
}
async function fetchImdbData(options) {
  const result=await imdbClient.load(options);
  return ['ready','empty'].includes(result.status) ? result.chart || null : null;
}

function applyImdbRatingsToEpisodes(episodes, imdbChart, title) {
  const series = typeof title === 'object' ? title : {title};
  return require('./episode-ratings').apply({...series,episodes},imdbChart);
}

module.exports = {
  searchAnime,
  getAnime,
  getCachedAnime,
  getAnimeBatch,
  resolveDescription:(record,language)=>descriptionService.resolve(record,language),
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
