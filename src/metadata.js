// Metadati: AniList (serie) + Kitsu (titoli e miniature degli episodi). Solo API pubbliche.
const ANILIST = 'https://graphql.anilist.co';
const KITSU = 'https://kitsu.io/api/edge';

const stripHtml = (s) => String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#039;/g, "'").trim();

async function anilist(query, variables) {
  const r = await fetch(ANILIST, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query, variables }) });
  if (!r.ok) throw new Error(`AniList ha risposto ${r.status}`);
  const j = await r.json();
  if (j.errors) throw new Error(j.errors[0].message);
  return j.data;
}

const FIELDS = `id idMal title { romaji english } coverImage { extraLarge large } bannerImage description(asHtml: false)
  genres averageScore episodes seasonYear format status streamingEpisodes { title thumbnail }`;

function normalize(m) {
  return {
    anilistId: m.id,
    title: (m.title && (m.title.english || m.title.romaji)) || 'Senza titolo',
    altTitle: m.title && m.title.romaji,
    cover: m.coverImage && (m.coverImage.extraLarge || m.coverImage.large),
    banner: m.bannerImage || null,
    description: stripHtml(m.description),
    genres: m.genres || [],
    score: m.averageScore ? m.averageScore / 10 : null,
    year: m.seasonYear || null,
    format: m.format || null,
    status: m.status || null,
    episodeCount: m.episodes || null,
    streamingEpisodes: m.streamingEpisodes || [],
  };
}

async function searchAnime(text) {
  const d = await anilist(`query($s:String){Page(perPage:12){media(search:$s,type:ANIME,sort:SEARCH_MATCH){${FIELDS}}}}`, { s: text });
  return d.Page.media.map(normalize);
}

async function getAnime(id) {
  const d = await anilist(`query($id:Int){Media(id:$id,type:ANIME){${FIELDS}}}`, { id });
  return normalize(d.Media);
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
  const j = await kitsuJson(`${KITSU}/anime?filter[text]=${encodeURIComponent(title)}&page[limit]=1`);
  return j.data && j.data[0] ? j.data[0].id : null;
}

// Ritorna [{number, title, thumb}]; se Kitsu non basta usa gli streamingEpisodes di AniList.
async function fetchEpisodes({ anilistId, kitsuId, title, streamingEpisodes }) {
  const out = new Map();
  let kid = kitsuId;
  try {
    if (!kid) kid = await kitsuIdFor(anilistId, title);
    for (let offset = 0; kid && offset < 400; offset += 20) {
      const j = await kitsuJson(`${KITSU}/anime/${kid}/episodes?page[limit]=20&page[offset]=${offset}&sort=number`);
      for (const e of j.data) {
        const a = e.attributes;
        if (!a.number) continue;
        out.set(a.number, { number: a.number, title: a.canonicalTitle || (a.titles && (a.titles.en_us || a.titles.en_jp)) || '', thumb: a.thumbnail && (a.thumbnail.original || a.thumbnail.large) || null });
      }
      if (!j.links || !j.links.next) break;
    }
  } catch { /* si va avanti con quello che c'è */ }
  for (const s of streamingEpisodes || []) {
    const m = /^Episode\s+(\d+)\s*[-–:]\s*(.*)$/i.exec(s.title || '');
    if (!m) continue;
    const n = Number(m[1]); const cur = out.get(n) || { number: n, title: '', thumb: null };
    if (!cur.title) cur.title = m[2]; if (!cur.thumb) cur.thumb = s.thumbnail || null;
    out.set(n, cur);
  }
  return { kitsuId: kid, episodes: [...out.values()].sort((a, b) => a.number - b.number) };
}

module.exports = { searchAnime, getAnime, fetchEpisodes, stripHtml };
