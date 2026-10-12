import { load } from 'cheerio';
import { formatOf, integerOrNull, normalizeTitle } from './identity.mjs';
import { csrfMeta, inertiaProps, vixSources } from './extract.mjs';
import { HttpClient } from './http.mjs';
import { LabError, invariant } from './errors.mjs';

function baseUrl(value) {
  const u = new URL(value);
  invariant(['https:', 'http:'].includes(u.protocol) && !u.username && !u.password
    && u.pathname === '/' && !u.search && !u.hash, 'invalid_provider_base');
  return u.origin;
}
const positive = integerOrNull;
const year = value => {
  const y = String(value ?? '').match(/\b(19|20)\d{2}\b/);
  return y ? Number(y[0]) : null;
};
const bool = value => value === true || value === 1 || value === '1';

export function normalizeUnity(r, base = 'https://www.animeunity.so') {
  invariant(r && positive(r.id), 'provider_schema_changed');
  const titles = [...new Set([r.title_it, r.title_eng, r.title].filter(s => typeof s === 'string' && s.trim()))];
  invariant(titles.length && typeof r.slug === 'string' && r.slug, 'provider_schema_changed');
  return { provider: 'animeunity', providerId: String(r.id), slug: r.slug,
    title: titles[0], titles, ids: { anilist: positive(r.anilist_id), mal: positive(r.mal_id) },
    format: formatOf(r.type), year: year(r.date), episodes: positive(r.episodes_count),
    expectedEpisodes: positive(r.real_episodes_count),
    audio: r.dub != null ? (bool(r.dub) ? 'it' : 'ja') : null,
    // Website language declarations are kept separate from observed media tracks.
    subtitles: [], airing: /in corso/i.test(r.status || ''),
    url: base + '/anime/' + encodeURIComponent(String(r.id) + '-' + r.slug) };
}

export function normalizeWorld(r, base = 'https://www.animeworld.ac') {
  invariant(r && positive(r.id) && r.name && r.link && r.identifier, 'provider_schema_changed');
  const titles = [...new Set([r.name, r.jtitle, r.choseTitle].filter(s => typeof s === 'string' && s.trim()))];
  return { provider: 'animeworld', providerId: String(r.id), title: r.name, titles,
    ids: { anilist: positive(r.anilistId), mal: positive(r.malId) },
    format: formatOf(r.animeTypeName || r.animeTypeURL), year: year(r.year),
    episodes: positive(r.episodes), audio: r.language === 'jp' ? 'ja'
      : r.language === 'it' ? 'it' : r.dub != null ? (bool(r.dub) ? 'it' : 'ja') : null,
    subtitles: [], airing: r.state === '0' || r.state === 0,
    url: base + '/play/' + encodeURIComponent(r.link) + '.' + encodeURIComponent(r.identifier) };
}

export function worldUnits(html, work, base) {
  const $ = load(html), byId = new Map();
  $('div.server[data-name]').each((_i, server) => {
    const serverId = $(server).attr('data-name');
    $(server).find('li.episode > a').each((_j, element) => {
      const e = $(element), id = e.attr('data-episode-id'), number = e.attr('data-episode-num'),
        dataId = e.attr('data-id'), href = e.attr('href');
      invariant(id && number != null && dataId && href, 'episode_schema_changed');
      const key = String(id);
      const unit = byId.get(key) || { provider: 'animeworld', workId: work.providerId, id: key,
        number, title: e.attr('title') || null, servers: [] };
      invariant(unit.number === number, 'episode_identity_conflict');
      const u = new URL(href, base);
      invariant(u.origin === new URL(base).origin, 'episode_host_conflict');
      unit.servers.push({ serverId, dataId, url: u.href });
      byId.set(key, unit);
    });
  });
  // Older documents may omit .server; never fabricate an episode from a count.
  if (!byId.size && $('li.episode > a').length) throw new LabError('episode_schema_changed');
  return [...byId.values()];
}

export class AnimeUnity {
  constructor({ base = 'https://www.animeunity.so', client = new HttpClient(), maxPages = 8 } = {}) {
    this.id = 'animeunity'; this.base = baseUrl(base); this.client = client; this.maxPages = maxPages;
    this.token = null; this.bootstrap = null;
  }
  async session(signal) {
    if (this.token) return this.token;
    if (!this.bootstrap) {
      this.bootstrap = this.client.request(this.base + '/archivio', { signal }).then(r => {
        this.token = csrfMeta(r.text);
        invariant(this.token, 'csrf_missing'); return this.token;
      }).finally(() => { this.bootstrap = null; });
    }
    return this.bootstrap;
  }
  async archive(query, offset, signal) {
    for (let renewal = 0; renewal < 2; renewal++) {
      const token = await this.session(signal);
      const r = await this.client.request(this.base + '/archivio/get-animes', {
        method: 'POST', body: JSON.stringify({ title: query, offset }),
        headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': token,
          'X-Requested-With': 'XMLHttpRequest', Referer: this.base + '/archivio', Origin: this.base },
        signal, allowStatuses: [403, 419] });
      if ([403, 419].includes(r.status)) {
        this.token = null;
        if (renewal === 1) throw new LabError('provider_access_blocked');
        continue;
      }
      let data;
      try { data = JSON.parse(r.text); } catch { throw new LabError('provider_schema_changed'); }
      const rows = Array.isArray(data) ? data : data.records;
      invariant(Array.isArray(rows), 'provider_schema_changed');
      return rows;
    }
  }
  async search(query, { signal } = {}) {
    invariant(typeof query === 'string' && query.trim(), 'empty_query');
    const records = [], seen = new Set();
    for (let page = 0; page < this.maxPages; page++) {
      const rows = await this.archive(query, page * 30, signal);
      let fresh = 0;
      for (const r of rows) {
        const c = normalizeUnity(r, this.base);
        if (!seen.has(c.providerId)) { seen.add(c.providerId); records.push(c); fresh++; }
      }
      if (rows.length < 30) return { records, complete: true, pages: page + 1 };
      if (!fresh) return { records, complete: false, reason: 'pagination_repeated', pages: page + 1 };
    }
    return { records, complete: false, reason: 'search_budget_exhausted', pages: this.maxPages };
  }
  async units(work, { signal } = {}) {
    invariant(work.provider === this.id, 'provider_identity_conflict');
    const api = this.base + '/info_api/' + encodeURIComponent(work.providerId + '-' + work.slug);
    const info = (await this.client.json(api, { signal })).data;
    invariant(String(info.id) === String(work.providerId), 'work_identity_conflict');
    if (work.title || work.titles?.length) {
      const knownTitles = [work.title, ...(work.titles || [])].filter(Boolean).map(normalizeTitle);
      const actualTitles = [info.title, info.title_eng, info.title_it].filter(Boolean).map(normalizeTitle);
      invariant(actualTitles.some(t => knownTitles.includes(t)), 'work_identity_conflict');
    }
    const total = Number(info.episodes_count);
    invariant(Number.isSafeInteger(total) && total >= 0 && total <= 10000, 'episode_schema_changed');
    const seen = new Map(), listed = new Map();
    for (let start = 0; start <= total; start += 120) {
      const u = new URL(api + '/0');
      u.searchParams.set('start_range', String(start)); u.searchParams.set('end_range', String(start + 119));
      const data = (await this.client.json(u.href, { signal })).data;
      invariant(Array.isArray(data.episodes), 'episode_schema_changed');
      for (const e of data.episodes) {
        invariant(positive(e.id) && e.number != null && String(e.anime_id) === String(work.providerId),
          'episode_identity_conflict');
        const previousLabel = listed.get(String(e.id));
        invariant(previousLabel == null || previousLabel === String(e.number), 'episode_identity_conflict');
        listed.set(String(e.id), String(e.number));
        // "hidden" is also used for publicly playable rows; public is the publication flag.
        if (e.public === 0 || e.public === '0') continue;
        const unit = { provider: this.id, workId: work.providerId, id: String(e.id),
          number: String(e.number), title: e.title || null,
          providerFlags: { hidden: e.hidden ?? null, public: e.public ?? null } };
        const previous = seen.get(unit.id);
        invariant(!previous || previous.number === unit.number, 'episode_identity_conflict');
        seen.set(unit.id, unit);
      }
    }
    invariant(listed.size >= total, 'episode_listing_incomplete');
    return [...seen.values()];
  }
  async resolve(work, unit, { signal } = {}) {
    invariant(unit.provider === this.id && String(unit.workId) === String(work.providerId), 'unit_identity_conflict');
    const r = await this.client.request(this.base + '/embed-url/' + encodeURIComponent(unit.id), { signal });
    const embed = r.text.trim();
    invariant(/^https?:\/\//.test(embed), 'embed_unresolved');
    const p = await this.client.request(embed, { headers: { Referer: this.base + '/' }, signal });
    return vixSources(p.text, p.url).map(s => ({ ...s, provider: this.id,
      workId: work.providerId, unitId: unit.id }));
  }
}

export class AnimeWorld {
  constructor({ base = 'https://www.animeworld.ac', client = new HttpClient() } = {}) {
    this.id = 'animeworld'; this.base = baseUrl(base); this.client = client; this.token = null; this.bootstrap = null;
  }
  async session(signal) {
    if (this.token) return;
    if (!this.bootstrap) this.bootstrap = this.client.request(this.base + '/', { signal }).then(async r => {
      // Only a literal static cookie assignment is accepted; no script execution.
      const cookie = r.text.match(/document\.cookie\s*=\s*"([^";]+=[^";]+)(?:;[^"]*)?"/)?.[1];
      if (cookie) {
        await this.client.jar.setCookie(cookie + '; Path=/', this.base);
        r = await this.client.request(this.base + '/', { signal });
      }
      this.token = csrfMeta(r.text, 'id');
      invariant(this.token, 'csrf_missing');
    }).finally(() => { this.bootstrap = null; });
    return this.bootstrap;
  }
  async search(query, { signal } = {}) {
    invariant(typeof query === 'string' && query.trim(), 'empty_query');
    await this.session(signal);
    const u = new URL(this.base + '/api/search/v2'); u.searchParams.set('keyword', query);
    const r = await this.client.json(u.href, { method: 'POST', headers: {
      'csrf-token': this.token, 'X-Requested-With': 'XMLHttpRequest', Referer: this.base + '/' }, signal });
    invariant(Array.isArray(r.data.animes), 'provider_schema_changed');
    return { records: r.data.animes.map(v => normalizeWorld(v, this.base)),
      complete: true, pages: 1, completenessEvidence: 'endpoint_returns_array_no_pagination_contract' };
  }
  async units(work, { signal } = {}) {
    invariant(work.provider === this.id && new URL(work.url).origin === this.base, 'provider_identity_conflict');
    const r = await this.client.request(work.url, { signal });
    const $ = load(r.text), actualTitle = $('#anime-title').text().trim() || $('.info .title').first().text().trim(),
      actualMal = positive($('#mal-button').attr('href')?.match(/\/anime\/(\d+)/)?.[1]),
      actualAni = positive($('#anilist-button').attr('href')?.match(/\/anime\/(\d+)/)?.[1]);
    invariant(actualTitle, 'provider_schema_changed');
    if (work.title || work.titles?.length) invariant([work.title, ...(work.titles || [])].filter(Boolean)
      .some(t => normalizeTitle(t) === normalizeTitle(actualTitle)), 'work_identity_conflict');
    invariant(!actualMal || !work.ids?.mal || actualMal === work.ids.mal, 'work_identity_conflict');
    invariant(!actualAni || !work.ids?.anilist || actualAni === work.ids.anilist, 'work_identity_conflict');
    return worldUnits(r.text, work, this.base);
  }
  async resolve(work, unit, { signal } = {}) {
    invariant(unit.provider === this.id && String(unit.workId) === String(work.providerId), 'unit_identity_conflict');
    await this.session(signal);
    const sources = [], failures = [];
    for (const server of unit.servers) {
      // Server 9 exposes the direct media. Other host extractors are explicit unsupported results.
      if (server.serverId !== '9') { failures.push('server_unsupported'); continue; }
      const u = new URL(this.base + '/api/episode/info');
      u.searchParams.set('id', server.dataId); u.searchParams.set('alt', '0');
      const r = await this.client.json(u.href, { headers: { 'csrf-token': this.token, Referer: work.url }, signal });
      invariant(typeof r.data.grabber === 'string' && r.data.grabber, 'media_unresolved');
      sources.push({ type: /\.m3u8(?:[?]|$)/i.test(r.data.grabber) ? 'hls' : 'file',
        sourceId: server.dataId, url: r.data.grabber, headers: { Referer: this.base + '/' }, expiresAt: null,
        provider: this.id, workId: work.providerId, unitId: unit.id });
    }
    invariant(sources.length, failures.length ? 'server_unsupported' : 'media_unresolved');
    return sources;
  }
}

// SC is useful for additional dubbed editions. Anime season equivalence needs an explicit mapping.
export class StreamingCommunity {
  constructor({ base, client = new HttpClient(), maxPages = 5 } = {}) {
    invariant(base, 'explicit_provider_base_required');
    this.id = 'streamingcommunity'; this.base = baseUrl(base); this.client = client; this.maxPages = maxPages;
  }
  async search(query, { signal } = {}) {
    const records = [], seen = new Set();
    for (let page = 1; page <= this.maxPages; page++) {
      const u = new URL(this.base + '/it/search'); u.searchParams.set('q', query); u.searchParams.set('page', String(page));
      const props = inertiaProps((await this.client.request(u.href, { signal })).text);
      invariant(Array.isArray(props.titles), 'provider_schema_changed');
      let fresh = 0;
      for (const t of props.titles) {
        invariant(t.id != null && t.name && t.slug && ['tv', 'movie'].includes(t.type), 'provider_schema_changed');
        const id = t.type + ':' + t.id;
        if (seen.has(id)) continue;
        seen.add(id); fresh++;
        records.push({ provider: this.id, providerId: id, externalId: String(t.id), slug: t.slug,
          title: t.name, titles: [t.name], format: t.type === 'movie' ? 'MOVIE' : null,
          // TV seasons are not equated to an AniList work on the basis of a name.
          year: year(t.release_date), ids: { tmdb: positive(t.tmdb_id) }, tmdbType: t.type,
          episodes: t.type === 'movie' ? 1 : null,
          audio: null, url: this.base + '/it/titles/' + encodeURIComponent(t.id + '-' + t.slug) });
      }
      if (props.titles.length < 60) return { records, complete: true, pages: page };
      if (!fresh) return { records, complete: false, reason: 'pagination_repeated', pages: page };
    }
    return { records, complete: false, reason: 'search_budget_exhausted' };
  }
  async units(work, { signal, season } = {}) {
    invariant(work.provider === this.id, 'provider_identity_conflict');
    if (work.format === 'MOVIE') return [{ provider: this.id, workId: work.providerId,
      id: 'movie:' + work.externalId, number: null, title: work.title }];
    invariant(Number.isSafeInteger(season) && season >= 0, 'explicit_season_mapping_required');
    const props = inertiaProps((await this.client.request(work.url + '/season-' + season, { signal })).text);
    const eps = props.loadedSeason?.episodes;
    invariant(Array.isArray(eps), 'episode_schema_changed');
    return eps.map(e => {
      invariant(e.id != null && e.number != null, 'episode_schema_changed');
      return { provider: this.id, workId: work.providerId, id: String(e.id),
        number: String(e.number), season, title: e.name || null };
    });
  }
  async resolve(work, unit, { signal } = {}) {
    invariant(unit.provider === this.id && unit.workId === work.providerId, 'unit_identity_conflict');
    const u = new URL(this.base + '/iframe/' + encodeURIComponent(work.externalId));
    if (work.format !== 'MOVIE') u.searchParams.set('episode_id', unit.id);
    const r = await this.client.request(u.href, { signal });
    const src = load(r.text)('iframe').attr('src'); invariant(src, 'embed_unresolved');
    const p = await this.client.request(new URL(src, r.url).href, { signal, headers: { Referer: this.base + '/' } });
    return vixSources(p.text, p.url).map(s => ({ ...s, provider: this.id, workId: work.providerId, unitId: unit.id }));
  }
}
