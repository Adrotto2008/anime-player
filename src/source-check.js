'use strict';

const { isIP } = require('node:net');
const { lookup } = require('node:dns/promises');

function isPublicIp(value) {
  const host = String(value || '').toLowerCase().replace(/^\[|\]$/g, '');
  const version = isIP(host);
  if (version === 4) {
    const octets = host.split('.').map(Number);
    const [a, b, c] = octets;
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (version === 6) {
    if (host.startsWith('::ffff:')) return isPublicIp(host.slice(7));
    return /^[23]/.test(host) && !host.startsWith('2001:db8:');
  }
  return false;
}

function isPublicHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  return isIP(host) ? isPublicIp(host) : !host.endsWith('.internal');
}

async function checkSource(url, { fetchImpl = globalThis.fetch, lookupImpl = lookup, timeoutMs = 7000 } = {}) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { return { status: 'invalid' }; }
  if (!['http:', 'https:'].includes(parsed.protocol) || !isPublicHostname(parsed.hostname)) return { status: 'unsupported' };
  try {
    if (!isIP(parsed.hostname)) {
      let dnsTimer;
      const addresses = await Promise.race([
        lookupImpl(parsed.hostname, { all: true, verbatim: true }),
        new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(new Error('DNS timeout')), timeoutMs); }),
      ]).finally(() => clearTimeout(dnsTimer));
      if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address))) return { status: 'unsupported' };
    }
    let response = await fetchImpl(parsed.toString(), { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if ([405, 501].includes(response.status)) {
      response = await fetchImpl(parsed.toString(), { method: 'GET', headers: { Range: 'bytes=0-0' }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      if (response.body && typeof response.body.cancel === 'function') await response.body.cancel().catch(() => {});
    }
    if (response.status >= 200 && response.status < 300) return { status: 'available', httpStatus: response.status };
    if (response.status >= 300 && response.status < 400) return { status: 'redirect', httpStatus: response.status };
    if ([404, 410].includes(response.status)) return { status: 'missing', httpStatus: response.status };
    if (response.status >= 400) return { status: 'unknown', httpStatus: response.status };
    return { status: 'unknown', httpStatus: response.status };
  } catch { return { status: 'unreachable' }; }
}

async function checkSources(urls, options) {
  const list = Array.isArray(urls) ? urls.slice(0, 100) : [];
  const results = Array.from({ length: list.length }, () => ({ status: 'unknown' }));
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, list.length, 40) }, async () => {
    while (cursor < Math.min(list.length, 40)) {
      const index = cursor++;
      results[index] = await checkSource(list[index], options);
    }
  }));
  return results;
}

module.exports = { checkSource, checkSources, isPublicHostname, isPublicIp };
