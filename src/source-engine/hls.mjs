import { LabError, invariant } from './errors.mjs';

export function attributes(text) {
  const out = Object.create(null);
  let i = 0;
  while (i < text.length) {
    while (text[i] === ',' || /\s/.test(text[i] || '') && i < text.length) i++;
    if (i >= text.length) break;
    const key = text.slice(i).match(/^[A-Z0-9-]+/)?.[0];
    invariant(key, 'invalid_hls_attributes'); i += key.length;
    invariant(text[i++] === '=', 'invalid_hls_attributes');
    let value;
    if (text[i] === '"') {
      const start = ++i;
      while (i < text.length && text[i] !== '"') i++;
      invariant(i < text.length, 'invalid_hls_attributes');
      value = text.slice(start, i++);
    } else {
      const start = i; while (i < text.length && text[i] !== ',') i++;
      value = text.slice(start, i).trim();
    }
    invariant(out[key] === undefined, 'duplicate_hls_attribute');
    out[key] = value;
    invariant(i >= text.length || text[i] === ',', 'invalid_hls_attributes');
  }
  return out;
}

const numeric = value => {
  const n = Number(value);
  return value !== '' && value != null && Number.isFinite(n) && n >= 0 ? n : null;
};
const url = (uri, base) => {
  const u = new URL(uri, base);
  invariant(['https:', 'http:'].includes(u.protocol) && !u.username && !u.password, 'unsupported_media_uri');
  return u.href;
};
function byteRange(raw, previous, resource) {
  const m = String(raw).match(/^(\d+)(?:@(\d+))?$/);
  invariant(m, 'invalid_byte_range');
  const length = Number(m[1]), offset = m[2] != null ? Number(m[2])
    : previous && previous.uri === resource ? previous.offset + previous.length : null;
  invariant(Number.isSafeInteger(length) && length > 0 && Number.isSafeInteger(offset)
    && offset >= 0 && Number.isSafeInteger(offset + length), 'invalid_byte_range');
  return { length, offset, uri: resource };
}

export function parseHls(text, base) {
  invariant(Buffer.byteLength(text) <= 4 * 1024 * 1024, 'response_too_large');
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  invariant(lines[0] === '#EXTM3U', 'not_hls');
  const variants = [], renditions = [], segments = [];
  let pendingVariant = null, duration = null, range = null, lastRange = null,
    key = null, map = null, sequence = 0, sequenceSeen = false, discontinuity = false, endList = false;
  for (const l of lines.slice(1)) {
    if (l.startsWith('#EXT-X-STREAM-INF:')) {
      invariant(!pendingVariant && duration == null, 'invalid_hls');
      pendingVariant = attributes(l.slice(l.indexOf(':') + 1));
    } else if (l.startsWith('#EXT-X-MEDIA:')) {
      const a = attributes(l.slice(l.indexOf(':') + 1));
      invariant(a.TYPE && a['GROUP-ID'] && a.NAME, 'invalid_hls');
      renditions.push({ type: a.TYPE.toLowerCase(), group: a['GROUP-ID'], name: a.NAME,
        language: canonicalLanguage(a.LANGUAGE || a.NAME), uri: a.URI ? url(a.URI, base) : null,
        default: a.DEFAULT === 'YES', forced: a.FORCED === 'YES' });
    } else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      invariant(!segments.length && !sequenceSeen, 'invalid_hls_sequence');
      sequence = numeric(l.split(':')[1]); sequenceSeen = true;
      invariant(Number.isSafeInteger(sequence), 'invalid_hls_sequence');
    } else if (l.startsWith('#EXTINF:')) {
      invariant(duration == null, 'invalid_hls');
      duration = numeric(l.slice(8).split(',')[0]);
      invariant(duration != null && duration > 0, 'invalid_hls_duration');
    } else if (l.startsWith('#EXT-X-BYTERANGE:')) {
      invariant(range == null, 'invalid_byte_range'); range = l.split(':')[1];
    } else if (l.startsWith('#EXT-X-KEY:')) {
      const a = attributes(l.slice(l.indexOf(':') + 1));
      if (a.METHOD === 'NONE') key = null;
      else {
        invariant(a.METHOD === 'AES-128' && (!a.KEYFORMAT || a.KEYFORMAT === 'identity'), 'drm_or_encryption_unsupported');
        invariant(a.URI && (!a.IV || /^0x[0-9a-f]{1,32}$/i.test(a.IV)), 'invalid_hls_key');
        key = { method: a.METHOD, uri: url(a.URI, base), iv: a.IV || null };
      }
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = attributes(l.slice(l.indexOf(':') + 1)); invariant(a.URI, 'invalid_hls_map');
      const uri = url(a.URI, base);
      // Encrypted initialization sections require an explicit IV.
      invariant(!key || key.iv, 'encrypted_map_iv_missing');
      map = { uri, range: a.BYTERANGE ? byteRange(a.BYTERANGE, map?.range, uri) : null,
        key: key ? { ...key } : null };
    } else if (l === '#EXT-X-DISCONTINUITY') discontinuity = true;
    else if (l === '#EXT-X-ENDLIST') endList = true;
    else if (l.startsWith('#EXT-X-GAP')) throw new LabError('hls_gap');
    else if (l.startsWith('#EXT-X-DEFINE:') || l.startsWith('#EXT-X-SESSION-KEY:'))
      throw new LabError('hls_feature_unsupported');
    else if (!l.startsWith('#')) {
      invariant(!endList, 'invalid_hls');
      const uri = url(l, base);
      if (pendingVariant) {
        const a = pendingVariant, res = a.RESOLUTION?.match(/^(\d+)x(\d+)$/);
        variants.push({ uri, width: res ? Number(res[1]) : null, height: res ? Number(res[2]) : null,
          bandwidth: numeric(a['AVERAGE-BANDWIDTH']) ?? numeric(a.BANDWIDTH),
          frameRate: numeric(a['FRAME-RATE']), codecs: a.CODECS || '', audioGroup: a.AUDIO || null,
          subtitleGroup: a.SUBTITLES || null });
        pendingVariant = null;
      } else {
        invariant(duration != null && !variants.length, 'invalid_hls');
        const r = range ? byteRange(range, lastRange, uri) : null;
        segments.push({ uri, duration, sequence: sequence + segments.length, range: r,
          key: key ? { ...key } : null, map: map ? { ...map } : null, discontinuity });
        invariant(segments.length <= 20000, 'segment_budget_exceeded');
        lastRange = r; duration = null; range = null; discontinuity = false;
      }
    }
  }
  invariant(!pendingVariant && duration == null && range == null, 'hls_incomplete');
  invariant(variants.length || segments.length, 'hls_empty');
  return { kind: variants.length ? 'master' : 'media', url: base, variants, renditions, segments,
    endList, duration: segments.reduce((sum, s) => sum + s.duration, 0) };
}

export function canonicalLanguage(value) {
  if (!value) return null;
  const v = String(value).toLowerCase();
  return { it: 'it', ita: 'it', italiano: 'it', italian: 'it', ja: 'ja', jp: 'ja', jpn: 'ja',
    japanese: 'ja', en: 'en', eng: 'en', english: 'en', fr: 'fr', fra: 'fr', de: 'de', deu: 'de',
    es: 'es', spa: 'es' }[v] || v;
}

export function selectVariant(master, { maxHeight = Infinity, audio, subtitles,
  codecPrefixes = ['avc1', 'avc3', 'hvc1', 'hev1', 'vp09', 'av01'] } = {}) {
  invariant(master.kind === 'master', 'master_required');
  const candidates = master.variants.filter(v => (!v.height || v.height <= maxHeight)
    && (!v.codecs || v.codecs.split(',').some(c => codecPrefixes.some(p => c.trim().startsWith(p)))));
  const eligible = candidates.map(v => {
    const audioTracks = master.renditions.filter(r => r.type === 'audio' && r.group === v.audioGroup);
    const subtitleTracks = master.renditions.filter(r => r.type === 'subtitles' && r.group === v.subtitleGroup);
    const wantedAudio = audio ? audioTracks.filter(r => r.language === canonicalLanguage(audio)) : audioTracks;
    const wantedSubs = subtitles ? subtitleTracks.filter(r => r.language === canonicalLanguage(subtitles)) : subtitleTracks;
    return { variant: v, audio: wantedAudio, subtitles: wantedSubs,
      audioPendingProbe: !!audio && audioTracks.length === 0,
      eligible: (!audio || wantedAudio.length > 0 || audioTracks.length === 0)
        && (!subtitles || wantedSubs.length > 0) };
  }).filter(v => v.eligible);
  invariant(eligible.length, audio || subtitles ? 'requested_tracks_unproven' : 'quality_unavailable');
  eligible.sort((a, b) => (b.variant.height || 0) - (a.variant.height || 0)
    || (b.variant.width || 0) - (a.variant.width || 0)
    || (b.variant.bandwidth || 0) - (a.variant.bandwidth || 0)
    || (b.variant.frameRate || 0) - (a.variant.frameRate || 0)
    || a.variant.uri.localeCompare(b.variant.uri));
  return { ...eligible[0], state: 'manifest_quality_declared' };
}

export async function inspectHls(client, source, options = {}) {
  const r = await client.request(source.url, { headers: source.headers, signal: options.signal });
  const master = parseHls(r.text, r.url);
  if (master.kind === 'media') {
    invariant(!options.subtitles, 'requested_tracks_unproven');
    return { source, master: null, variant: null, media: master, audio: [], subtitles: [],
      audioPendingProbe: !!options.audio, state: 'media_playlist_verified' };
  }
  const selected = selectVariant(master, options);
  const p = await client.request(selected.variant.uri, { headers: source.headers, signal: options.signal });
  const media = parseHls(p.text, p.url); invariant(media.kind === 'media', 'nested_master_unsupported');
  const tracks = async list => Promise.all(list.filter(t => t.uri).map(async t => {
    const r = await client.request(t.uri, { headers: source.headers, signal: options.signal });
    const m = parseHls(r.text, r.url); invariant(m.kind === 'media', 'track_schema_changed');
    return { ...t, media: m };
  }));
  return { source, master, variant: selected.variant, media,
    audio: await tracks(selected.audio), subtitles: await tracks(selected.subtitles),
    audioPendingProbe: selected.audioPendingProbe, state: 'media_playlist_verified' };
}
