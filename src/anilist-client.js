'use strict';

// One shared queue covers search, franchise traversal and metadata refreshes.
// AniList's documented degraded limit is 30/minute, with an additional burst limit.
function createAniListClient({ fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), intervalMs = 2200,
  maxWaitMs = 90000, maxRetries = 2, cacheMs = 5 * 60 * 1000 } = {}) {
  let tail = Promise.resolve(); let nextAt = 0; let blockedUntil = 0; let spacing = intervalMs;
  const pending = new Map(); const media = new Map(); const searches = new Map();
  const copy = value => structuredClone(value);
  const read = (cache, key) => {
    const entry = cache.get(key);
    if (!entry || entry.expiresAt <= now()) { cache.delete(key); return null; }
    return copy(entry.value);
  };
  const remember = data => {
    for (const item of [data?.Media, ...(data?.Page?.media || [])]) {
      if (item?.id) media.set(Number(item.id), { value: copy(item), expiresAt: now() + cacheMs });
    }
    while (media.size > 300) media.delete(media.keys().next().value);
  };
  const cooldown = headers => {
    const retry = headers?.get('retry-after'); const reset = Number(headers?.get('x-ratelimit-reset'));
    const seconds = retry == null ? NaN : Number(retry);
    const retryAt = Number.isFinite(seconds) ? now() + Math.max(0, seconds) * 1000 : Date.parse(retry);
    const resetAt = Number.isFinite(reset) && reset > 0 ? reset * 1000 : 0;
    const deadline = Math.max(Number.isFinite(retryAt) ? retryAt : 0, resetAt);
    return deadline >= now() ? Math.max(deadline, now() + 1000) : now() + 60000;
  };
  const rateError = () => {
    const seconds = Math.max(1, Math.ceil((blockedUntil - now()) / 1000));
    return Object.assign(new Error(`AniList ha raggiunto il limite di richieste. Riprova tra ${seconds} secondi.`), { status: 429, retryAfter: seconds });
  };
  async function run(query, variables) {
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      const delay = Math.max(0, nextAt - now(), blockedUntil - now());
      if (waited + delay > maxWaitMs) throw rateError();
      if (delay) { await sleep(delay); waited += delay; }
      const startedAt = now();
      nextAt = startedAt + spacing;
      const response = await fetchImpl('https://graphql.anilist.co', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15000),
      });
      const limit = Number(response.headers?.get('x-ratelimit-limit'));
      if (limit > 0) spacing = Math.max(intervalMs, Math.ceil(60000 / limit) + 100);
      nextAt = Math.max(nextAt, startedAt + spacing);
      let payload;
      if (response.ok) payload = await response.json();
      const throttled = response.status === 429 || payload?.errors?.some(error => Number(error.status) === 429);
      if (throttled) {
        const hasTiming = response.headers?.get('retry-after') != null || response.headers?.get('x-ratelimit-reset') != null;
        blockedUntil = Math.max(blockedUntil, hasTiming ? cooldown(response.headers) : now() + 60000);
        if (!response.ok) await response.body?.cancel();
        if (attempt >= maxRetries) throw rateError();
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`AniList ha risposto ${response.status}`); }
      const remaining = response.headers?.get('x-ratelimit-remaining');
      if (remaining != null && Number(remaining) === 0) {
        const reset = Number(response.headers?.get('x-ratelimit-reset')) * 1000;
        blockedUntil = Math.max(blockedUntil, reset > now() ? reset : now() + 60000);
      }
      if (payload?.errors?.length) throw new Error(payload.errors[0].message);
      if (!payload?.data) throw new Error('Risposta AniList senza metadati.');
      remember(payload.data);
      return payload.data;
    }
  }
  function request(query, variables) {
    const key = JSON.stringify([query, variables]);
    const cached = read(searches, key);
    if (cached) return Promise.resolve(cached);
    if (pending.has(key)) return pending.get(key).then(copy);
    const task = tail.then(() => run(query, variables));
    tail = task.catch(() => {});
    const promise = task.then(data => {
      if (variables?.s != null) {
        searches.set(key, { value: copy(data), expiresAt: now() + 60000 });
        while (searches.size > 50) searches.delete(searches.keys().next().value);
      }
      return data;
    }).finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise.then(copy);
  }
  return { request, getMedia: id => read(media, Number(id)) };
}

module.exports = { createAniListClient };
