(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SourceLanguage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MODES = ['auto', 'it', 'ja-sub-it'];
  const lang = value => ({ ita: 'it', jpn: 'ja', jp: 'ja', eng: 'en', und: null })[String(value || '').toLowerCase()]
    ?? (/^[a-z]{2}(?:-[a-z0-9]+)?$/i.test(value || '') ? String(value).toLowerCase() : null);
  function preference(value) {
    return value && MODES.includes(value.mode) ? { mode: value.mode, updatedAt: Number.isFinite(Number(value.updatedAt)) ? Math.max(0, Number(value.updatedAt)) : 0 } : null;
  }
  function mergePreference(a, b) {
    const x = preference(a); const y = preference(b);
    if (!x) return y; if (!y) return x;
    return x.updatedAt === y.updatedAt ? (x.mode.localeCompare(y.mode) >= 0 ? x : y) : x.updatedAt > y.updatedAt ? x : y;
  }
  function classification(value) {
    if (!value || !['provider', 'release-name', 'manual'].includes(value.origin) || !['declared', 'suggested'].includes(value.confidence)) return null;
    const audio = lang(value.audio); const subtitles = lang(value.subtitles);
    return audio || subtitles ? { audio, subtitles, origin: value.origin, confidence: value.confidence } : null;
  }
  function tracks(value) {
    if (!value || !Number.isFinite(Number(value.checkedAt))) return null;
    const valid = list => (Array.isArray(list) ? list : []).filter(t => Number.isInteger(t.id) && t.id > 0)
      .slice(0, 100).map(t => ({ id: t.id, lang: lang(t.lang) }));
    return { audio: valid(value.audio), subtitles: valid(value.subtitles), checkedAt: Number(value.checkedAt), origin: 'mpv' };
  }
  function classifyProvider(candidate, source) {
    if (candidate.dub === true) return { audio: 'it', subtitles: null, origin: 'provider', confidence: 'declared' };
    if (candidate.dub === false) return { audio: lang(candidate.audioLanguage) || 'ja', subtitles: 'it', origin: 'provider', confidence: 'suggested' };
    let name = '';
    try { const url = new URL(source.url); name = decodeURIComponent(url.searchParams.get('filename') || url.pathname); } catch {}
    if (/(?:^|[_\s.-])SUB[_\s-]?ITA(?:[_\s.-]|$)/i.test(name)) return { audio: 'ja', subtitles: 'it', origin: 'release-name', confidence: 'suggested' };
    if (/(?:^|[_\s.-])ITA(?:[_\s.-]|$)/i.test(name)) return { audio: 'it', subtitles: null, origin: 'release-name', confidence: 'suggested' };
    return null;
  }
  function manualClassification(mode) {
    return mode === 'it' ? { audio: 'it', subtitles: null, origin: 'manual', confidence: 'declared' }
      : mode === 'ja-sub-it' ? { audio: 'ja', subtitles: 'it', origin: 'manual', confidence: 'declared' } : null;
  }
  function modesFor(source) {
    const c = classification(source.language); const observed = tracks(source.mediaTracks);
    const audio = observed?.audio.map(t => t.lang).filter(Boolean) || [];
    // A container tag is metadata, not speech recognition. A declared version
    // with only one audio track remains that version even if its tag is wrong.
    const declaredSingle = observed?.audio.length === 1 && c?.confidence === 'declared' && Boolean(c.audio);
    const supportsAudio = wanted => declaredSingle ? c.audio === wanted : audio.length ? audio.includes(wanted) : c?.audio === wanted;
    const subIt = observed?.subtitles.some(t => t.lang === 'it') || c?.subtitles === 'it';
    return ['it', 'ja-sub-it'].filter(mode => mode === 'it' ? supportsAudio('it') : supportsAudio('ja') && subIt);
  }
  const usable = source => Boolean(source?.url) && source.resolutionState !== 'found';
  function eligible(source, mode) { return mode === 'auto' || usable(source) && (mode === 'unknown' ? !modesFor(source).length : modesFor(source).includes(mode)); }
  function sourceIdentity(source) {
    return source.provider && source.providerEpisodeId != null
      ? `${source.provider}:${source.providerEpisodeId}:${source.providerSourceId || ''}` : null;
  }
  function rankSources(sources, mode) {
    return sources.map((source, index) => ({ source, index })).filter(item => eligible(item.source, mode))
      .sort((a, b) => mode === 'auto' ? a.index - b.index
        : (a.source.provider === 'animeunity' ? 0 : a.source.provider === 'animeworld' ? 1 : 2)
          - (b.source.provider === 'animeunity' ? 0 : b.source.provider === 'animeworld' ? 1 : 2) || a.index - b.index);
  }
  function availability(series) {
    const episodes = series.episodes || [];
    return Object.fromEntries(['it', 'ja-sub-it', 'unknown'].map(mode => [mode, episodes.filter(ep => (ep.sources || []).some(source => usable(source) && eligible(source, mode))).length]));
  }
  function metadata(source) {
    const c = classification(source.language); const t = tracks(source.mediaTracks);
    return { ...(c ? { language: c } : {}), ...(t ? { mediaTracks: t } : {}),
      ...(typeof source.providerTitleUrl === 'string' && /^https?:\/\//i.test(source.providerTitleUrl) ? { providerTitleUrl: source.providerTitleUrl } : {}),
      ...(typeof source.providerSourceId === 'string' && /^[\w-]{1,100}$/.test(source.providerSourceId) ? { providerSourceId: source.providerSourceId } : {}) };
  }
  function observedTracks(list) {
    const valid = type => list.filter(t => t.type === type).map(t => ({ id: t.id, lang: t.lang }));
    return tracks({ audio: valid('audio'), subtitles: valid('sub'), checkedAt: Date.now() });
  }
  function trackSelection(list, mode, source) {
    if (!['it', 'ja-sub-it'].includes(mode)) return { commands: [] };
    const wanted = mode === 'it' ? 'it' : 'ja';
    const audio = list.filter(track => track.type === 'audio');
    const match = audio.find(track => lang(track.lang) === wanted);
    const declared = classification(source.language);
    const declaredSingle = audio.length === 1 && declared?.confidence === 'declared' && declared.audio === wanted;
    if (!audio.length || !match && audio.some(track => lang(track.lang)) && !declaredSingle) return { error:'La traccia audio richiesta non è presente nel file' };
    const selected = match || (declaredSingle ? audio[0] : null);
    const commands = selected ? [['set_property', 'aid', selected.id]] : [];
    if (mode === 'ja-sub-it') {
      const sub = list.find(track => track.type === 'sub' && lang(track.lang) === 'it');
      if (sub) commands.push(['set_property', 'sid', sub.id]);
      else if (classification(source.language)?.subtitles !== 'it') return { error:'Sottotitoli italiani non rilevati' };
    } else commands.push(['set_property', 'sid', 'no']);
    return { commands, ...(declaredSingle && !match && lang(audio[0].lang) ? {warning:`Versione dichiarata ${wanted}, ma tag dell’unica traccia audio ${lang(audio[0].lang)}. Uso la versione dichiarata; la lingua del contenuto non è verificata.`} : {}) };
  }
  return { MODES, lang, preference, mergePreference, classification, tracks, classifyProvider, manualClassification,
    modesFor, usable, eligible, sourceIdentity, rankSources, availability, metadata, observedTracks, trackSelection };
});
