(() => {
'use strict';
const api = window.animeApi; // il ponte si chiama animeApi: un `const api` accanto a `window.api` darebbe errore di ridichiarazione
const { setLanguage, t } = window.i18n;
const state = { lib: { series: [], settings: {} }, presets: [], version: '', view: { name: 'home' }, filter: '', progressFilter: 'all', sort: 'title', player: { playing: false }, stats: null, ratingLoads: {} };

/* ---------- utilità ---------- */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false || k === 'value') continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) { if (kid == null || kid === false) continue; el.append(kid.nodeType ? kid : document.createTextNode(String(kid))); }
  if (props && props.value != null) el.value = props.value;
  return el;
}
const $ = (s) => document.querySelector(s);
const cleanErr = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
const bg = (url) => (url ? { backgroundImage: `url("${String(url).replace(/"/g, '%22')}")` } : {});

function toast(msg, kind) {
  const t = h('div', { class: 'toast ' + (kind || '') }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 7000 : 3500);
}
function toastAction(msg, label, action) {
  const item = h('div', { class: 'toast action-toast' }, h('span', null, msg), h('button', { class: 'btn sm primary', onclick: () => { action(); item.remove(); } }, label));
  $('#toasts').append(item);
  setTimeout(() => item.remove(), 8000);
}
function applyTheme() {
  document.documentElement.dataset.theme = state.lib.settings.theme || 'default';
  setLanguage(state.lib.settings.language || 'en');
}
async function call(ch, ...args) {
  try { return await api.invoke(ch, ...args); } catch (e) { toast(cleanErr(e), 'error'); throw e; }
}
async function mutate(ch, ...args) { const lib = await call(ch, ...args); if (lib && lib.series) { state.lib = lib; state.stats = null; render(); } return lib; }

const getSeries = (id) => state.lib.series.find((s) => s.id === id);
const presetLabel = (id) => (state.presets.find((p) => p.id === id) || {}).label || id;
const defaultPreset = () => state.lib.settings.defaultPreset || 'aa-hq';

/* ---------- dialog ---------- */
function openDialog(title, bodyBuilder, options = {}) {
  const root = $('#dialog-root');
  const close = () => { scrim.remove(); };
  const scrim = h('div', { class: 'scrim', onmousedown: (e) => { if (!options.locked && e.target === scrim) close(); } });
  const dlg = h('div', { class: 'dialog', role: 'dialog', 'aria-label': title }, h('h2', null, title));
  dlg.append(...[].concat(bodyBuilder(close)));
  scrim.append(dlg);
  scrim.addEventListener('keydown', (e) => { if (!options.locked && e.key === 'Escape') close(); });
  root.append(scrim);
  const first = dlg.querySelector('input, textarea, select');
  if (first) first.focus();
  return close;
}
const field = (label, input) => h('label', { class: 'field' }, h('span', null, label), input);

/* ---------- rail + player bar ---------- */
function renderRail() {
  const v = state.view.name; const hasMpv = !!state.lib.settings.mpvPath;
  $('#rail').replaceChildren(
    h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, 'A'), h('span', { class: 'brand-copy' }, 'Anime Player', h('small', null, 'mpv + Anime4K'))),
    h('button', { class: 'nav', 'aria-current': v === 'home' || v === 'series' ? 'page' : null, onclick: () => go({ name: 'home' }) }, h('span', { class: 'nav-icon library-icon', 'aria-hidden': 'true' }), h('span', null, t('library'))),
    h('button', { class: 'nav', 'aria-current': v === 'stats' ? 'page' : null, onclick: () => go({ name: 'stats' }) }, h('span', { class: 'nav-icon stats-icon', 'aria-hidden': 'true' }), h('span', null, t('stats'))),
    h('button', { class: 'nav', 'aria-current': v === 'shortcuts' ? 'page' : null, onclick: () => go({ name: 'shortcuts' }) }, h('span', { class: 'nav-icon settings-icon', 'aria-hidden': 'true' }), h('span', null, t('shortcuts'))),
    h('button', { class: 'nav', onclick: openLinkDialog }, h('span', { class: 'nav-icon link-icon', 'aria-hidden': 'true' }), h('span', null, t('openLink'))),
    h('button', { class: 'nav', onclick: openSettings }, h('span', { class: 'nav-icon settings-icon', 'aria-hidden': 'true' }), h('span', null, t('settings'))),
    h('div', { class: 'spacer' }),
    h('button', { class: 'mpvstat' + (hasMpv ? '' : ' bad'), onclick: openSettings }, hasMpv ? t('mpvReady') : t('mpvMissing')),
  );
}
function renderPlayer() {
  const p = state.player; const el = $('#nowplaying');
  el.hidden = !p.playing;
  if (!p.playing) return;
  const s = p.seriesId && getSeries(p.seriesId);
  const skipIntro = s && Number(s.introDuration) > 0
    ? h('button', { class: 'btn sm', onclick: () => call('player:skipIntro') }, t('skipIntro'))
    : null;
  const skipEnding = s && Number(s.outroDuration) > 0
    ? h('button', { class: 'btn sm', onclick: () => call('player:skipEnding') }, t('skipEnding'))
    : null;
  el.replaceChildren(h('span', { class: 'dot' }), h('div', { class: 't' }, h('b', null, p.title), h('span', { class: 'muted' }, `  ·  Anime4K ${p.preset}`)),
    h('span', { class: 'muted small' }, t('keyboardHint')),
    skipIntro, skipEnding,
    h('button', { class: 'btn sm', onclick: () => call('player:stop') }, t('stop')));
}

/* ---------- navigazione ---------- */
function go(view) {
  state.view = view; render(); $('#main').scrollTop = 0;
  if (view.name === 'series' || view.name === 'ratings-chart') loadSeriesRatings(view.id);
}
async function loadSeriesRatings(id) {
  const s = getSeries(id);
  if (!s || state.ratingLoads[id]) return;
  state.ratingLoads[id] = true;
  try { state.lib = await call('series:ratings', id); state.stats = null; render(); } catch { /* stored metadata remains visible */ }
}
function render() {
  applyTheme();
  renderRail(); renderPlayer();
  const main = $('#main');
  const isSearchFocused = document.activeElement && document.activeElement.classList.contains('search');
  const searchSelStart = isSearchFocused ? document.activeElement.selectionStart : 0;
  const searchSelEnd = isSearchFocused ? document.activeElement.selectionEnd : 0;

  main.replaceChildren(
    state.view.name === 'series' && getSeries(state.view.id) ? seriesView(getSeries(state.view.id)) :
    state.view.name === 'ratings-chart' && getSeries(state.view.id) ? ratingsChartView(getSeries(state.view.id)) :
    state.view.name === 'stats' ? statsView() : state.view.name === 'shortcuts' ? shortcutsView() : homeView()
  );

  if (isSearchFocused) {
    const n = $('.search');
    if (n) {
      n.focus();
      n.setSelectionRange(searchSelStart, searchSelEnd);
    }
  }
}

/* ---------- home ---------- */
function continueItems() {
  const out = [];
  for (const s of state.lib.series) {
    const activity = s.episodes.filter((e) => e.progress.updatedAt).sort((a, b) => b.progress.updatedAt - a.progress.updatedAt);
    const inProgress = activity.find((e) => e.sources.length && !e.progress.watched && e.progress.pos > 0);
    const last = activity[0];
    const target = inProgress || (last && last.progress.watched
      ? s.episodes.slice(s.episodes.indexOf(last) + 1).find((e) => e.sources.length && !e.progress.watched)
      : last && last.sources.length && !last.progress.watched ? last : null);
    if (target) out.push({ s, e: target, updatedAt: target.progress.updatedAt || s.lastWatchedAt || 0 });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);
}
const pct = (e) => (e.progress.duration > 0 && e.progress.pos > 0 ? Math.min(100, (e.progress.pos / e.progress.duration) * 100) : 0);
const episodeTotal = (s) => Array.isArray(s.episodes) ? s.episodes.length : 0;
function resumeTarget(s) {
  const episodes = (s.episodes || []).filter((e) => e.sources && e.sources.length);
  const inProgress = episodes
    .filter((e) => !e.progress.watched && e.progress.pos > 0)
    .sort((a, b) => (b.progress.updatedAt || 0) - (a.progress.updatedAt || 0))[0];
  if (inProgress) return inProgress;
  return episodes.find((e) => !e.progress.watched) || null;
}
function seriesMatches(s, filter) {
  if (filter === 'all') return true;
  const episodes = s.episodes.filter((e) => e.sources.length);
  const watched = episodes.filter((e) => e.progress.watched);
  if (filter === 'watched') return episodes.length > 0 && watched.length === episodes.length;
  if (filter === 'unwatched') return episodes.some((e) => !e.progress.watched);
  if (filter === 'progress') return episodes.some((e) => !e.progress.watched && e.progress.pos > 0);
  if (filter === 'started') return watched.length > 0 && watched.length < episodes.length;
  return true;
}

async function exportLibrary() {
  const result = await call('library:export');
  if (!result.canceled) toast(t('export') + '.');
}
async function importLibrary() {
  const result = await call('library:import');
  if (result.canceled) return;
  state.lib = result.lib;
  state.filter = '';
  state.progressFilter = 'all';
  render();
  toast(t('import') + '.');
}

function homeView() {
  const q = state.filter.trim().toLowerCase();
  const list = state.lib.series
    .filter((s) => {
      const haystack = [s.title, s.altTitle, ...(s.genres || [])].filter(Boolean).join(' ').toLowerCase();
      return (!q || haystack.includes(q)) && seriesMatches(s, state.progressFilter);
    })
    .sort((a, b) => {
      if (state.sort === 'recent') return (b.addedAt || 0) - (a.addedAt || 0);
      if (state.sort === 'rating') return (Number(b.score) || 0) - (Number(a.score) || 0);
      return a.title.localeCompare(b.title);
    });
  const cont = q || state.progressFilter !== 'all' ? [] : continueItems();
  const featured = !q && state.progressFilter === 'all' ? (cont[0] ? cont[0].s : list[0]) : null;
  const recent = [...list].sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)).slice(0, 8);
  const search = h('div', { class: 'search-shell' },
    h('span', { class: 'search-icon', 'aria-hidden': 'true' }),
    h('input', { class: 'search', type: 'search', placeholder: t('filterLibrary'), value: state.filter, 'aria-label': t('filterLibrary'), oninput: (e) => { state.filter = e.target.value; const pos = e.target.selectionStart; render(); const n = $('.search'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } } }),
    state.filter ? h('button', { class: 'search-clear', type: 'button', 'aria-label': t('clearSearch'), title: t('clearSearch'), onclick: () => { state.filter = ''; render(); } }, '×') : null);
  const filter = h('select', { class: 'input library-filter', 'aria-label': t('filterProgress'), value: state.progressFilter, onchange: (e) => { state.progressFilter = e.target.value; render(); } },
    h('option', { value: 'all' }, t('all')),
    h('option', { value: 'progress' }, t('resume')),
    h('option', { value: 'started' }, t('started')),
    h('option', { value: 'unwatched' }, t('unwatched')),
    h('option', { value: 'watched' }, t('withWatched')));
  const sort = h('select', { class: 'input library-sort', 'aria-label': t('sortBy'), value: state.sort, onchange: (e) => { state.sort = e.target.value; render(); } },
    h('option', { value: 'title' }, t('sortTitle')),
    h('option', { value: 'recent' }, t('sortRecent')),
    h('option', { value: 'rating' }, t('sortRating')));
  const posterCard = (s) => {
    const seen = s.episodes.filter((e) => e.progress.watched).length;
    const personal = effectivePersonalRating(s);
    return h('button', { class: 'poster', onclick: () => go({ name: 'series', id: s.id }) },
      h('div', { class: 'cover', style: bg(s.cover) },
        s.cover ? null : s.title.slice(0, 1).toUpperCase(),
        h('span', { class: 'poster-play', 'aria-hidden': 'true' }, '▶'),
        episodeTotal(s) ? h('span', { class: 'poster-badge' }, `${episodeTotal(s)} EP`) : null),
      h('div', { class: 't' }, s.title),
      h('div', { class: 'muted small' }, [episodeTotal(s) ? t('watchedOf', seen, episodeTotal(s)) : t('noEpisodes'), statusLabel(s), personal != null ? `★ ${personal.toFixed(1)}` : null].filter(Boolean).join(' · ')));
  };
  const featuredTarget = featured && resumeTarget(featured);
  const featuredHero = featured ? h('section', { class: 'home-featured', style: { '--bg': featured.banner || featured.cover ? `url("${featured.banner || featured.cover}")` : 'none' } },
    h('div', { class: 'featured-copy' },
      h('span', { class: 'eyebrow' }, t('library')),
      h('h2', null, featured.title),
      h('div', { class: 'featured-meta' },
        featured.score != null ? `★ ${Number(featured.score).toFixed(1)}` : '',
        featured.year ? ` · ${featured.year}` : '',
        featured.format ? ` · ${featured.format.replace('_', ' ')}` : '',
        episodeTotal(featured) ? ` · ${episodeTotal(featured)} ${t('episodes').toLowerCase()}` : ''),
      featured.description ? h('p', null, featured.description) : null,
      h('button', { class: 'btn primary', onclick: () => featuredTarget ? play(featured.id, featuredTarget.id) : go({ name: 'series', id: featured.id }) }, featuredTarget && featuredTarget.progress.pos > 0 ? t('resume') : t('watch')))) : null;
  const continueCards = cont.map(({ s, e }) => {
    const media = h('div', { class: 'pic', style: bg(e.thumb || s.banner || s.cover) },
      h('span', { class: 'resume-play', 'aria-hidden': 'true' }, '▶'),
      h('span', { class: 'resume-badge' }, `EP ${e.number}`),
      pct(e) ? h('div', { class: 'bar' }, h('i', { style: { width: pct(e) + '%' } })) : null);
    const meta = h('div', { class: 'meta' },
      h('b', null, s.title),
      h('span', { class: 'muted small' }, `${t('episode', e.number)}${e.title ? ' · ' + e.title : ''}`),
      pct(e) ? h('span', { class: 'progress-label' }, `${Math.round(pct(e))}%`) : null);
    return h('button', { class: 'resume', onclick: () => play(s.id, e.id) }, media, meta);
  });
  const continueSection = cont.length ? h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', null, t('continueWatching')), h('span', { class: 'section-link' }, t('seeAll'))),
    h('div', { class: 'strip' }, continueCards)) : null;
  const librarySection = list.length ? h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', null, t('library')), h('span', { class: 'section-link' }, t('seeAll'))),
    h('div', { class: 'grid' }, list.map(posterCard))) : h('div', { class: 'empty' }, h('h2', null, state.lib.series.length ? t('noResults') : t('emptyLibrary')),
      state.lib.series.length ? t('noFilterMatch') : t('emptyLibraryHint'),
      state.lib.series.length ? null : h('div', null, h('button', { class: 'btn primary', onclick: openAddSeries }, t('addFirstSeries'))));
  const recentSection = !q && state.progressFilter === 'all' && recent.length > 0
    ? h('section', { class: 'section recent-section' }, h('div', { class: 'section-head' }, h('h2', null, t('recentActivity')), h('span', { class: 'section-link' }, t('seeAll'))), h('div', { class: 'grid grid-compact' }, recent.map(posterCard)))
    : null;
  const schedule = !q && state.progressFilter === 'all' ? airingSections(list) : null;
  return h('div', null,
    h('div', { class: 'head' }, h('div', null, h('span', { class: 'eyebrow' }, 'ANIME PLAYER'), h('h1', null, t('library'))), h('div', { class: 'toolbar row wrap' }, search, filter, sort, h('button', { class: 'btn', onclick: importLibrary }, t('import')), h('button', { class: 'btn', onclick: exportLibrary }, t('export')), h('button', { class: 'btn primary', onclick: openAddSeries }, t('addSeries')))),
    featuredHero, continueSection, librarySection, schedule, recentSection);
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours ? t('hoursMinutes', hours, minutes) : t('minutes', minutes);
}

function effectivePersonalRating(s) {
  if (s.personalRating != null) return Number(s.personalRating);
  const ratings = (s.episodes || []).map((e) => e.personalRating).filter((x) => x != null && Number.isFinite(Number(x)));
  return ratings.length ? ratings.reduce((sum, x) => sum + Number(x), 0) / ratings.length : null;
}
function statusLabel(s) {
  if (s.status === 'FINISHED') return t('finished');
  if (s.status === 'RELEASING') return t('airing');
  if (s.status === 'NOT_YET_RELEASED') return t('upcoming');
  return s.status ? String(s.status).replaceAll('_', ' ') : '';
}
function airingDay(s) {
  return s.nextAiringAt ? new Date(s.nextAiringAt).getDay() : null;
}
function airingSections(series) {
  const groups = new Map();
  for (const s of series.filter((x) => x.status === 'RELEASING' && x.nextAiringAt)) {
    const day = airingDay(s);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(s);
  }
  if (!groups.size) return null;
  const days = [1, 2, 3, 4, 5, 6, 0].filter((day) => groups.has(day));
  const daySections = days.map((day) => {
    const items = groups.get(day).sort((a, b) => a.nextAiringAt - b.nextAiringAt).map((s) =>
      h('button', { class: 'airing-item', onclick: () => go({ name: 'series', id: s.id }) },
        h('div', { class: 'airing-cover', style: bg(s.cover) }),
        h('span', null, h('b', null, s.title), h('small', { class: 'muted' }, `${t('episode', s.nextEpisode || '?')} · ${new Date(s.nextAiringAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`))));
    return h('div', { class: 'airing-day' }, h('h3', null, t(`day${day}`)), h('div', { class: 'airing-list' }, items));
  });
  return h('section', { class: 'section airing-schedule' },
    h('div', { class: 'section-head' }, h('h2', null, t('weeklySchedule')), h('span', { class: 'section-link' }, t('airing'))),
    daySections);
}

function statsView() {
  if (!state.stats) {
    api.invoke('stats:get').then((stats) => { state.stats = stats; render(); }).catch(() => {});
    return h('div', { class: 'empty' }, t('calculateStats'));
  }
  const st = state.stats;
  const activity = st.latestActivity || [];
  const renderSeriesStat = (item) => {
    const details = `${t('genres')}: ${item.genres.length ? item.genres.join(', ') : t('unavailable')} · ${t('year')}: ${item.year || t('unavailable')} · ${t('format')}: ${item.format || t('unavailable')} · ${t('score')}: ${item.score == null ? t('unavailable') : t('scoreFrom', item.score.toFixed(1))}`;
    return h('article', { class: 'stats-series' },
      h('div', { class: 'stats-series-cover', style: bg(item.cover) }),
      h('div', null, h('h3', null, item.title),
        h('div', { class: 'muted small' }, `${t('watchedOf', item.watchedEpisodes, item.totalEpisodes)} · ${t('completion')}: ${Math.round(item.completion)}% · ${formatDuration(item.watchTime)}`),
        h('div', { class: 'muted small' }, `${t('lastActivity')}: ${item.lastActivity ? new Date(item.lastActivity).toLocaleDateString() : t('unavailable')}`),
        h('div', { class: 'muted small' }, details)));
  };
  const perSeries = (st.perSeries || []).length ? h('div', { class: 'stats-series-list' }, st.perSeries.map(renderSeriesStat)) : h('div', { class: 'empty' }, t('noResults'));
  return h('div', null,
    h('div', { class: 'head' }, h('h1', null, t('stats')),
      h('button', { class: 'btn', onclick: async () => { state.stats = await call('stats:get'); render(); } }, t('refresh'))),
    h('div', { class: 'stats-grid' },
      h('div', { class: 'stat-card' }, h('b', null, String(st.watchedEpisodes)), h('span', { class: 'muted' }, t('watchedEpisodes'))),
      h('div', { class: 'stat-card' }, h('b', null, formatDuration(st.watchTime)), h('span', { class: 'muted' }, t('watchTime'))),
      h('div', { class: 'stat-card' }, h('b', null, String(st.completedSeries)), h('span', { class: 'muted' }, t('completedSeries'))),
      h('div', { class: 'stat-card' }, h('b', null, String(st.seriesCount || 0)), h('span', { class: 'muted' }, t('totalSeries'))),
      h('div', { class: 'stat-card' }, h('b', null, String(st.episodesTotal || 0)), h('span', { class: 'muted' }, t('totalEpisodes'))),
      h('div', { class: 'stat-card' }, h('b', null, String(st.inProgressSeries || 0)), h('span', { class: 'muted' }, t('inProgress')))),
    h('section', { class: 'section stats-activity' }, h('h2', null, t('recentActivity')),
      activity.length ? h('div', { class: 'activity-list' }, activity.map((item) => h('button', { class: 'activity', onclick: () => go({ name: 'series', id: item.seriesId }) },
        h('span', { class: 'activity-dot' }), h('span', null, h('b', null, item.seriesTitle), h('span', { class: 'muted small' }, `${t('episode', item.episodeNumber)} · ${item.title}`)),
        h('time', { class: 'muted small' }, new Date(item.updatedAt).toLocaleDateString())))) :
        h('div', { class: 'empty' }, t('noActivity'))),
    h('section', { class: 'section stats-activity' }, h('h2', null, t('perAnime')), perSeries));
}

/* ---------- serie ---------- */
function seriesView(s) {
  const eff = s.preset || defaultPreset();
  const effMode = eff === 'off' ? 'off' : (eff.split('-')[0]); const effTier = eff === 'off' ? 'fast' : eff.split('-')[1];
  const MODES = [['a', 'A'], ['b', 'B'], ['c', 'C'], ['aa', 'A+A'], ['bb', 'B+B'], ['ca', 'C+A']];
  const setPreset = async (value) => {
    await mutate('series:update', s.id, { preset: value });
    if (state.player.playing && state.player.seriesId === s.id) call('player:preset', value || defaultPreset());
  };
  const modeBtns = [
    h('button', { 'aria-pressed': String(!s.preset), onclick: () => setPreset(null) }, t('default')),
    h('button', { 'aria-pressed': String(s.preset === 'off'), onclick: () => setPreset('off') }, t('off')),
    ...MODES.map(([id, label]) => h('button', { 'aria-pressed': String(!!s.preset && effMode === id), onclick: () => setPreset(`${id}-${s.preset ? effTier : 'fast'}`) }, label)),
  ];
  const tierBtns = ['fast', 'hq'].map((tier) => h('button', { 'aria-pressed': String(!!s.preset && s.preset !== 'off' && effTier === tier), disabled: !s.preset || s.preset === 'off', onclick: () => setPreset(`${effMode}-${tier}`) }, tier === 'fast' ? t('fast') : t('hq')));
  const desc = h('div', { class: 'desc' }, s.description || t('noDescription'));
  const more = s.description && s.description.length > 260 ? h('button', { class: 'link', onclick: (e) => { desc.classList.toggle('open'); e.target.textContent = desc.classList.contains('open') ? t('showLess') : t('readMore'); } }, t('readMore')) : null;
  const target = resumeTarget(s);
  const metaParts = [
    s.year,
    s.format && s.format.replace('_', ' '),
    episodeTotal(s) ? `${episodeTotal(s)} ${t('episodes').toLowerCase()}` : null,
  ].filter(Boolean);
  const ratingBtn = h('button', {
    class: 'rating-badge-btn',
    title: t('viewRatingsChart'),
    onclick: () => go({ name: 'ratings-chart', id: s.id }),
  }, s.score != null ? `★ ${Number(s.score).toFixed(1)}/10${s.scoreSource ? ` (${s.scoreSource})` : ''}` : `★ ${t('ratingUnavailable')}`);
  const metaRow = h('div', { class: 'row wrap', style: { alignItems: 'center', gap: '8px', margin: '4px 0' } },
    ratingBtn,
    metaParts.length ? h('span', { class: 'muted' }, ' · ' + metaParts.join('  ·  ')) : null,
  );
  const actions = h('div', { class: 'row wrap', style: { marginTop: '14px' } },
    h('button', { class: 'btn primary', onclick: () => openAddLinks(s) }, t('addLinks')),
    h('button', { class: 'btn', onclick: () => go({ name: 'ratings-chart', id: s.id }) }, '★ ' + t('ratingsChart')),
    s.anilistId ? h('button', { class: 'btn', onclick: async () => { toast(t('infoUpdating')); await mutate('series:refresh', s.id); toast(t('infoUpdated')); } }, t('updateInfo')) : null,
    h('button', { class: 'btn danger', onclick: () => { if (confirm(t('confirmDelete', s.title))) mutate('series:delete', s.id).then(() => go({ name: 'home' })); } }, t('deleteSeries')));
  const heroBody = h('div', { class: 'body' },
    h('div', { class: 'cover', style: bg(s.cover) }),
    h('div', null, h('h1', null, s.title), metaRow,
      h('div', { class: 'chips' }, (s.genres || []).slice(0, 6).map((g) => h('span', { class: 'chip' }, g)), statusLabel(s) ? h('span', { class: 'chip active' }, statusLabel(s)) : null),
      s.status === 'RELEASING' && s.nextAiringAt ? h('div', { class: 'muted small airing-next' }, `${t('nextEpisode')}: ${t('episode', s.nextEpisode || '?')} · ${new Date(s.nextAiringAt).toLocaleString()}`) : null,
      field(t('personalRating'), h('input', { class: 'input rating-input', type: 'number', min: '0', max: '10', step: '0.1', value: effectivePersonalRating(s) == null ? '' : effectivePersonalRating(s), placeholder: s.personalRating == null && s.episodes.some((e) => e.personalRating != null) ? t('episodeAverage') : '', onchange: (e) => mutate('series:update', s.id, { personalRating: e.target.value === '' ? null : Number(e.target.value) }) })),
      desc, more, actions));
  const resumeAction = target
    ? h('aside', { class: 'hero-resume' },
      h('div', { class: 'muted small' }, target.progress.pos > 0 && !target.progress.watched ? t('resumeStatus') : t('nextEpisode')),
      h('strong', null, t('episode', target.number)),
      target.title ? h('div', { class: 'muted small' }, target.title) : null,
      h('button', { class: 'btn primary', onclick: () => play(s.id, target.id) }, target.progress.pos > 0 && !target.progress.watched ? t('resume') : t('watch')))
    : null;
  heroBody.append(resumeAction);
  const hero = h('section', { class: 'hero', style: { '--bg': s.banner || s.cover ? `url("${s.banner || s.cover}")` : 'none' } },
    h('button', { class: 'link back', onclick: () => go({ name: 'home' }) }, t('backLibrary')), heroBody);
  const advanced = h('details', { class: 'adv' }, h('summary', null, t('advanced')),
    field(t('referer'), h('input', { class: 'input', value: s.referer || '', placeholder: 'https://…', onchange: (e) => mutate('series:update', s.id, { referer: e.target.value.trim() }) })),
    h('div', { class: 'two' },
      field(t('introDuration'), h('input', { class: 'input', type: 'number', min: '0', step: '1', value: Number(s.introDuration) || 0, onchange: (e) => mutate('series:update', s.id, { introDuration: Math.max(0, Number(e.target.value) || 0) }) })),
      field(t('outroDuration'), h('input', { class: 'input', type: 'number', min: '0', step: '1', value: Number(s.outroDuration) || 0, onchange: (e) => mutate('series:update', s.id, { outroDuration: Math.max(0, Number(e.target.value) || 0) }) }))));
  const a4k = h('section', { class: 'a4k' },
    h('h3', null, t('anime4kSeries')),
    h('div', { class: 'muted small', style: { marginBottom: '10px' } }, t('activePreset', presetLabel(eff))),
    h('div', { class: 'row wrap' },
      h('div', { class: 'seg', role: 'group', 'aria-label': t('mode') }, modeBtns),
      h('div', { class: 'seg', role: 'group', 'aria-label': t('quality') }, tierBtns)),
    advanced);
  const episodeContent = s.episodes.length
    ? h('div', { class: 'eps' }, s.episodes.map((e) => episodeRow(s, e)))
    : h('div', { class: 'empty' }, h('h2', null, t('noEpisodeYet')), t('addLinksHint'),
      h('div', null, h('button', { class: 'btn primary', onclick: () => openAddLinks(s) }, t('addLinks'))));
  return h('div', null, hero, a4k, h('section', null, h('h2', { style: { marginBottom: '12px' } }, t('episodes')), episodeContent));
}

function getRatingTier(score) {
  const n = Number(score);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n >= 9.0) return 'awesome';
  if (n >= 8.0) return 'great';
  if (n >= 7.0) return 'good';
  if (n >= 6.0) return 'regular';
  if (n >= 5.0) return 'bad';
  return 'garbage';
}

function ratingsChartView(s) {
  const chart = s.imdbChart;
  const back = h('button', { class: 'ratings-chart-back', onclick: () => go({ name: 'series', id: s.id }) }, t('backToAnime'));

  const totalScoreVal = s.score != null
    ? Number(s.score).toFixed(1)
    : (chart && chart.overallRating != null ? Number(chart.overallRating).toFixed(1) : null);

  const sidebar = h('aside', { class: 'ratings-chart-sidebar' },
    h('div', { class: 'ratings-chart-poster', style: bg(s.cover) }),
    h('div', { class: 'ratings-chart-total' },
      h('span', { class: 'star' }, '★'),
      h('span', { class: 'score-val' }, totalScoreVal != null ? totalScoreVal : t('unavailable')),
      s.scoreSource ? h('span', { class: 'score-src' }, `(${s.scoreSource})`) : null,
    ),
    h('h1', { class: 'ratings-chart-title' }, (chart && chart.title) || s.title),
    h('div', { class: 'ratings-chart-desc' }, s.description || t('noDescription')),
  );

  let mainContent;
  if (!chart || !Array.isArray(chart.seasons) || !chart.seasons.length) {
    mainContent = h('div', { class: 'empty' },
      h('h2', null, state.ratingLoads[s.id] ? t('loadingRatings') : t('chartUnavailable')),
      h('p', { class: 'muted' }, state.ratingLoads[s.id] ? t('calculateStats') : ''),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          delete state.ratingLoads[s.id];
          await loadSeriesRatings(s.id);
        },
      }, t('refresh')),
    );
  } else {
    // Legenda corrispondente a esempio_rating.png
    const TIERS = [
      { id: 'awesome', label: 'Awesome' },
      { id: 'great', label: 'Great' },
      { id: 'good', label: 'Good' },
      { id: 'regular', label: 'Regular' },
      { id: 'bad', label: 'Bad' },
      { id: 'garbage', label: 'Garbage' },
    ];
    const legend = h('div', { class: 'ratings-legend' },
      TIERS.map((tier) => h('div', { class: 'legend-item' },
        h('span', { class: `legend-dot ${tier.id}` }),
        h('span', null, tier.label),
      )),
    );

    const seasons = chart.seasons.filter((sn) => Number.isInteger(sn.season) && sn.season > 0);
    const maxEps = chart.maxEpisodes || Math.max(...seasons.map((sn) => sn.episodes.length), 0);

    const headerRow = h('tr', null,
      h('th', null),
      ...seasons.map((sn) => h('th', null, `S${sn.season}`)),
    );

    const bodyRows = [];
    for (let epNum = 1; epNum <= maxEps; epNum++) {
      const cells = [
        h('td', { class: 'ep-label' }, `E${epNum}`),
      ];
      for (const sn of seasons) {
        const ep = sn.episodes.find((e) => e.number === epNum);
        if (ep && ep.rating != null) {
          const tier = getRatingTier(ep.rating);
          const cell = h('td', null,
            h('div', {
              class: `ratings-cell rating-tier-${tier}`,
              title: `S${sn.season} E${ep.number}: ${ep.title || t('episode', ep.number)} · ${ep.rating.toFixed(1)} ★ (${tier})`,
            }, ep.rating.toFixed(1)),
          );
          cells.push(cell);
        } else {
          cells.push(h('td', null, h('div', { class: 'ratings-cell empty' })));
        }
      }
      bodyRows.push(h('tr', null, ...cells));
    }

    const table = h('table', { class: 'ratings-matrix' },
      h('thead', null, headerRow),
      h('tbody', null, ...bodyRows),
    );

    const matrixWrapper = h('div', { class: 'ratings-matrix-wrapper' }, table);
    mainContent = h('div', { class: 'ratings-chart-main' }, legend, matrixWrapper);
  }

  const layout = h('div', { class: 'ratings-chart-layout' }, sidebar, mainContent);
  return h('div', { class: 'ratings-chart-container' }, back, layout);
}

function episodeRow(s, e) {
  const has = e.sources.length > 0; const p = e.progress; const resume = !p.watched && p.pos > 10;
  const image = e.thumb || s.banner || s.cover;
  const thumb = h('div', { class: 'th' + (image ? '' : ' fallback'), style: bg(image), title: e.thumb ? '' : t('noThumbnail') },
    e.thumb ? null : h('span', { class: 'num' }, image ? String(e.number) : t('noThumbnail')),
    pct(e) && !p.watched ? h('div', { class: 'bar' }, h('i', { style: { width: pct(e) + '%' } })) : null);
  const info = h('div', null,
    h('div', { class: 'name' }, `${e.number}. ${e.title || t('episode', e.number)}`),
    h('div', { class: 'muted small' }, `${has ? t('sources', e.sources.length) : t('noLink')}${p.watched ? ' · ' + t('watched') : resume ? ' · ' + t('resumeStatus') : ''}${e.duration ? ' · ' + formatDuration(e.duration) : ''}`),
    h('div', { class: 'muted small rating-line' }, e.rating == null ? t('ratingUnavailable') : `${t('rating')}: ${Number(e.rating).toFixed(1)}/10${e.ratingSource ? ` (${e.ratingSource})` : ''}`),
    field(t('personalRating'), h('input', { class: 'input rating-input', type: 'number', min: '0', max: '10', step: '0.1', value: e.personalRating == null ? '' : e.personalRating, onchange: (ev) => mutate('episodes:rate', s.id, e.id, ev.target.value === '' ? null : Number(ev.target.value)) })));
  const acts = h('div', { class: 'acts' },
    h('button', { class: 'btn sm' + (has ? ' primary' : ''), disabled: !has, onclick: () => play(s.id, e.id) }, p.watched ? t('rewatch') : resume ? t('resume') : t('watch')),
    h('button', { class: 'btn sm', onclick: () => openEditLinks(s, e) }, t('link')),
    h('button', { class: 'btn sm', onclick: () => mutate('episodes:mark', s.id, e.id, !p.watched) }, p.watched ? t('markUnwatched') : t('markWatched')),
    h('button', { class: 'btn sm danger', onclick: () => mutate('episodes:delete', s.id, e.id) }, t('delete')));
  return h('div', { class: 'ep' + (p.watched ? ' done' : '') }, thumb, info, acts);
}

async function play(sid, eid) { try { await call('player:play', sid, eid); } catch { /* toast già mostrato */ } }

/* ---------- dialoghi ---------- */
function openAddSeries() {
  openDialog(t('addSeriesTitle'), (close) => {
    const q = h('input', { class: 'input', placeholder: t('animeTitlePlaceholder'), 'aria-label': t('animeTitlePlaceholder') });
    const results = h('div', { class: 'results' });
    const add = async (payload, btn) => {
      btn.disabled = true; btn.textContent = t('adding');
      try { const r = await call('series:create', payload); state.lib = r.lib; close(); go({ name: 'series', id: r.id }); } catch { btn.disabled = false; btn.textContent = t('add'); }
    };
    const search = async () => {
      const text = q.value.trim(); if (!text) return;
      results.replaceChildren(h('div', { class: 'muted' }, t('searching')));
      try {
        const list = await call('series:search', text);
        results.replaceChildren(...(list.length ? list.map((m) => {
          const btn = h('button', { class: 'btn sm primary' }, t('add')); btn.onclick = () => add({ anilistId: m.anilistId }, btn);
          return h('div', { class: 'res' }, h('div', { class: 'c', style: bg(m.cover) }), h('div', null, h('b', null, m.title), h('div', { class: 'muted small' }, [m.year, m.format && m.format.replace('_', ' '), m.episodeCount ? m.episodeCount + ' ep.' : null].filter(Boolean).join(' · '))), btn);
        }) : [h('div', { class: 'muted' }, t('noSearchResults'))]));
      } catch { results.replaceChildren(); }
    };
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
    const manual = h('button', { class: 'link', onclick: async () => { const title = q.value.trim(); if (!title) { toast(t('writeTitleFirst'), 'error'); return; } const r = await call('series:create', { title }); state.lib = r.lib; close(); go({ name: 'series', id: r.id }); } }, t('addWithoutSearch'));
    return [h('div', { class: 'row' }, q, h('button', { class: 'btn primary', onclick: search }, t('search'))), results, h('div', { style: { marginTop: '14px' } }, manual), h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: close }, t('close')))];
  });
}

function openAddLinks(s) {
  openDialog(t('addLinksTitle', s.title), (close) => {
    const fill = (pattern, n) => pattern.replace(/\{ep(?::(\d+))?\}/g, (_, w) => (w ? String(n).padStart(Number(w), '0') : String(n)));
    const defTo = String(episodeTotal(s) || 12);
    const range = () => { const from = h('input', { class: 'input', type: 'number', min: '0', value: '1' }); const to = h('input', { class: 'input', type: 'number', min: '0', value: defTo }); return { from, to, box: h('div', { class: 'two' }, field(t('fromEpisode'), from), field(t('toEpisode'), to)) }; };
    let tab = 'link';

    /* --- scheda 1: da un link (riconosce da solo il numero) --- */
    const sample = h('input', { class: 'input', placeholder: t('oneEpisodeLink') });
    const num = h('input', { class: 'input', type: 'number', min: '0' });
    const r1 = range();
    const chips = h('div', { class: 'chips' });
    const info = h('div', { class: 'mono muted' });
    let det = null; let chosen = 0; let timer = null;
    const paint = () => {
      chips.replaceChildren(); info.replaceChildren();
      if (!sample.value.trim()) return;
      if (!det) { info.textContent = t('noNumber'); return; }
      const c = det.candidates[chosen]; const url = sample.value.trim();
      if (det.candidates.length > 1) {
        chips.append(h('span', { class: 'muted small' }, t('multipleNumbers')));
        det.candidates.forEach((k, i) => chips.append(h('button', { class: 'chip pick', 'aria-pressed': String(i === chosen), onclick: () => { chosen = i; num.value = k.number; paint(); } }, `…${url.slice(Math.max(0, k.index - 6), k.index)}[${k.text}]${url.slice(k.index + k.text.length, k.index + k.text.length + 6)}…`)));
      }
      const a = Number(r1.from.value); const z = Number(r1.to.value);
      info.append(h('div', null, t('episodeNumberIs') + ' ', h('b', null, c.text), c.width ? ` (${c.width})` : ''), h('div', null, `${t('first')}: `, fill(c.pattern, a)), h('div', null, `${t('last')}: `, fill(c.pattern, z)));
    };
    const analyse = async (hint) => {
      const url = sample.value.trim();
      det = url ? await api.invoke('patterns:detect', url, hint).catch(() => null) : null; chosen = 0;
      if (det && hint === undefined) num.value = det.number;
      paint();
    };
    sample.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => analyse(undefined), 250); });
    num.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => analyse(num.value === '' ? undefined : Number(num.value)), 250); });
    [r1.from, r1.to].forEach((i) => i.addEventListener('input', paint));
    const lBox = h('div', null, field(t('linkEpisode'), sample), field(t('episodeNumber'), num), r1.box, chips, info);

    /* --- scheda 2: pattern scritto a mano --- */
    const pattern = h('input', { class: 'input', placeholder: 'https://site.example/anime/ep{ep:02}.mp4' });
    const r2 = range();
    const pBox = h('div', { hidden: true }, field(t('linkPattern'), pattern), r2.box);

    /* --- scheda 3: elenco --- */
    const list = h('textarea', { class: 'input', placeholder: t('linksList') });
    const start = h('input', { class: 'input', type: 'number', min: '0', value: '1' });
    const eBox = h('div', { hidden: true }, field(t('link'), list), field(t('firstLinkEpisode'), start),
      h('button', { class: 'btn sm', onclick: async () => { await mutate('episodes:addM3U', s.id, { start: Number(start.value) }); close(); } }, t('importPlaylist')));

    const boxes = { link: lBox, pattern: pBox, list: eBox };
    const tabs = h('div', { class: 'seg', style: { marginBottom: '14px' } },
      ...[['link', t('tabLink')], ['pattern', t('tabPattern')], ['list', t('tabList')]].map(([id, label]) => h('button', { 'aria-pressed': String(id === tab), onclick: (e) => { tab = id; for (const [k, b] of Object.entries(boxes)) b.hidden = k !== id; [...e.target.parentNode.children].forEach((b) => b.setAttribute('aria-pressed', String(b === e.target))); } }, label)));
    const ok = h('button', { class: 'btn primary', onclick: async () => {
      try {
        if (tab === 'link') {
          if (!det) { toast(t('pasteLink'), 'error'); return; }
          await mutate('episodes:addPattern', s.id, { pattern: det.candidates[chosen].pattern, from: r1.from.value, to: r1.to.value });
        } else if (tab === 'pattern') await mutate('episodes:addPattern', s.id, { pattern: pattern.value, from: r2.from.value, to: r2.to.value });
        else await mutate('episodes:addList', s.id, { text: list.value, start: Number(start.value) });
        toast(t('linksAdded')); close();
      } catch { /* toast già mostrato */ }
    } }, t('add'));
    return [tabs, lBox, pBox, eBox, h('div', { class: 'muted small', style: { marginTop: '10px' } }, t('playerHint')), h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: close }, t('cancel')), ok)];
  });
}

function openEditLinks(s, e) {
  openDialog(t('editEpisodeLinks', e.number), (close) => {
    const ta = h('textarea', { class: 'input', value: e.sources.map((x) => x.url).join('\n') });
    return [h('div', { class: 'muted small', style: { marginBottom: '8px' } }, t('oneLinkLine')), ta,
      h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: close }, t('cancel')),
        h('button', { class: 'btn primary', onclick: async () => { try { await mutate('episodes:setSources', s.id, e.id, ta.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)); close(); } catch { /* toast */ } } }, t('save')))];
  });
}

function openLinkDialog() {
  openDialog(t('openLinkTitle'), (close) => {
    const url = h('input', { class: 'input', placeholder: t('urlPlaceholder') });
    const sel = h('select', { class: 'input' }, h('option', { value: '' }, `${t('default')} (${presetLabel(defaultPreset())})`), ...state.presets.map((p) => h('option', { value: p.id }, p.label)));
    const go_ = async () => { try { await call('player:playUrl', url.value, sel.value || null); close(); } catch { /* toast */ } };
    url.addEventListener('keydown', (e) => { if (e.key === 'Enter') go_(); });
    return [field(t('videoLink'), url), field(t('anime4k'), sel), h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: close }, t('cancel')), h('button', { class: 'btn primary', onclick: go_ }, t('play')))];
  });
}

function openSettings() {
  const st = state.lib.settings;
  openDialog(t('settingsTitle'), (close) => {
    const mpv = h('input', { class: 'input', value: st.mpvPath || '', placeholder: t('mpvPlaceholder') });
    const preset = h('select', { class: 'input', value: st.defaultPreset }, state.presets.map((p) => h('option', { value: p.id }, p.label)));
    preset.value = st.defaultPreset || 'aa-hq';
    const theme = h('select', { class: 'input', value: st.theme || 'default' },
      h('option', { value: 'default' }, t('default')),
      h('option', { value: 'compact' }, t('compact')));
    const language = h('select', { class: 'input', value: st.language || 'en' },
      h('option', { value: 'en' }, 'English'),
      h('option', { value: 'it' }, 'Italiano'));
    const auto = h('input', { type: 'checkbox' }); auto.checked = !!st.autoplayNext;
    const alang = h('input', { class: 'input', value: st.alang || '' });
    const slang = h('input', { class: 'input', value: st.slang || '' });
    const ua = h('input', { class: 'input', value: st.userAgent || '', placeholder: t('userAgentPlaceholder') });
    const extra = h('input', { class: 'input', value: st.extraArgs || '', placeholder: 'es. --fullscreen --volume=70' });
    const skipOpening = h('input', { type: 'checkbox' }); skipOpening.checked = !!st.skipOpening;
    const skipEnding = h('input', { type: 'checkbox' }); skipEnding.checked = !!st.skipEnding;
    return [
      field(t('mpvPath'), h('div', { class: 'row' }, mpv,
        h('button', { class: 'btn', onclick: async () => { const r = await call('mpv:detect'); if (r.path) { mpv.value = r.path; state.lib = r.lib; render(); toast(t('detectMpv')); } else toast(t('detectMpvMissing'), 'error'); } }, t('find')),
        h('button', { class: 'btn', onclick: async () => { const l = await call('mpv:browse'); state.lib = l; mpv.value = l.settings.mpvPath || ''; render(); } }, t('browse')))),
      h('div', { class: 'muted small setup-note' }, t('mpvExternalNote')),
      field(t('defaultAnime4K'), preset),
      field(t('interfaceTheme'), theme),
      field(t('primaryLanguage'), language),
      h('div', { class: 'muted small app-version' }, `${t('appVersion')}: ${state.version || '—'}`),
      h('label', { class: 'row', style: { marginBottom: '14px' } }, auto, t('autoplay')),
      h('label', { class: 'row', style: { marginBottom: '8px' } }, skipOpening, t('autoSkipOpening')),
      h('label', { class: 'row', style: { marginBottom: '14px' } }, skipEnding, t('autoSkipEnding')),
      h('div', { class: 'two' }, field(t('audioLanguages'), alang), field(t('subtitleLanguages'), slang)),
      field(t('userAgent'), ua), field(t('extraArgs'), extra),
      h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: close }, t('cancel')),
        h('button', { class: 'btn primary', onclick: async () => { await mutate('settings:set', { mpvPath: mpv.value.trim(), defaultPreset: preset.value, theme: theme.value, language: language.value, autoplayNext: auto.checked, skipOpening: skipOpening.checked, skipEnding: skipEnding.checked, alang: alang.value.trim(), slang: slang.value.trim(), userAgent: ua.value.trim(), extraArgs: extra.value.trim() }); toast(t('saved')); close(); } }, t('save')))];
  });
}

function shortcutsView() {
  const shortcuts = { next: 'PGDWN', previous: 'PGUP', skipIntro: '', skipEnding: '', ...(state.lib.settings.shortcuts || {}) };
  const inputs = Object.fromEntries(Object.entries(shortcuts).map(([key, value]) => [key, h('input', { class: 'input', value: value || '', placeholder: t('shortcutUnset') })]));
  return h('div', null,
    h('div', { class: 'head' }, h('div', null, h('span', { class: 'eyebrow' }, 'ANIME PLAYER'), h('h1', null, t('shortcuts')))),
    h('section', { class: 'panel shortcuts-page' },
      h('p', { class: 'muted' }, t('shortcutsHint')),
      field(t('shortcutNext'), inputs.next),
      field(t('shortcutPrevious'), inputs.previous),
      field(t('shortcutIntro'), inputs.skipIntro),
      field(t('shortcutEnding'), inputs.skipEnding),
      h('div', { class: 'foot' }, h('button', { class: 'btn primary', onclick: async () => { await mutate('settings:set', { shortcuts: Object.fromEntries(Object.entries(inputs).map(([key, el]) => [key, el.value.trim().toUpperCase()])) }); toast(t('saved')); } }, t('save')))));
}

function openSetup() {
  openDialog(t('setupTitle'), (close) => {
    const mpv = h('input', { class: 'input', value: state.lib.settings.mpvPath || '', placeholder: t('mpvPlaceholder') });
    const preset = h('select', { class: 'input', value: state.lib.settings.defaultPreset || 'aa-hq' }, state.presets.map((p) => h('option', { value: p.id }, p.label)));
    preset.value = state.lib.settings.defaultPreset || 'aa-hq';
    const language = h('select', { class: 'input', value: state.lib.settings.language || 'en' },
      h('option', { value: 'en' }, 'English'), h('option', { value: 'it' }, 'Italiano'));
    const message = h('div', { class: 'muted small setup-note' }, t('setupMessage'));
    const save = async () => {
      try {
        const lib = await call('settings:set', { mpvPath: mpv.value.trim(), defaultPreset: preset.value, language: language.value, onboardingComplete: true });
        state.lib = lib; close(); render(); toast(t('setupDone'));
      } catch { /* messaggio già mostrato */ }
    };
    mpv.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    return [message, field(t('mpvPath'), h('div', { class: 'row' }, mpv,
      h('button', { class: 'btn', onclick: async () => { const r = await call('mpv:detect'); if (r.path) { mpv.value = r.path; state.lib = r.lib; } else toast(t('detectMpvMissing'), 'error'); } }, t('find')),
      h('button', { class: 'btn', onclick: async () => { const lib = await call('mpv:browse'); state.lib = lib; mpv.value = lib.settings.mpvPath || ''; } }, t('browse')))),
      h('div', { class: 'muted small setup-note' }, t('mpvExternalNote')),
      field(t('defaultAnime4K'), preset), field(t('primaryLanguage'), language),
      h('div', { class: 'foot' }, h('button', { class: 'btn primary', onclick: save }, t('completeSetup')))];
  }, { locked: true });
}

/* ---------- avvio ---------- */
(async function init() {
  api.on('lib:changed', (lib) => { state.lib = lib; state.stats = null; render(); });
  api.on('player:state', (p) => { state.player = p; renderPlayer(); });
  api.on('player:error', (m) => toast(m, 'error'));
  api.on('player:skip-offer', (offer) => toastAction(offer.kind === 'intro' ? t('skipIntro') : t('skipEnding'), t('skipNow'), () => call('player:skipSegment', offer.end)));
  state.lib = await api.invoke('lib:get');
  state.presets = await api.invoke('presets:list');
  state.version = await api.invoke('app:version');
  state.player = await api.invoke('player:state');
  render();
  if (!state.lib.settings.onboardingComplete) openSetup();
  else if (!state.lib.settings.mpvPath) toast(t('configureMpv'), 'error');
})();
})();
