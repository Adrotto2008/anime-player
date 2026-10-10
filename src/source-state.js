'use strict';

// Diagnostics must never retain query credentials, including URLs printed by mpv.
function redact(value) {
  return String(value || '').replace(/https?:\/\/[^\s"'<>]+/gi, text => {
    try { const url = new URL(text); return `${url.origin}${url.pathname}${url.search ? '?[redacted]' : ''}`; }
    catch { return '[URL redacted]'; }
  }).replace(/\b(token|signature|sig|expires|authorization)=([^\s&]+)/gi, '$1=[redacted]');
}

function urlLifetime(value) {
  try {
    const url = new URL(value);
    const temporary = [...url.searchParams.keys()].some(key => /^(token|expires?|expiry|exp|signature|sig|policy|key-pair-id|x-amz-.+)$/i.test(key));
    const raw = ['expires', 'expire', 'expiry', 'exp'].map(key => url.searchParams.get(key)).find(Boolean);
    const n = Number(raw);
    const expiresAt = Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : null;
    return { temporary, expiresAt };
  } catch { return { temporary: false, expiresAt: null }; }
}

function sourceMetadata(source) {
  return {
    ...require('./source-language').metadata(source),
    ...(['found', 'resolved'].includes(source.resolutionState) ? { resolutionState: source.resolutionState } : {}),
    ...(source.provider === 'animeunity' && Number.isSafeInteger(source.providerEpisodeId) && source.providerEpisodeId > 0 ? { providerEpisodeId: source.providerEpisodeId } : {}),
    ...(source.provider === 'animeworld' && /^[\w-]{1,100}$/.test(String(source.providerEpisodeId || '')) ? { providerEpisodeId: String(source.providerEpisodeId) } : {}),
    ...(Number(source.resolvedAt) > 0 ? { resolvedAt: Number(source.resolvedAt) } : {}),
    ...(Number(source.foundAt) > 0 ? { foundAt: Number(source.foundAt) } : {}),
    ...(typeof source.resolverReferer === 'string' && /^https?:\/\//i.test(source.resolverReferer) ? {resolverReferer:source.resolverReferer} : {}),
    ...urlLifetime(source.url),
    ...(Number(source.playbackFailedAt) > 0 ? { playbackFailedAt: Number(source.playbackFailedAt), playbackError: redact(source.playbackError).slice(0, 1000), playbackExitCode: Number.isInteger(source.playbackExitCode) ? source.playbackExitCode : null } : {}),
  };
}

const { candidateDiagnostics } = require('./source-match');

module.exports = { redact, urlLifetime, sourceMetadata, candidateDiagnostics };

// Verified provider spellings for these AniList identities, not a fuzzy rule
// removing season/part numbers from arbitrary titles. Year/count checks still apply.
const providerAliases = {
  195604: ['Black Clover 2'],
  108632: ['Re:Zero kara Hajimeru Isekai Seikatsu 2', 'Re:ZERO -Starting Life in Another World- 2'],
  119661: ['Re:Zero kara Hajimeru Isekai Seikatsu 2 Part 2', 'Re:ZERO -Starting Life in Another World- 2 Part 2'],
  163134: ['Re:Zero kara Hajimeru Isekai Seikatsu 3', 'Re:ZERO -Starting Life in Another World- 3'],
  189046: ['Re:Zero kara Hajimeru Isekai Seikatsu 4', 'Re:ZERO -Starting Life in Another World- 4'],
};
function providerTitles(series, titles = []) {
  return [...new Set([series.title, series.altTitle, ...(series.titleAliases || []), ...titles,
    ...(providerAliases[series.anilistId] || [])].filter(Boolean))];
}
module.exports.providerTitles = providerTitles;

async function readEmbedText(response, limit = 512 * 1024) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (text.length > limit) throw new Error('Risposta embed troppo grande');
    return text;
  }
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let bytes = 0; let text = '';
  try {
    while (true) {
      const {value,done} = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error('Risposta embed troppo grande');
      text += decoder.decode(value, {stream:true});
    }
    return text + decoder.decode();
  } finally { await reader.cancel(); }
}
module.exports.readEmbedText = readEmbedText;
