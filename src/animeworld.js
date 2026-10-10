'use strict';

const cheerio = require('cheerio');
const { redact } = require('./source-state');
const { titleKey, selectExactMatch, selectVariantMatches, candidateDiagnostics, searchTitles } = require('./source-match');
const { classifyProvider } = require('./source-language');

const DEFAULT_BASE_URL = 'https://www.animeworld.ac';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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
      name: item.name || '', anilistId: Number(item.anilistId) || null, malId: Number(item.malId) || null,
      format: item.animeTypeName === 'Movie' ? 'MOVIE' : ['OVA', 'ONA', 'Special'].includes(item.animeTypeName) ? item.animeTypeName.toUpperCase() : null,
      status: item.stateName || null, year: item.year == null || item.year === '??' ? null : Number(item.year),
      altTitle: item.jtitle || '', aliases: [item.choseTitle].filter(Boolean),
      episodes: item.episodes == null || item.episodes === '??' ? null : Number(item.episodes),
      dub: item.dub == null ? null : !['0', 0, false].includes(item.dub), audioLanguage: item.language || null,
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

  async _episodeSources(animeUrl, {year,episodeCount,isAiring,episodeNumbers} = {}) {
    this.lastDiscovery ||= {errors:[]};
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
        const entry = episodes.get(episodeId) || { number, episodeId, serverDataIds: new Set() };
        entry.serverDataIds.add(serverDataId);
        episodes.set(episodeId, entry);
      });
    });

    const entries = [...episodes.values()];
    this.lastDiscovery ||= {errors:[]};
    this.lastDiscovery.episodesFound = entries.length;
    this.lastDiscovery.episodeNumbers = entries.map(item => item.number);
    if(episodeCount && !isAiring && entries.some(item=>item.number>Number(episodeCount))) {
      this.lastDiscovery.errors.push({phase:'match',message:'Numerazione episodi incompatibile con il record AniList'});return [];
    }
    const selected = episodeNumbers ? entries.filter(item => episodeNumbers.includes(item.number)) : entries;
    this.lastDiscovery.requestedEpisodesFound = selected.length;
    const results = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(this.concurrency, selected.length) }, async () => {
      while (cursor < selected.length) {
        const item = selected[cursor++];
        for (const serverDataId of item.serverDataIds) {
          try {
            const infoResponse = await this._request(`/api/episode/info?id=${encodeURIComponent(serverDataId)}&alt=0`, {
              referer: animeUrl, accept: 'application/json',
            });
            const info = await infoResponse.json();
            if (typeof info.grabber !== 'string' || !info.grabber) continue;
            const url = new URL(info.grabber, `${this.baseUrl}/`);
            if (!['http:', 'https:'].includes(url.protocol)) continue;
            results.push({ number: item.number, url: url.toString(), providerEpisodeId: item.episodeId, providerSourceId: serverDataId, providerTitleUrl: animeUrl, resolutionState: 'resolved' });
          } catch (error) { this.lastDiscovery.errors.push({number:item.number,phase:'episode',message:redact(error.message)}); }
        }
      }
    });
    await Promise.all(workers);
    return results;
  }

  async findSources({ titles, episodeNumbers, ...options } = {}) {
    const { year, episodeCount, isAiring } = options;
    this.lastDiscovery = { status:'title_not_found', errors:[], episodesFound:0 };
    const aliases = (Array.isArray(titles) ? titles : [titles]).map((value) => String(value || '').trim()).filter(Boolean);
    if (!aliases.length) return [];
    const candidates = new Map();
    let completedQueries = 0; let lastError;
    for (const title of searchTitles(aliases, options)) {
      try {
        for (const result of await this.search(title)) if (!candidates.has(result.link)) candidates.set(result.link, result);
        completedQueries++;
      } catch (error) { lastError = error; this.lastDiscovery.errors.push({phase:'search',message:redact(error.message)}); }
    }
    if (!completedQueries && lastError) throw lastError;
    let matches = selectVariantMatches([...candidates.values()], aliases, options);
    if (!matches.some(match => match.dub === true) || !matches.some(match => match.dub === false)) {
      // The quick-search endpoint is capped and can omit exact titles (Monster).
      for (const title of searchTitles(aliases, options)) {
        try {
          for (const result of await this.searchCatalogue(title)) if (!candidates.has(result.link)) candidates.set(result.link,result);
        } catch (error) { this.lastDiscovery.errors.push({phase:'catalogue',message:redact(error.message)}); }
      }
      matches = selectVariantMatches([...candidates.values()], aliases, options);
    }
    this.lastDiscovery.candidates = candidateDiagnostics([...candidates.values()], aliases, options, matches);
    if (!matches.length) { this.lastDiscovery.status = candidates.size ? 'title_rejected' : 'title_not_found'; return []; }
    this.lastDiscovery.matchedTitle = matches.map(match => match.name).join(' / ');
    const sources = []; let requested = 0; const numbers = new Set();
    for (const match of matches) {
      try {
        this.lastDiscovery.requestedEpisodesFound = 0; this.lastDiscovery.episodeNumbers = [];
        const found = await this._episodeSources(match.link,{year,episodeCount,isAiring,episodeNumbers});
        requested += this.lastDiscovery.requestedEpisodesFound || 0;
        (this.lastDiscovery.episodeNumbers || []).forEach(number => numbers.add(number));
        sources.push(...found.map(source => ({ ...source, provider: 'animeworld', providerTitleUrl: match.link, language: classifyProvider(match, source) })));
      } catch (error) { this.lastDiscovery.errors.push({phase:'variant',message:redact(error.message)}); }
    }
    this.lastDiscovery.requestedEpisodesFound = requested;
    this.lastDiscovery.episodesFound = numbers.size;
    this.lastDiscovery.episodeNumbers = [...numbers];
    this.lastDiscovery.status = sources.length ? 'found' : this.lastDiscovery.errors.some(error=>error.phase==='match') ? 'title_rejected'
      : this.lastDiscovery.errors.some(error => error.phase === 'variant') ? 'provider_error'
      : this.lastDiscovery.requestedEpisodesFound ? 'media_unresolved' : 'episodes_not_found';
    return sources;
  }

  async renewSource(source, number) {
    if (!/^[\w-]{1,100}$/.test(source.providerSourceId || '')) return null;
    await this._ensureSession();
    const response = await this._request(`/api/episode/info?id=${encodeURIComponent(source.providerSourceId)}&alt=0`, {referer:source.providerTitleUrl || `${this.baseUrl}/`,accept:'application/json'});
    const info = await response.json();
    if (typeof info.grabber !== 'string' || !info.grabber) return null;
    const url = new URL(info.grabber, `${this.baseUrl}/`);
    return ['http:', 'https:'].includes(url.protocol) ? {...source, number, url:url.toString(), resolutionState:'resolved',resolvedAt:Date.now()} : null;
  }
}

module.exports = { AnimeWorldClient, titleKey, selectExactMatch };
