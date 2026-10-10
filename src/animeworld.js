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
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function selectExactMatch(results, titles, { year, episodeCount } = {}) {
  const aliases = (Array.isArray(titles) ? titles : [titles]).filter(Boolean);
  const keys = new Set(aliases.map(titleKey).filter(Boolean));
  const namesFor = (item) => [item.name, item.altTitle, ...(item.aliases || [])].filter(Boolean);
  let matches = (results || []).filter((item) => namesFor(item).some((name) => keys.has(titleKey(name))));
  if (!matches.length) return null;

  const matchingYear = matches.filter((item) => year && Number(item.year) === Number(year));
  if (matchingYear.length) matches = matchingYear;
  const matchingCount = matches.filter((item) => episodeCount && Number(item.episodes) === Number(episodeCount));
  if (matchingCount.length) matches = matchingCount;

  matches.sort((a, b) => {
    const aKey = titleKey(a.name); const bKey = titleKey(b.name);
    const aExact = aliases.some((title) => namesFor(a).some((name) => String(name).trim().toLowerCase() === String(title).trim().toLowerCase())) ? 0 : 1;
    const bExact = aliases.some((title) => namesFor(b).some((name) => String(name).trim().toLowerCase() === String(title).trim().toLowerCase())) ? 0 : 1;
    return aExact - bExact || aKey.localeCompare(bKey) || Number(Boolean(a.dub)) - Number(Boolean(b.dub));
  });
  return matches[0];
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
    return (Array.isArray(data.animes) ? data.animes : []).map((item) => ({
      name: item.name || '', year: item.year == null || item.year === '??' ? null : Number(item.year),
      altTitle: item.jtitle || '', aliases: [item.choseTitle].filter(Boolean),
      episodes: item.episodes == null || item.episodes === '??' ? null : Number(item.episodes),
      dub: item.dub == null ? null : item.dub !== '0',
      link: item.link && item.identifier ? `${this.baseUrl}/play/${item.link}.${item.identifier}` : null,
    })).filter((item) => item.name && item.link);
  }

  async _episodeSources(animeUrl) {
    const response = await this._request(animeUrl, { referer: `${this.baseUrl}/` });
    const $ = cheerio.load(await response.text());
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
            results.push({ number: item.number, url: url.toString() });
          } catch { /* gli altri server dell'episodio possono ancora funzionare */ }
        }
      }
    });
    await Promise.all(workers);
    return results;
  }

  async findSources({ titles, year, episodeCount } = {}) {
    const aliases = (Array.isArray(titles) ? titles : [titles]).map((value) => String(value || '').trim()).filter(Boolean);
    if (!aliases.length) return [];
    const candidates = new Map();
    let completedQueries = 0; let lastError;
    for (const title of aliases) {
      try {
        for (const result of await this.search(title)) if (!candidates.has(result.link)) candidates.set(result.link, result);
        completedQueries++;
      } catch (error) { lastError = error; }
    }
    if (!completedQueries && lastError) throw lastError;
    const match = selectExactMatch([...candidates.values()], aliases, { year, episodeCount });
    if (!match) return [];
    return this._episodeSources(match.link);
  }
}

module.exports = { AnimeWorldClient, titleKey, selectExactMatch };
