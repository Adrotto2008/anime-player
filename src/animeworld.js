'use strict';

const cheerio = require('cheerio');

const DEFAULT_BASE_URL = 'https://www.animeworld.ac';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function titleKey(value) {
  return String(value || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\((?:ita|sub\s*ita|ita\s*dub|dub)\)/g, ' ')
    .replace(/\b(?:sub\s*ita|ita\s*dub|dub)\b/g, ' ')
    .replace(/\b(\d+)(?:st|nd|rd|th)\s+season\b/g, 'season $1')
    .replace(/\bseason\s*(\d+)\b/g, 'season $1')
    .replace(/\b(s)\s*(\d+)\b/g, 'season $2')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function selectExactMatch(results, titles, { year, episodeCount, isAiring } = {}) {
  const aliases = (Array.isArray(titles) ? titles : [titles]).filter(Boolean);
  const keys = new Set(aliases.map(titleKey).filter(Boolean));
  const namesFor = (item) => [item.name, item.altTitle, ...(item.aliases || [])].filter(Boolean);
  let matches = (results || []).filter((item) => namesFor(item).some((name) => keys.has(titleKey(name))));
  if (!matches.length) return null;

  if (year) matches = matches.filter(item => item.year == null || Number(item.year) === Number(year));
  if (episodeCount) matches = matches.filter(item => item.episodes == null || Number(item.episodes) === Number(episodeCount)
    || isAiring && Number(item.episodes) < Number(episodeCount));
  if (!matches.length) return null;

  matches.sort((a, b) => {
    const aKey = titleKey(a.name); const bKey = titleKey(b.name);
    const aExact = aliases.some((title) => namesFor(a).some((name) => String(name).trim().toLowerCase() === String(title).trim().toLowerCase())) ? 0 : 1;
    const bExact = aliases.some((title) => namesFor(b).some((name) => String(name).trim().toLowerCase() === String(title).trim().toLowerCase())) ? 0 : 1;
    return aExact - bExact || aKey.localeCompare(bKey) || Number(Boolean(a.dub)) - Number(Boolean(b.dub));
  });
  const preferred = matches.filter(item => item.dub === false);
  const unique = [...new Map((preferred.length ? preferred : matches).map(item => [item.link, item])).values()];
  return unique.length === 1 ? unique[0] : null;
}

class AnimeWorldClient {
  constructor({ fetchImpl = globalThis.fetch, baseUrl = DEFAULT_BASE_URL, timeoutMs = 12000, concurrency = 6 } = {}) {
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.concurrency = concurrency;
    this.cookies = new Map();
    this.csrfToken = '';
    this.sessionReady = false;
  }

  _saveCookies(response) {
    const headers = response.headers;
    const values = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie')].filter(Boolean);
    for (const value of values) {
      const pair = value.split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator > 0) this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
  }

  async _request(path, options = {}) {
    const url = new URL(path, `${this.baseUrl}/`).toString();
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: options.accept || 'text/html,application/json;q=0.9,*/*;q=0.8',
      ...(this.csrfToken ? { 'csrf-token': this.csrfToken } : {}),
      ...(this.cookies.size ? { Cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
      ...(options.referer ? { Referer: options.referer } : {}),
      ...(options.headers || {}),
    };
    const response = await this.fetch(url, {
      method: options.method || 'GET', headers, body: options.body,
      signal: AbortSignal.timeout(this.timeoutMs), redirect: 'follow',
    });
    this._saveCookies(response);
    if (!response.ok) throw new Error(`AnimeWorld ha risposto ${response.status}.`);
    return response;
  }

  async _ensureSession() {
    if (this.sessionReady) return;
    const response = await this._request('/');
    const html = await response.text();
    const $ = cheerio.load(html);
    this.csrfToken = $('meta#csrf-token').attr('content') || '';
    this.sessionReady = true;
  }

  async search(text) {
    const query = String(text || '').trim();
    if (query.length < 2 || query.length > 100) return [];
    await this._ensureSession();
    const response = await this._request(`/api/search/v2?keyword=${encodeURIComponent(query)}`, {
      method: 'POST', referer: `${this.baseUrl}/`, accept: 'application/json',
    });
    const data = await response.json();
    if (!Array.isArray(data.animes)) throw new Error('Formato della ricerca AnimeWorld non riconosciuto.');
    return (Array.isArray(data.animes) ? data.animes : []).map((item) => ({
      name: item.name || '', year: item.year == null || item.year === '??' ? null : Number(item.year),
      altTitle: item.jtitle || '', aliases: [item.choseTitle].filter(Boolean),
      episodes: item.episodes == null || item.episodes === '??' ? null : Number(item.episodes),
      dub: item.dub == null ? null : item.dub !== '0',
      link: item.link && item.identifier ? `${this.baseUrl}/play/${item.link}.${item.identifier}` : null,
    })).filter((item) => item.name && item.link);
  }

  async searchCatalogue(title) {
    await this._ensureSession();
    const response = await this._request(`/search?keyword=${encodeURIComponent(title)}`, { referer: `${this.baseUrl}/` });
    const $ = cheerio.load(await response.text());
    if (!$('a.name').length && !$('.film-list').length) throw new Error('Pagina di ricerca AnimeWorld non riconosciuta.');
    return $('a.name[href^="/play/"]').map((_i, node) => {
      const name = $(node).text().trim();
      return { name, altTitle: $(node).attr('data-jtitle') || '',
        dub: /\(ITA\)/i.test(name), year: null, episodes: null,
        link: new URL($(node).attr('href'), this.baseUrl).toString() };
    }).get();
  }

  async _episodeSources(animeUrl, {year,episodeCount,isAiring} = {}) {
    const response = await this._request(animeUrl, { referer: `${this.baseUrl}/` });
    const $ = cheerio.load(await response.text());
    if (!$('.info').length && !$('.servers-tabs').length) throw new Error('Pagina episodi AnimeWorld non riconosciuta.');
    const releaseYear=$('.info').text().replace(/\s+/g,' ').match(/Data di Uscita:\s*.*?\b((?:19|20)\d{2})\b/i)?.[1];
    if(year && releaseYear && Number(releaseYear)!==Number(year)) {
      this.lastDiscovery.errors.push({phase:'match',message:`Anno del provider ${releaseYear} diverso da AniList ${year}`});return [];
    }
    const episodes = new Map();
    $('.servers-tabs .server-tab').each((_index, tab) => {
      const serverId = $(tab).attr('data-name');
      if (!/^\d+$/.test(serverId || '')) return;
      $(`div[class*="server"][data-name="${serverId}"] li.episode > a`).each((_episodeIndex, anchor) => {
        const element = $(anchor);
        const number = Number(element.attr('data-episode-num'));
        const episodeId = element.attr('data-episode-id');
        const serverDataId = element.attr('data-id');
        if (!Number.isSafeInteger(number) || number < 0 || !episodeId || !serverDataId) return;
        const entry = episodes.get(episodeId) || { number, serverDataIds: new Set() };
        entry.serverDataIds.add(serverDataId);
        episodes.set(episodeId, entry);
      });
    });

    const entries = [...episodes.values()];
    this.lastDiscovery ||= {errors:[]};
    this.lastDiscovery.episodesFound = entries.length;
    if(episodeCount && !isAiring && entries.some(item=>item.number>Number(episodeCount))) {
      this.lastDiscovery.errors.push({phase:'match',message:'Numerazione episodi incompatibile con il record AniList'});return [];
    }
    const results = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(this.concurrency, entries.length) }, async () => {
      while (cursor < entries.length) {
        const item = entries[cursor++];
        for (const serverDataId of item.serverDataIds) {
          try {
            const infoResponse = await this._request(`/api/episode/info?id=${encodeURIComponent(serverDataId)}&alt=0`, {
              referer: animeUrl, accept: 'application/json',
            });
            const info = await infoResponse.json();
            if (typeof info.grabber !== 'string' || !info.grabber) continue;
            const url = new URL(info.grabber, `${this.baseUrl}/`);
            if (!['http:', 'https:'].includes(url.protocol)) continue;
            results.push({ number: item.number, url: url.toString(), resolutionState: 'resolved' });
          } catch (error) { this.lastDiscovery.errors.push({number:item.number,phase:'episode',message:error.message}); }
        }
      }
    });
    await Promise.all(workers);
    return results;
  }

  async findSources({ titles, year, episodeCount, isAiring } = {}) {
    this.lastDiscovery = { status:'title_not_found', errors:[], episodesFound:0 };
    const aliases = (Array.isArray(titles) ? titles : [titles]).map((value) => String(value || '').trim()).filter(Boolean);
    if (!aliases.length) return [];
    const candidates = new Map();
    let completedQueries = 0; let lastError;
    for (const title of aliases) {
      try {
        for (const result of await this.search(title)) if (!candidates.has(result.link)) candidates.set(result.link, result);
        completedQueries++;
      } catch (error) { lastError = error; this.lastDiscovery.errors.push({phase:'search',message:error.message}); }
    }
    if (!completedQueries && lastError) throw lastError;
    let match = selectExactMatch([...candidates.values()], aliases, { year, episodeCount, isAiring });
    if (!match) {
      // The quick-search endpoint is capped and can omit exact titles (Monster).
      for (const title of aliases) {
        try {
          for (const result of await this.searchCatalogue(title)) if (!candidates.has(result.link)) candidates.set(result.link,result);
          match = selectExactMatch([...candidates.values()], aliases, {year,episodeCount,isAiring});
          if (match) break;
        } catch (error) { this.lastDiscovery.errors.push({phase:'catalogue',message:error.message}); }
      }
    }
    if (!match) return [];
    this.lastDiscovery.matchedTitle = match.name;
    const sources = await this._episodeSources(match.link,{year,episodeCount,isAiring});
    this.lastDiscovery.status = sources.length ? 'found' : this.lastDiscovery.errors.some(error=>error.phase==='match') ? 'title_not_found'
      : this.lastDiscovery.errors.length ? 'provider_error' : 'episodes_not_found';
    return sources;
  }
}

module.exports = { AnimeWorldClient, titleKey, selectExactMatch };
