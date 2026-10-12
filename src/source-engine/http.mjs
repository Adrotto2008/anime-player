import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { setTimeout as pause } from 'node:timers/promises';
import { CookieJar } from 'tough-cookie';
import { LabError, invariant } from './errors.mjs';

export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function isPrivateAddress(address) {
  const s = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (s.startsWith('::ffff:')) return isPrivateAddress(s.slice(7));
  if (isIP(s) === 4) {
    const [a, b] = s.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0))
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
  }
  if (isIP(s) === 6) return s === '::' || s === '::1' || /^f[cd]/.test(s)
    || /^fe[89ab]/.test(s) || s.startsWith('ff');
  return true;
}

export class UrlPolicy {
  constructor({ allowedHosts = [], allowLocal = false } = {}) {
    this.allowedHosts = allowedHosts.map(h => h.toLowerCase());
    this.allowLocal = allowLocal;
  }
  async resolve(value) {
    let u;
    try { u = new URL(value); } catch { throw new LabError('invalid_url'); }
    invariant(['http:', 'https:'].includes(u.protocol), 'unsupported_protocol');
    invariant(!u.username && !u.password, 'url_credentials_rejected');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    invariant(!this.allowedHosts.length || this.allowedHosts.some(h => h.startsWith('*.')
      ? host.endsWith(h.slice(1)) && host !== h.slice(2) : host === h), 'host_not_allowed');
    if (!this.allowLocal) {
      invariant(u.protocol === 'https:', 'https_required');
      invariant(!u.port || u.port === '443', 'port_rejected');
    }
    let addresses;
    try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true }); }
    catch { throw new LabError('dns_failed'); }
    invariant(addresses.length && (this.allowLocal || addresses.every(a => !isPrivateAddress(a.address))), 'private_address_rejected');
    return { url: u, addresses };
  }
}

function headerGet(headers, key) {
  const k = Object.keys(headers).find(h => h.toLowerCase() === key.toLowerCase());
  return k ? headers[k] : undefined;
}

export class HttpClient {
  constructor({ policy = new UrlPolicy(), timeoutMs = 15000, attempts = 3,
    delay = (ms, signal) => pause(ms, undefined, { signal }), random = Math.random } = {}) {
    this.policy = policy;
    this.timeoutMs = timeoutMs;
    this.attempts = attempts;
    this.jar = new CookieJar();
    this.delay = delay;
    this.random = random;
  }
  async once(value, { method = 'GET', headers = {}, body, signal, requestTimeoutMs = this.timeoutMs } = {}) {
    const { url, addresses } = await this.policy.resolve(value);
    signal?.throwIfAborted();
    const h = { 'User-Agent': USER_AGENT, Accept: '*/*', 'Accept-Encoding': 'identity', ...headers };
    const cookie = await this.jar.getCookieString(url.href);
    if (cookie && !headerGet(h, 'cookie')) h.Cookie = cookie;
    if (body != null && !headerGet(h, 'content-length')) h['Content-Length'] = Buffer.byteLength(body);
    // Pin the validated DNS answer to this request, including redirects.
    const address = addresses.find(a => a.family === 4) || addresses[0];
    return new Promise((resolve, reject) => {
      let deadline, upstream;
      const req = (url.protocol === 'https:' ? https : http).request(url, {
        method, headers: h, signal,
        lookup: (_host, options, cb) => options?.all
          ? cb(null, [address]) : cb(null, address.address, address.family),
      }, res => {
        upstream=res;
        res.on('error', () => {});
        res.once('close', () => clearTimeout(deadline));
        res.finalUrl = url.href;
        resolve(res);
      });
      const timeout=()=>{const error=new LabError('network_timeout');if(upstream)upstream.transferError=error;req.destroy(error);};
      deadline = setTimeout(timeout, requestTimeoutMs);
      req.setTimeout(this.timeoutMs, timeout);
      req.on('error', e => { clearTimeout(deadline); reject(e.name === 'AbortError' ? new LabError('cancelled')
        : e instanceof LabError ? e : /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(e.code || '')
          ? new LabError('tls_validation_failed') : new LabError('network_error')); });
      req.end(body);
    });
  }
  async open(value, options = {}) {
    let url = String(value), opts = { ...options, headers: { ...options.headers } };
    for (let redirects = 0; redirects <= 5; redirects++) {
      let res;
      for (let attempt = 0; attempt < (opts.attempts ?? this.attempts); attempt++) {
        try { res = await this.once(url, opts); }
        catch (error) {
          if (!['network_error', 'network_timeout'].includes(error.code)
            || attempt + 1 === (opts.attempts ?? this.attempts)) throw error;
          await this.delay(200 * 2 ** attempt + Math.floor(this.random() * 100), opts.signal);
          continue;
        }
        for (const c of res.headers['set-cookie'] || []) {
          try { await this.jar.setCookie(c, url); } catch { /* Invalid cookies are ignored. */ }
        }
        if (![408, 425, 429].includes(res.statusCode) && res.statusCode < 500) break;
        if (attempt + 1 === (opts.attempts ?? this.attempts)) break;
        const retryAfter = res.headers['retry-after'];
        let delay = /^\d+$/.test(retryAfter || '') ? Number(retryAfter) * 1000
          : Math.max(0, Date.parse(retryAfter || '') - Date.now()) || 200 * 2 ** attempt;
        res.destroy();
        // Long rate limits are returned, so callers can defer instead of hammering.
        invariant(delay <= 10000, 'rate_limited');
        await this.delay(delay + Math.floor(this.random() * 100), opts.signal);
      }
      invariant(res, 'network_error');
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        invariant(redirects < 5, 'redirect_limit');
        const next = new URL(res.headers.location, url);
        if (new URL(url).protocol === 'https:' && next.protocol !== 'https:')
          throw new LabError('redirect_downgrade');
        if (next.origin !== new URL(url).origin) {
          // CookieJar will independently apply only the new origin's cookies.
          opts.headers = Object.fromEntries(Object.entries(opts.headers)
            .filter(([k]) => !/^(authorization|cookie|host|.*csrf.*|origin)$/i.test(k)));
        }
        if (res.statusCode === 303 || ([301, 302].includes(res.statusCode) && opts.method === 'POST')) {
          opts.method = 'GET'; delete opts.body;
          opts.headers = Object.fromEntries(Object.entries(opts.headers).filter(([k]) => !/^content-/i.test(k)));
        }
        res.destroy(); url = next.href; continue;
      }
      return res;
    }
    throw new LabError('redirect_limit');
  }
  async request(value, { maxBytes = 4 * 1024 * 1024, allowStatuses = [], ...options } = {}) {
    const res = await this.open(value, options);
    const status = res.statusCode;
    if (!(status >= 200 && status < 300) && !allowStatuses.includes(status)) {
      res.destroy(); throw new LabError(status === 429 ? 'rate_limited' : 'http_error', 'http_error', { status });
    }
    const chunks = []; let bytes = 0;
    try {
      for await (const chunk of res) {
        bytes += chunk.length;
        invariant(bytes <= maxBytes, 'response_too_large');
        chunks.push(chunk);
      }
    } catch (e) {
      res.destroy();
      throw options.signal?.aborted ? new LabError('cancelled') : res.transferError || (e instanceof LabError ? e : new LabError('body_incomplete'));
    }
    return { status, headers: res.headers, url: res.finalUrl, buffer: Buffer.concat(chunks),
      text: Buffer.concat(chunks).toString('utf8') };
  }
  async json(value, options) {
    const r = await this.request(value, options);
    try { return { ...r, data: JSON.parse(r.text) }; }
    catch { throw new LabError('invalid_json'); }
  }
}
