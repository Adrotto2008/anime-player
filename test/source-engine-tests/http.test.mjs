import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient, UrlPolicy, isPrivateAddress } from '../../src/source-engine/http.mjs';
import { localServer, localClient } from './helpers.mjs';

test('public URL policy rejects localhost, credentials, HTTP and unsupported schemes', async () => {
  const policy = new UrlPolicy();
  for (const u of ['https://127.0.0.1/', 'https://[::1]/', 'https://localhost/',
    'https://user:password@example.org/', 'http://example.org/', 'file:///C:/secret']) {
    await assert.rejects(policy.resolve(u));
  }
  for (const a of ['10.0.0.1', '172.16.1.2', '192.168.0.1', '169.254.1.1', '::ffff:127.0.0.1', 'fd12::1']) assert(isPrivateAddress(a));
  assert.equal(isPrivateAddress('8.8.8.8'), false);
});
test('optional hostname allowlist uses a suffix boundary', async () => {
  const p = new UrlPolicy({ allowedHosts: ['*.example.org'] });
  await assert.rejects(p.resolve('https://evil-example.org/'), { code: 'host_not_allowed' });
});
test('429 and 5xx retry boundedly, 403 is not retried', async () => {
  const hits = new Map();
  const s = await localServer((req, res) => {
    const n = (hits.get(req.url) || 0) + 1; hits.set(req.url, n);
    if (req.url === '/busy' && n <= 2) { res.writeHead(n === 1 ? 429 : 503, { 'Retry-After': '0' }); res.end(); }
    else if (req.url === '/blocked') { res.writeHead(403); res.end('Denied'); }
    else res.end('ok');
  });
  try {
    const c = localClient();
    assert.equal((await c.request(s.base + '/busy')).text, 'ok'); assert.equal(hits.get('/busy'), 3);
    await assert.rejects(c.request(s.base + '/blocked'), { code: 'http_error' }); assert.equal(hits.get('/blocked'), 1);
  } finally { await s.close(); }
});
test('session cookies are scoped and CSRF credentials are stripped across hosts', async () => {
  let received;
  const s2 = await localServer((req, res) => { received = req.headers; res.end('ok'); });
  const s1 = await localServer((_req, res) => {
    res.writeHead(302, { Location: s2.base.replace('127.0.0.1', 'localhost') + '/end',
      'Set-Cookie': 'private=session; Path=/' }); res.end();
  });
  try {
    await localClient().request(s1.base + '/start', { headers: { Authorization: 'Bearer secret',
      Cookie: 'explicit=secret', 'X-CSRF-TOKEN': 'secret', Origin: s1.base } });
    assert.equal(received.authorization, undefined); assert.equal(received.cookie, undefined);
    assert.equal(received['x-csrf-token'], undefined); assert.equal(received.origin, undefined);
  } finally { await s1.close(); await s2.close(); }
});
test('truncated response and bounded body are failures', async () => {
  const s = await localServer((req, res) => {
    if (req.url === '/cut') { res.writeHead(200, { 'Content-Length': 100 }); res.write('abc'); setTimeout(() => res.destroy(), 15); }
    else res.end('x'.repeat(1000));
  });
  try {
    const c = localClient();
    await assert.rejects(c.request(s.base + '/cut'), { code: 'body_incomplete' });
    await assert.rejects(c.request(s.base + '/big', { maxBytes: 100 }), { code: 'response_too_large' });
  } finally { await s.close(); }
});
test('total deadline handles endless slow bodies', async () => {
  const timers = [];
  const s = await localServer((_req, res) => {
    res.writeHead(200); timers.push(setInterval(() => res.write('x'), 10));
  });
  // Whether the deadline expires before headers or mid-body, the same typed
  // timeout is required. Abrupt server truncation has its own separate test.
  try { await assert.rejects(localClient({ timeoutMs: 80, attempts: 1 }).request(s.base), { code: 'network_timeout' }); }
  finally { timers.forEach(clearInterval); await s.close(); }
});
test('abort signal stops the request', async () => {
  const s = await localServer((_req, _res) => {});
  try {
    const controller = new AbortController(), c = localClient();
    const p = c.request(s.base, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(p, { code: 'cancelled' });
  } finally { await s.close(); }
});
test('unbounded Retry-After is returned without aggressive retries', async () => {
  let hits = 0;
  const s = await localServer((_req, res) => { hits++; res.writeHead(429, { 'Retry-After': '3600' }); res.end(); });
  try { await assert.rejects(localClient().request(s.base), { code: 'rate_limited' }); assert.equal(hits, 1); }
  finally { await s.close(); }
});
