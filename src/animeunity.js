'use strict';

const cheerio = require('cheerio');
const { titleKey } = require('./animeworld');
const { redact, candidateDiagnostics, readEmbedText } = require('./source-state');

const DEFAULT_BASE_URL = 'https://www.animeunity.so';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function validHttpUrl(value, base) {
  try {
    const url = new URL(value, base);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}

function parseSearchRecords(data, baseUrl) {
  const records = Array.isArray(data) ? data : data && (data.records || data.animes || data.data);
  if (!Array.isArray(records)) throw new Error('Formato della ricerca AnimeUnity non riconosciuto.');
  return records.map((item) => {
    const title = String(item.title || item.title_eng || item.title_it || item.title_original || item.name || '').trim();
    const slug = String(item.slug || '').trim();
    const id = Number(item.id);
    const link = id > 0 && slug ? validHttpUrl(`/anime/${id}-${slug}`, `${baseUrl}/`) : null;
    const yearMatch = String(item.date || item.year || '').match(/\b(19|20)\d{2}\b/);
    const count = Number(item.episodes_count ?? item.episodes);
    return {
      id, title, altTitle: String(item.title_eng || item.title_original || '').trim(),
      aliases: [item.title, item.title_eng, item.title_it, item.title_original].filter(Boolean),
      dub: /\(ITA\)|-ita$/i.test(`${title} ${slug}`), slug, link,
      year: yearMatch ? Number(yearMatch[0]) : null,
      episodeCount: Number.isSafeInteger(count) && count > 0 ? count : null,
    };
  }).filter((item) => item.title && item.link);
}

function selectExactMatch(results, titles, { year, episodeCount, isAiring } = {}) {
  const aliases = (Array.isArray(titles) ? titles : [titles]).map((value) => String(value || '').trim()).filter(Boolean);
  const keys = new Set(aliases.map(titleKey).filter(Boolean));
  let matches = (results || []).filter((item) => [item.title, item.altTitle, ...(item.aliases || [])].some(name => keys.has(titleKey(name))));
  if (!matches.length) return null;
  if (year) {
    const knownYear = matches.filter((item) => item.year != null);
    if (knownYear.length && !knownYear.some((item) => item.year === Number(year))) return null;
    matches = matches.filter((item) => item.year == null || item.year === Number(year));
  }
  if (episodeCount) {
    const knownCount = matches.filter((item) => item.episodeCount != null);
    const compatible = item => item.episodeCount == null || item.episodeCount === Number(episodeCount)
      || isAiring && item.episodeCount < Number(episodeCount);
    if (knownCount.length && !knownCount.some(compatible)) return null;
    matches = matches.filter(compatible);
  }
  const exact = matches.filter((item) => aliases.some((alias) => [item.title, item.altTitle].some((name) => name && titleKey(name) === titleKey(alias))));
  if (exact.length) matches = exact;
  const unique = [...new Map(matches.map((item) => [String(item.id), item])).values()];
  const sub = unique.filter(item => item.dub === false);
  if (sub.length === 1 && unique.every(item => item.year === sub[0].year && item.episodeCount === sub[0].episodeCount)) return sub[0];
  return unique.length === 1 ? unique[0] : null;
}

function extractUrl(value, baseUrl) {
  const text = String(value || '').trim();
  const match = text.match(/(?:window\s*\.\s*)?downloadUrl\s*=\s*(['"])(.*?)\1/s);
  if (match) {
    const decoded = match[2].replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/\\x26/gi, '&').replace(/\\(['"])/g, '$1');
    return validHttpUrl(decoded, baseUrl);
  }
  const urlText = text.match(/^\s*https?:\/\/[^\s"'<>\\]+/i)?.[0];
  if (urlText) return validHttpUrl(urlText.replace(/[),;]+$/, ''), baseUrl);
  return null;
}

class AnimeUnityClient {
  constructor({ fetchImpl = globalThis.fetch, baseUrl = DEFAULT_BASE_URL, timeoutMs = 12000, concurrency = 4 } = {}) {
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.concurrency = Math.max(1, Math.min(8, concurrency));
    this.cookies = new Map();
    this.csrfToken = '';
    this.sessionReady = false;
  }

  _saveCookies(response) {
    const headers = response.headers;
    const values = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie')].filter(Boolean);
    for (const value of values) {
      const pair = value.split(';', 1)[0];
      const index = pair.indexOf('=');
      if (index > 0) this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }

  async _request(urlOrPath, { method = 'GET', referer, body, accept = 'application/json,text/html;q=0.9,*/*;q=0.8' } = {}) {
    const url = validHttpUrl(urlOrPath, `${this.baseUrl}/`);
    if (!url || new URL(url).origin !== new URL(this.baseUrl).origin) throw new Error('URL AnimeUnity non valido.');
    const headers = {
      'User-Agent': USER_AGENT, Accept: accept,
      ...(this.csrfToken ? { 'X-CSRF-TOKEN': this.csrfToken } : {}),
      ...(this.cookies.size ? { Cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}),
      ...(referer ? { Referer: referer } : {}),
      ...(body ? { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' } : {}),
    };
    const response = await this.fetch(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(this.timeoutMs), redirect: 'follow' });
    this._saveCookies(response);
    if (!response.ok) throw new Error(`AnimeUnity ha risposto ${response.status}.`);
    return response;
  }

  async _ensureSession() {
    if (this.sessionReady) return;
    const response = await this._request('/');
    const $ = cheerio.load(await response.text());
    this.csrfToken = $('meta[name="csrf-token"]').attr('content') || '';
    if (!this.csrfToken) throw new Error('Token di sessione AnimeUnity non trovato.');
    this.sessionReady = true;
  }

  async search(title) {
    const query = String(title || '').trim();
    if (query.length < 2 || query.length > 100) return [];
    await this._ensureSession();
    const response = await this._request('/livesearch', { method: 'POST', body: { title: query }, referer: `${this.baseUrl}/` });
    return parseSearchRecords(await response.json(), this.baseUrl);
  }

  async _resolveEpisode(episode, animeUrl) {
    const number = Number(episode.number);
    const id = Number(episode.id);
    if (!Number.isSafeInteger(number) || number < 0 || !Number.isSafeInteger(id) || id <= 0) return null;
    try {
      const response = await this._request(`/embed-url/${id}`, { referer: animeUrl, accept: 'text/plain,application/json,*/*' });
      const value = await response.text();
      let embedUrl = extractUrl(value, this.baseUrl);
      if (!embedUrl) {
        try { embedUrl = extractUrl(JSON.parse(value), this.baseUrl); } catch { /* response HTML/stringa */ }
      }
      if (!embedUrl) { this.lastDiscovery.errors.push({number,phase:'embed',message:'URL embed non trovato'}); return null; }
      let resolvedUrl = null;
      try {
        const embed = await this.fetch(embedUrl, { headers: { 'User-Agent': USER_AGENT, Referer: animeUrl }, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'follow' });
        if (embed.ok) {
          const contentType = embed.headers.get('content-type') || '';
          if (/^(video\/|audio\/)|mpegurl/i.test(contentType) || /octet-stream/i.test(contentType) && /\.(mp4|mkv|webm|m3u8)(?:\?|$)/i.test(embed.url || embedUrl)) {
            resolvedUrl = embed.url || embedUrl;
            await embed.body?.cancel();
          } else {
            const html = await readEmbedText(embed);
            resolvedUrl = extractUrl(html, embedUrl);
            if (!resolvedUrl) this.lastDiscovery.errors.push({number,phase:'resolve',message:'URL multimediale non estratto dall’embed'});
          }
        }
        else this.lastDiscovery.errors.push({number,phase:'resolve',message:`Embed HTTP ${embed.status}`});
      } catch (error) { this.lastDiscovery.errors.push({number,phase:'resolve',message:redact(error.message)}); }
      this.lastDiscovery.urlsFound = (this.lastDiscovery.urlsFound || 0) + 1;
      return { number, url: resolvedUrl || embedUrl, provider: 'animeunity', referer: embedUrl, resolverReferer: embedUrl,
        providerEpisodeId: id, foundAt: Date.now(), ...(resolvedUrl ? {resolvedAt:Date.now()} : {}), resolutionState: resolvedUrl ? 'resolved' : 'found' };
    } catch (error) { this.lastDiscovery.errors.push({number,phase:'episode',message:redact(error.message)}); return null; }
  }

  async getEpisodeSources(anime, { episodeNumbers } = {}) {
    this.lastDiscovery ||= {errors:[]};
    const animeUrl = validHttpUrl(anime.link || `/anime/${anime.id}-${anime.slug}`, `${this.baseUrl}/`);
    if (!animeUrl || new URL(animeUrl).origin !== new URL(this.baseUrl).origin) throw new Error('Pagina AnimeUnity non valida.');
    const response = await this._request(`/info_api/${Number(anime.id)}-${encodeURIComponent(anime.slug)}`, { referer: animeUrl });
    const info = await response.json();
    const pages = [];
    const total = Math.min(500, Math.max(0, Number(info.episodes_count || anime.episodeCount || 0)));
    for (let start = 0; start < total; start += 100) pages.push([start, Math.min(total, start + 100)]);
    const episodes = [];
    for (const [start, end] of pages) {
      const page = await this._request(`/info_api/${Number(anime.id)}-${encodeURIComponent(anime.slug)}/0?start_range=${start}&end_range=${end}`, { referer: animeUrl });
      const payload = await page.json();
      const items = Array.isArray(payload) ? payload : payload && (payload.episodes || payload.data);
      if (!Array.isArray(items)) throw new Error('Formato degli episodi AnimeUnity non riconosciuto.');
      episodes.push(...items);
    }
    const unique = [...new Map(episodes.map((ep) => [Number(ep.id), ep]).filter(([id]) => Number.isSafeInteger(id) && id > 0)).values()];
    this.lastDiscovery.episodesFound = unique.length;
    this.lastDiscovery.episodeNumbers = unique.map(ep => Number(ep.number));
    const selected = episodeNumbers ? unique.filter(ep => episodeNumbers.includes(Number(ep.number))) : unique;
    let cursor = 0;
    const results = [];
    await Promise.all(Array.from({ length: Math.min(this.concurrency, selected.length) }, async () => {
      while (cursor < selected.length) {
        const episode = selected[cursor++];
        const resolved = await this._resolveEpisode(episode, animeUrl);
        if (resolved) results.push(resolved);
      }
    }));
    return results.sort((a, b) => a.number - b.number);
  }

  async findSources({ titles, year, episodeCount, isAiring, episodeNumbers } = {}) {
    this.lastDiscovery = { status: 'title_not_found', errors: [], episodesFound: 0 };
    const aliases = (Array.isArray(titles) ? titles : [titles]).map((value) => String(value || '').trim()).filter(Boolean);
    if (!aliases.length) return [];
    const candidates = new Map();
    let completedQueries = 0; let lastError;
    for (const alias of aliases) {
      try { for (const item of await this.search(alias)) candidates.set(item.id, item); completedQueries++; }
      catch (error) { lastError = error; this.lastDiscovery.errors.push({phase:'search',message:redact(error.message)}); }
    }
    if (!completedQueries && lastError) throw lastError;
    const match = selectExactMatch([...candidates.values()], aliases, { year, episodeCount, isAiring });
    this.lastDiscovery.candidates = candidateDiagnostics([...candidates.values()], aliases, {year,episodeCount,isAiring}, match, titleKey);
    if (!match) return [];
    this.lastDiscovery.matchedTitle = match.title;
    const sources = await this.getEpisodeSources(match, { episodeNumbers });
    this.lastDiscovery.status = sources.length ? 'found' : this.lastDiscovery.errors.length ? 'provider_error' : 'episodes_not_found';
    return sources;
  }
}

module.exports = { AnimeUnityClient, parseSearchRecords, selectExactMatch, extractUrl, DEFAULT_BASE_URL };
