(() => {
'use strict';
const api = window.animeApi; // il ponte si chiama animeApi: un `const api` accanto a `window.api` darebbe errore di ridichiarazione
const { setLanguage, t } = window.i18n;
const state = { lib: { series: [], settings: {} }, presets: [], version: '', view: { name: 'home' }, filter: '', progressFilter: 'all', sort: 'title', player: { playing: false }, stats: null, ratingLoads: {} };
const detectSeasonFromTitle = (title) => {
  const text = String(title || '');
  const match = text.match(/season\s*(\d+)/i) || text.match(/(\d+)(?:st|nd|rd|th)\s*season/i) || text.match(/\bS(\d+)\b/i) || text.match(/\bPart\s*(\d+)\b/i);
  return match ? Number(match[1]) : 1;
};

/* ---------- utilità ---------- */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false || k === 'value') continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; } } // Object.assign non imposta le variabili CSS (--bg)
    else el.setAttribute(k, v === true ? '' : v);
  }

  for (const kid of kids.flat(Infinity)) { if (kid == null || kid === false) continue; el.append(kid.nodeType ? kid : document.createTextNode(String(kid))); }
  if (props && props.value != null) el.value = props.value;
  return el;
}
function castRelatedSection(s) {
  const cast = Array.isArray(s.cast) ? s.cast.slice(0, 8) : [];
  const related = Array.isArray(s.related) ? s.related.slice(0, 8) : [];
  if (!cast.length && !related.length) return null;
  const castPanel = h('div', { class: 'compact-info-panel' },
    h('h3', null, t('cast')),
    cast.length ? h('div', { class: 'cast-list' }, cast.map((person) => h('div', { class: 'cast-item' },
      person.image ? h('img', { src: person.image, alt: person.name, loading: 'lazy' }) : h('div', { class: 'cast-avatar' }),
      h('div', null, h('b', null, person.name), person.role ? h('span', { class: 'muted small' }, person.role) : null)))) :
      h('span', { class: 'muted small' }, t('noCast')));
  const relatedPanel = h('div', { class: 'compact-info-panel' },
    h('h3', null, t('relatedSeries')),
    related.length ? h('div', { class: 'related-list' }, related.map((item) => h('button', { class: 'related-item', onclick: () => {
      const local = state.lib.series.find((x) => x.anilistId === item.id);
      if (local) go({ name: 'series', id: local.id });
      else toast(`${item.title} · ${t('sourceUnavailable')}`);
    } },
      item.cover ? h('img', { src: item.cover, alt: item.title, loading: 'lazy' }) : null,
      h('span', null, h('b', null, item.title), h('small', { class: 'muted' }, [item.relation, item.format].filter(Boolean).join(' · ')))))) :
      h('span', { class: 'muted small' }, t('noRelated')));
  return h('section', { class: 'compact-info' }, castPanel, relatedPanel);
}
const $ = (s) => document.querySelector(s);
const cleanErr = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
const bg = (url) => (url ? { backgroundImage: `url("${String(url).replace(/"/g, '%22')}")` } : {});

/* ---------- icone, menu a comparsa, interruttori ---------- */
const ICONS = {
  library: '<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/>',
  stats: '<path d="M5 21V11M12 21V4M19 21v-7"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11.5 4.43"/><path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07l1.33-1.33"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2.5"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7.5 14h9"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  play: '<path d="M7.5 4.8v14.4a.8.8 0 0 0 1.2.7l11.6-7.2a.8.8 0 0 0 0-1.4L8.7 4.1a.8.8 0 0 0-1.2.7z" fill="currentColor"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-3.9-3.9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 16V5M7 9l5-5 5 5M5 20h14"/>',
  more: '<circle cx="5" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="19" cy="12" r="1.7" fill="currentColor"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  star: '<path d="M12 3.4l2.6 5.5 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.7l6-.8z" fill="currentColor" stroke="none"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-4M4 5v4h4M4 13a8 8 0 0 0 14.5 4M20 19v-4h-4"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  chart: '<path d="M4 20h16M7 16V9M12 16V5M17 16v-4"/>',
  eye: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>',
};
function icon(name, size) {
  const el = document.createElement('span');
  el.className = 'ico'; el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<svg viewBox="0 0 24 24" width="${size || 18}" height="${size || 18}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return el;
}
let openMenu = null;
function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }
document.addEventListener('mousedown', (e) => { if (openMenu && !openMenu.contains(e.target) && !e.target.closest('.menu-btn')) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('resize', closeMenu);
document.addEventListener('scroll', closeMenu, true);
function menuButton(label, items) {
  const btn = h('button', { class: 'icon-btn menu-btn', 'aria-label': label, 'aria-haspopup': 'menu', title: label }, icon('more'));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (openMenu && openMenu._owner === btn) { closeMenu(); return; }
    closeMenu();
    const menu = h('div', { class: 'menu', role: 'menu' }, items.map((it) => h('button', { class: 'menu-item' + (it.danger ? ' danger' : ''), role: 'menuitem', onclick: () => { closeMenu(); it.action(); } }, icon(it.icon), h('span', null, it.label))));
    menu._owner = btn; document.body.append(menu);
    const r = btn.getBoundingClientRect();
    menu.style.top = Math.max(8, Math.min(window.innerHeight - menu.offsetHeight - 8, r.bottom + 6)) + 'px';
    menu.style.left = Math.max(8, r.right - menu.offsetWidth) + 'px';
    openMenu = menu;
  });
  return btn;
}
const toggle = (input, label, hint) => h('label', { class: 'switch' }, input, h('span', { class: 'track', 'aria-hidden': 'true' }), h('span', { class: 'switch-copy' }, h('b', null, label), hint ? h('small', { class: 'muted' }, hint) : null));
const scorePill = (score) => h('span', { class: 'score-pill' }, icon('star', 13), Number(score).toFixed(1));

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
  const dlg = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  const head = h('div', { class: 'dialog-head' }, h('h2', null, title),
    options.locked ? null : h('button', { class: 'icon-btn', 'aria-label': t('close'), title: t('close'), onclick: close }, icon('close')));
  const items = [].concat(bodyBuilder(close)).flat().filter(Boolean);
  const foot = items.filter((i) => i.classList && i.classList.contains('foot'));
  const body = h('div', { class: 'dialog-body' }); body.append(...items.filter((i) => !foot.includes(i)));
  dlg.append(head, body, ...foot);
  scrim.append(dlg);
  scrim.addEventListener('keydown', (e) => { if (!options.locked && e.key === 'Escape') close(); });
  root.append(scrim);
  const first = body.querySelector('input:not([type=checkbox]), textarea, select');
  if (first) first.focus();
  return close;
}
const field = (label, input) => h('label', { class: 'field' }, h('span', null, label), input);

/* ---------- rail + player bar ---------- */
function renderRail() {
  const v = state.view.name; const hasMpv = !!state.lib.settings.mpvPath;
  const navBtn = (label, ico, onclick, current) => h('button', { class: 'nav', 'aria-current': current ? 'page' : null, onclick }, icon(ico, 19), h('span', null, label));
  $('#rail').replaceChildren(
    h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, icon('play', 17)), h('span', { class: 'brand-copy' }, h('b', null, 'Anime Player'), h('small', null, 'mpv + Anime4K'))),
    h('div', { class: 'nav-label' }, t('navBrowse')),
    navBtn(t('library'), 'library', () => go({ name: 'home' }), v === 'home' || v === 'series' || v === 'ratings-chart'),
    navBtn(t('stats'), 'stats', () => go({ name: 'stats' }), v === 'stats'),
    h('div', { class: 'nav-label' }, t('navTools')),
    navBtn(t('openLink'), 'link', openLinkDialog, false),
    navBtn(t('shortcuts'), 'keyboard', () => go({ name: 'shortcuts' }), v === 'shortcuts'),
    navBtn(t('settings'), 'settings', openSettings, false),
    h('div', { class: 'spacer' }),
    h('button', { class: 'mpvstat' + (hasMpv ? '' : ' bad'), onclick: openSettings },
      h('span', { class: 'status-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'status-copy' }, h('b', null, hasMpv ? t('mpvReady') : t('mpvMissing')), hasMpv ? h('small', null, `Anime4K · ${presetLabel(defaultPreset())}`) : null)),
  );
}
function renderPlayer() {
  const p = state.player; const el = $('#nowplaying');
  el.hidden = !p.playing;
  if (!p.playing) return;
  const s = p.seriesId && getSeries(p.seriesId);
  const ep = s && s.episodes.find((item) => item.id === p.episodeId);
  const hasIntro = ep && Array.isArray(ep.skipTimes) && ep.skipTimes.some((x) => ['op', 'mixed-op'].includes(x.skipType));
  const hasEnding = ep && Array.isArray(ep.skipTimes) && ep.skipTimes.some((x) => ['ed', 'mixed-ed', 'mixed-ending'].includes(x.skipType));
  const skipIntro = s && (hasIntro || Number(s.introDuration) > 0)
    ? h('button', { class: 'btn sm', onclick: () => call('player:skipIntro') }, t('skipIntro'))
    : null;
  const skipEnding = s && (hasEnding || Number(s.outroDuration) > 0)
    ? h('button', { class: 'btn sm', onclick: () => call('player:skipEnding') }, t('skipEnding'))
    : null;
  el.replaceChildren(...[h('span', { class: 'live-dot', 'aria-hidden': 'true' }),
    h('div', { class: 't' }, h('b', null, p.title), h('span', { class: 'chip live' }, `Anime4K ${p.preset}`)),
    h('span', { class: 'muted small hint' }, t('keyboardHint')),
    skipIntro, skipEnding,
    h('button', { class: 'btn sm danger', onclick: () => call('player:stop') }, t('stop'))].filter(Boolean)); // replaceChildren(null) scriverebbe "null"

}

/* ---------- navigazione ---------- */
function go(view) {
  state.view = view; render(); $('#main').scrollTop = 0;
  if (view.name === 'series' && view.episodeId) {
    requestAnimationFrame(() => document.querySelector(`[data-episode-id="${CSS.escape(view.episodeId)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  }
  if (view.name === 'series' || view.name === 'ratings-chart') loadSeriesRatings(view.id);
}
async function loadSeriesRatings(id) {
  const s = getSeries(id);
  if (!s || state.ratingLoads[id]) return;
  state.ratingLoads[id] = true;
  try { state.lib = await call('series:ratings', id); state.stats = null; render(); } catch { /* stored metadata remains visible */ }
}
function render() {
  closeMenu();
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
  const totalEps = state.lib.series.reduce((n, x) => n + episodeTotal(x), 0);
  const search = h('div', { class: 'search-shell' },
    icon('search', 16),
    h('input', { class: 'search', type: 'search', placeholder: t('filterLibrary'), value: state.filter, 'aria-label': t('filterLibrary'), oninput: (e) => { state.filter = e.target.value; const pos = e.target.selectionStart; render(); const n = $('.search'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } } }),
    state.filter ? h('button', { class: 'search-clear', type: 'button', 'aria-label': t('clearSearch'), title: t('clearSearch'), onclick: () => { state.filter = ''; render(); } }, icon('close', 14)) : null);
  const filter = h('select', { class: 'input select library-filter', 'aria-label': t('filterProgress'), value: state.progressFilter, onchange: (e) => { state.progressFilter = e.target.value; render(); } },
    h('option', { value: 'all' }, t('all')),
    h('option', { value: 'progress' }, t('resume')),
    h('option', { value: 'started' }, t('started')),
    h('option', { value: 'unwatched' }, t('unwatched')),
    h('option', { value: 'watched' }, t('withWatched')));
  const sort = h('select', { class: 'input select library-sort', 'aria-label': t('sortBy'), value: state.sort, onchange: (e) => { state.sort = e.target.value; render(); } },
    h('option', { value: 'title' }, t('sortTitle')),
    h('option', { value: 'recent' }, t('sortRecent')),
    h('option', { value: 'rating' }, t('sortRating')));
  const posterCard = (s) => {
    const total = episodeTotal(s); const seen = s.episodes.filter((e) => e.progress.watched).length;
    const personal = effectivePersonalRating(s); const seenPct = total ? (seen / total) * 100 : 0;
    return h('button', { class: 'poster', onclick: () => go({ name: 'series', id: s.id }) },
      h('div', { class: 'cover', style: bg(s.cover) },
        s.cover ? null : s.title.slice(0, 1).toUpperCase(),
        h('span', { class: 'poster-play', 'aria-hidden': 'true' }, icon('play', 18)),
        total ? h('span', { class: 'poster-badge' }, `${total} EP`) : null,
        s.status === 'RELEASING' ? h('span', { class: 'poster-live' }, t('airing')) : null,
        seenPct > 0 ? h('div', { class: 'bar' }, h('i', { style: { width: seenPct + '%' } })) : null),
      h('div', { class: 't' }, s.title),
      h('div', { class: 'poster-meta' }, [total ? t('watchedOf', seen, total) : t('noEpisodes'), personal != null ? `★ ${personal.toFixed(1)}` : null].filter(Boolean).join('  ·  ')));
  };
  const featuredTarget = featured && resumeTarget(featured);
  const resuming = featuredTarget && featuredTarget.progress.pos > 0 && !featuredTarget.progress.watched;
  const featuredHero = featured ? h('section', { class: 'home-featured', style: { '--bg': featured.banner || featured.cover ? `url("${featured.banner || featured.cover}")` : 'none' } },
    h('div', { class: 'featured-copy' },
      h('span', { class: 'eyebrow' }, resuming ? t('continueWatching') : t('featured')),
      h('h2', null, featured.title),
      h('div', { class: 'meta-row' },
        featured.score != null ? scorePill(featured.score) : null,
        [featured.year, featured.format && featured.format.replace('_', ' '), episodeTotal(featured) ? `${episodeTotal(featured)} ${t('episodes').toLowerCase()}` : null, statusLabel(featured)].filter(Boolean).map((x) => h('span', { class: 'meta-item' }, x))),
      featured.description ? h('p', null, featured.description) : null,
      h('div', { class: 'row wrap featured-actions' },
        h('button', { class: 'btn primary lg', onclick: () => featuredTarget ? play(featured.id, featuredTarget.id) : go({ name: 'series', id: featured.id }) }, icon('play', 16), featuredTarget ? `${resuming ? t('resume') : t('watch')} · ${t('episode', featuredTarget.number)}` : t('details')),
        h('button', { class: 'btn ghost lg', onclick: () => go({ name: 'series', id: featured.id }) }, t('details'))),
      resuming && pct(featuredTarget) ? h('div', { class: 'featured-progress', 'aria-hidden': 'true' }, h('div', { class: 'bar' }, h('i', { style: { width: pct(featuredTarget) + '%' } }))) : null),
    featured.cover ? h('div', { class: 'featured-poster', style: bg(featured.cover) }) : null) : null;
  const continueCards = cont.map(({ s, e }) => {
    const media = h('div', { class: 'pic', style: bg(e.thumb || s.banner || s.cover) },
      h('span', { class: 'resume-play', 'aria-hidden': 'true' }, icon('play', 20)),
      h('span', { class: 'resume-badge' }, `EP ${e.number}`),
      pct(e) ? h('div', { class: 'bar' }, h('i', { style: { width: pct(e) + '%' } })) : null);
    const meta = h('div', { class: 'meta' },
      h('b', null, s.title),
      h('span', { class: 'muted small' }, `${t('episode', e.number)}${e.title ? ' · ' + e.title : ''}`),
      pct(e) ? h('span', { class: 'progress-label' }, `${Math.round(pct(e))}%`) : null);
    return h('button', { class: 'resume', onclick: () => play(s.id, e.id) }, media, meta);
  });
  const sectionHead = (title, count, action) => h('div', { class: 'section-head' }, h('h2', null, title, count != null ? h('span', { class: 'count' }, count) : null), action || null);
  const continueSection = cont.length ? h('section', { class: 'section' },
    sectionHead(t('continueWatching'), cont.length, h('button', { class: 'section-link', onclick: () => { state.progressFilter = 'progress'; render(); } }, t('seeAll'))),
    h('div', { class: 'strip' }, continueCards)) : null;
  const librarySection = list.length ? h('section', { class: 'section' },
    sectionHead(t('library'), list.length),
    h('div', { class: 'grid' }, list.map(posterCard))) : h('div', { class: 'empty' }, h('h2', null, state.lib.series.length ? t('noResults') : t('emptyLibrary')),
      state.lib.series.length ? t('noFilterMatch') : t('emptyLibraryHint'),
      state.lib.series.length ? null : h('div', null, h('button', { class: 'btn primary', onclick: openAddSeries }, icon('plus', 16), t('addFirstSeries'))));
  const recentSection = !q && state.progressFilter === 'all' && recent.length > 0
    ? h('section', { class: 'section recent-section' }, sectionHead(t('recentActivity')), h('div', { class: 'grid grid-compact' }, recent.map(posterCard)))
    : null;
  const schedule = !q && state.progressFilter === 'all' ? airingSections(list) : null;
  return h('div', { class: 'page' },
    h('div', { class: 'head' },
      h('div', { class: 'head-main' },
        h('div', null, h('span', { class: 'eyebrow' }, 'ANIME PLAYER'), h('h1', null, t('library')), h('p', { class: 'subtitle' }, t('librarySummary', state.lib.series.length, totalEps))),
        h('div', { class: 'head-actions' },
          h('button', { class: 'btn ghost', onclick: importLibrary }, icon('download', 16), h('span', { class: 'lbl' }, t('import'))),
          h('button', { class: 'btn ghost', onclick: exportLibrary }, icon('upload', 16), h('span', { class: 'lbl' }, t('export'))),
          h('button', { class: 'btn primary', onclick: openAddSeries }, icon('plus', 16), t('addSeries')))),
      h('div', { class: 'toolbar' }, search, filter, sort)),
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
        h('div', { class: 'completion' }, h('div', { class: 'bar' }, h('i', { style: { width: Math.min(100, Math.max(0, item.completion)) + '%' } })), h('span', null, `${Math.round(item.completion)}%`)),
        h('div', { class: 'muted small' }, `${t('watchedOf', item.watchedEpisodes, item.totalEpisodes)} · ${formatDuration(item.watchTime)}`),
        h('div', { class: 'muted small' }, `${t('lastActivity')}: ${item.lastActivity ? new Date(item.lastActivity).toLocaleDateString() : t('unavailable')}`),
        h('div', { class: 'muted small' }, details)));
  };
  const perSeries = (st.perSeries || []).length ? h('div', { class: 'stats-series-list' }, st.perSeries.map(renderSeriesStat)) : h('div', { class: 'empty' }, t('noResults'));
  return h('div', { class: 'page' },
    h('div', { class: 'head' }, h('div', { class: 'head-main' }, h('div', null, h('span', { class: 'eyebrow' }, 'ANIME PLAYER'), h('h1', null, t('stats'))),
      h('div', { class: 'head-actions' }, h('button', { class: 'btn ghost', onclick: async () => { state.stats = await call('stats:get'); render(); } }, icon('refresh', 16), t('refresh'))))),
    h('div', { class: 'stats-grid' },
      [['check', String(st.watchedEpisodes), t('watchedEpisodes'), 'accent'], ['clock', formatDuration(st.watchTime), t('watchTime'), 'accent'], ['flag', String(st.completedSeries), t('completedSeries'), 'accent'],
        ['library', String(st.seriesCount || 0), t('totalSeries')], ['list', String(st.episodesTotal || 0), t('totalEpisodes')], ['play', String(st.inProgressSeries || 0), t('inProgress')]]
        .map(([ico, value, label, kind]) => h('div', { class: 'stat-card' + (kind ? ' ' + kind : '') }, h('span', { class: 'stat-ico' }, icon(ico, 20)), h('div', null, h('b', null, value), h('span', { class: 'muted' }, label))))),
    h('section', { class: 'section stats-activity' }, h('div', { class: 'section-head' }, h('h2', null, t('recentActivity'))),
      activity.length ? h('div', { class: 'activity-list' }, activity.map((item) => h('button', { class: 'activity', onclick: () => go({ name: 'series', id: item.seriesId }) },
        h('span', { class: 'activity-thumb', style: bg((getSeries(item.seriesId) || {}).cover) }), h('span', null, h('b', null, item.seriesTitle), h('span', { class: 'muted small' }, `${t('episode', item.episodeNumber)} · ${item.title}`)),
        h('time', { class: 'muted small' }, new Date(item.updatedAt).toLocaleDateString())))) :
        h('div', { class: 'empty' }, t('noActivity'))),
    h('section', { class: 'section stats-activity' }, h('div', { class: 'section-head' }, h('h2', null, t('perAnime'))), perSeries));
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
  const resuming = target && target.progress.pos > 0 && !target.progress.watched;
  const total = episodeTotal(s); const seen = s.episodes.filter((e) => e.progress.watched).length;
  const metaParts = [
    s.year,
    s.format && s.format.replace('_', ' '),
    total ? `${total} ${t('episodes').toLowerCase()}` : null,
  ].filter(Boolean);
  const knownSkip = s.episodes.filter((e) => Array.isArray(e.skipTimes) && e.skipTimes.some((x) => ['op', 'ed', 'mixed-op', 'mixed-ed'].includes(x.skipType))).length;
  const ratingBtn = h('button', {
    class: 'rating-badge-btn',
    title: t('viewRatingsChart'),
    onclick: () => go({ name: 'ratings-chart', id: s.id }),
  }, icon('star', 14), s.score != null ? `${Number(s.score).toFixed(1)}/10${s.scoreSource ? ` · ${s.scoreSource}` : ''}` : t('ratingUnavailable'));
  const metaRow = h('div', { class: 'meta-row' }, ratingBtn, metaParts.map((x) => h('span', { class: 'meta-item' }, x)));
  const personal = effectivePersonalRating(s);
  const rate = h('label', { class: 'rate-inline' }, icon('star', 14), h('span', null, t('personalRating')),
    h('input', { class: 'input rating-input', type: 'number', min: '0', max: '10', step: '0.1', value: personal == null ? '' : personal, placeholder: s.personalRating == null && s.episodes.some((e) => e.personalRating != null) ? t('episodeAverage') : '—', onchange: (e) => mutate('series:update', s.id, { personalRating: e.target.value === '' ? null : Number(e.target.value) }) }));
  const actions = h('div', { class: 'row wrap actions' },
    target ? h('button', { class: 'btn primary lg', onclick: () => play(s.id, target.id) }, icon('play', 16), `${resuming ? t('resume') : t('watch')} · ${t('episode', target.number)}`) : null,
    h('button', { class: target ? 'btn' : 'btn primary', onclick: () => openAddLinks(s) }, icon('plus', 16), t('addLinks')),
    h('button', { class: 'btn ghost', onclick: () => go({ name: 'ratings-chart', id: s.id }) }, icon('chart', 16), t('ratingsChart')),
    s.anilistId ? h('button', { class: 'btn ghost', onclick: async () => { toast(t('infoUpdating')); await mutate('series:refresh', s.id); toast(t('infoUpdated')); } }, icon('refresh', 16), t('updateInfo')) : null,
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn ghost danger', onclick: () => { if (confirm(t('confirmDelete', s.title))) mutate('series:delete', s.id).then(() => go({ name: 'home' })); } }, icon('trash', 16), t('deleteSeries')));
  const heroBody = h('div', { class: 'body' },
    h('div', { class: 'cover', style: bg(s.cover) }),
    h('div', { class: 'info' }, h('h1', null, s.title), metaRow,
      h('div', { class: 'chips' }, (s.genres || []).slice(0, 6).map((g) => h('span', { class: 'chip' }, g)), statusLabel(s) ? h('span', { class: 'chip active' }, statusLabel(s)) : null),
      s.status === 'RELEASING' && s.nextAiringAt ? h('div', { class: 'muted small airing-next' }, icon('clock', 14), `${t('nextEpisode')}: ${t('episode', s.nextEpisode || '?')} · ${new Date(s.nextAiringAt).toLocaleString()}`) : null,
      knownSkip ? h('div', { class: 'muted small skip-summary' }, t('skipAvailable') + ` · ${knownSkip} ${t('episodes').toLowerCase()}`) : h('div', { class: 'muted small skip-summary' }, t('skipCheckedOnPlay')),
      total ? h('div', { class: 'series-progress' }, h('div', { class: 'bar' }, h('i', { style: { width: (seen / total) * 100 + '%' } })), h('span', { class: 'muted small' }, t('watchedOf', seen, total))) : null,
      desc, more, rate, actions));
  const hero = h('section', { class: 'hero', style: { '--bg': s.banner || s.cover ? `url("${s.banner || s.cover}")` : 'none' } },
    h('button', { class: 'link back', onclick: () => go({ name: 'home' }) }, icon('back', 16), t('backLibrary').replace(/^←\s*/, '')), heroBody);
  const advanced = h('details', { class: 'adv' }, h('summary', null, t('advanced')),
    field(t('referer'), h('input', { class: 'input', value: s.referer || '', placeholder: 'https://…', onchange: (e) => mutate('series:update', s.id, { referer: e.target.value.trim() }) })),
    h('div', { class: 'two' },
      field(t('introDuration'), h('input', { class: 'input', type: 'number', min: '0', step: '1', value: Number(s.introDuration) || 0, onchange: (e) => mutate('series:update', s.id, { introDuration: Math.max(0, Number(e.target.value) || 0) }) })),
      field(t('outroDuration'), h('input', { class: 'input', type: 'number', min: '0', step: '1', value: Number(s.outroDuration) || 0, onchange: (e) => mutate('series:update', s.id, { outroDuration: Math.max(0, Number(e.target.value) || 0) }) }))));
  const a4k = h('section', { class: 'a4k' },
    h('div', { class: 'a4k-head' }, h('h3', null, t('anime4kSeries')), h('span', { class: 'chip live' }, presetLabel(eff))),
    h('div', { class: 'muted small a4k-hint' }, t('activePreset', presetLabel(eff))),
    h('div', { class: 'a4k-controls' },
      h('div', { class: 'ctl' }, h('span', { class: 'ctl-label' }, t('mode')), h('div', { class: 'seg', role: 'group', 'aria-label': t('mode') }, modeBtns)),
      h('div', { class: 'ctl' }, h('span', { class: 'ctl-label' }, t('quality')), h('div', { class: 'seg', role: 'group', 'aria-label': t('quality') }, tierBtns))),
    advanced);
  const episodeContent = s.episodes.length
    ? h('div', { class: 'eps' }, s.episodes.map((e) => episodeRow(s, e)))
    : h('div', { class: 'empty' }, h('h2', null, t('noEpisodeYet')), t('addLinksHint'),
      h('div', null, h('button', { class: 'btn primary', onclick: () => openAddLinks(s) }, icon('plus', 16), t('addLinks'))));
  return h('div', { class: 'page' }, hero, castRelatedSection(s), a4k, h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', null, t('episodes'), h('span', { class: 'count' }, s.episodes.length))), episodeContent));
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
  const back = h('button', { class: 'ratings-chart-back link', onclick: () => go({ name: 'series', id: s.id }) }, icon('back', 16), t('backToAnime').replace(/^←\s*/, ''));

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
    const librarySeason = detectSeasonFromTitle(s.title);
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
          const libraryEpisode = sn.season === librarySeason
            ? s.episodes.find((item) => Number(item.number) === Number(ep.number))
            : null;
          const cell = h('td', null,
            h('div', {
              class: `ratings-cell rating-tier-${tier}${libraryEpisode ? ' is-in-library' : ''}`,
              title: `S${sn.season} E${ep.number}: ${ep.title || t('episode', ep.number)} · ${ep.rating.toFixed(1)} ★ (${tier})`,
              role: libraryEpisode ? 'button' : null,
              tabindex: libraryEpisode ? '0' : null,
              'aria-label': libraryEpisode ? `${s.title} · ${t('episode', libraryEpisode.number)} · ${t('openEpisode')}` : null,
              onclick: libraryEpisode ? () => go({ name: 'series', id: s.id, episodeId: libraryEpisode.id }) : null,
              onkeydown: libraryEpisode ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); go({ name: 'series', id: s.id, episodeId: libraryEpisode.id }); }
              } : null,
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
  const priorThumbs = new Set(s.episodes.filter((item) => item.number < e.number).map((item) => item.thumb).filter(Boolean));
  const distinctThumb = e.thumb && !priorThumbs.has(e.thumb);
  const image = distinctThumb ? e.thumb : (s.banner || null);
  const seed = (Number(e.number) * 47 + String(e.title || '').length * 13) % 360;
  const visualStyle = { ...bg(image), '--ep-hue': `${seed}deg`, '--ep-pos': `${20 + (seed % 61)}%` };
  const label = p.watched ? t('rewatch') : resume ? t('resume') : t('watch');
  const generated = !distinctThumb && !image;
  const thumb = h('div', { class: 'th' + (image ? '' : ' fallback') + (generated ? ' generated' : ''), style: visualStyle, title: distinctThumb ? '' : t('noThumbnail'), onclick: () => { if (has) play(s.id, e.id); } },
    h('span', { class: 'ep-badge' }, String(e.number)),
    generated ? h('span', { class: 'th-title' }, e.title || t('episode', e.number)) : null,
    has ? h('span', { class: 'th-play', 'aria-hidden': 'true' }, icon('play', 18)) : null,
    pct(e) && !p.watched ? h('div', { class: 'bar' }, h('i', { style: { width: pct(e) + '%' } })) : null);
  const skipKinds = new Set((e.skipTimes || []).map((x) => x.skipType));
  const skipAvailable = skipKinds.has('op') || skipKinds.has('ed') || skipKinds.has('mixed-op') || skipKinds.has('mixed-ed');
  const skipChip = skipAvailable ? h('span', { class: 'chip active' }, t('skipAvailable')) : null;
  const status = p.watched ? h('span', { class: 'chip ok' }, icon('check', 12), t('watched'))
    : resume ? h('span', { class: 'chip live' }, `${t('resumeStatus')}${pct(e) ? ' · ' + Math.round(pct(e)) + '%' : ''}`)
    : !has ? h('span', { class: 'chip warn' }, t('noLink')) : null;
  const meta = [skipChip, e.duration ? formatDuration(e.duration) : null, has ? t('sources', e.sources.length) : null].filter(Boolean);
  const info = h('div', { class: 'ep-info' },
    h('div', { class: 'name' }, e.title || t('episode', e.number)),
    h('div', { class: 'ep-meta' }, status, ...meta.map((item) => typeof item === 'string' ? h('span', { class: 'muted small' }, item) : item),
      e.rating != null ? h('span', { class: 'ep-rating', title: e.ratingSource || '' }, icon('star', 12), Number(e.rating).toFixed(1)) : null,
      h('label', { class: 'rate-inline mini', title: t('personalRating') }, h('span', null, t('yourRating')),
        h('input', { class: 'input rating-input', type: 'number', min: '0', max: '10', step: '0.1', placeholder: '—', value: e.personalRating == null ? '' : e.personalRating, onchange: (ev) => mutate('episodes:rate', s.id, e.id, ev.target.value === '' ? null : Number(ev.target.value)) }))));
  const acts = h('div', { class: 'acts' },
    h('button', { class: 'btn sm' + (has ? ' primary' : ''), disabled: !has, onclick: () => play(s.id, e.id) }, icon('play', 13), label),
    menuButton(t('moreActions'), [
      { icon: 'link', label: t('link'), action: () => openEditLinks(s, e) },
      { icon: p.watched ? 'eye' : 'check', label: p.watched ? t('markUnwatched') : t('markWatched'), action: () => mutate('episodes:mark', s.id, e.id, !p.watched) },
      { icon: 'trash', label: t('delete'), danger: true, action: () => mutate('episodes:delete', s.id, e.id) },
    ]));
  return h('div', { class: 'ep' + (p.watched ? ' done' : ''), 'data-episode-id': e.id }, thumb, info, acts);
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
    const preset = h('select', { class: 'input select', value: st.defaultPreset }, state.presets.map((p) => h('option', { value: p.id }, p.label)));
    preset.value = st.defaultPreset || 'aa-hq';
    const theme = h('select', { class: 'input select', value: st.theme || 'default' },
      h('option', { value: 'default' }, t('default')),
      h('option', { value: 'compact' }, t('compact')));
    const language = h('select', { class: 'input select', value: st.language || 'en' },
      h('option', { value: 'en' }, 'English'),
      h('option', { value: 'it' }, 'Italiano'));
    const auto = h('input', { type: 'checkbox' }); auto.checked = !!st.autoplayNext;
    const alang = h('input', { class: 'input', value: st.alang || '' });
    const slang = h('input', { class: 'input', value: st.slang || '' });
    const ua = h('input', { class: 'input', value: st.userAgent || '', placeholder: t('userAgentPlaceholder') });
    const extra = h('input', { class: 'input', value: st.extraArgs || '', placeholder: 'es. --fullscreen --volume=70' });
    const skipOpening = h('input', { type: 'checkbox' }); skipOpening.checked = !!st.skipOpening;
    const skipEnding = h('input', { type: 'checkbox' }); skipEnding.checked = !!st.skipEnding;
    const sec = (title, ...kids) => h('section', { class: 'form-section' }, h('h3', null, title), kids);
    return [
      sec(t('secPlayer'),
        field(t('mpvPath'), h('div', { class: 'row' }, mpv,
          h('button', { class: 'btn', onclick: async () => { const r = await call('mpv:detect'); if (r.path) { mpv.value = r.path; state.lib = r.lib; render(); toast(t('detectMpv')); } else toast(t('detectMpvMissing'), 'error'); } }, t('find')),
          h('button', { class: 'btn', onclick: async () => { const l = await call('mpv:browse'); state.lib = l; mpv.value = l.settings.mpvPath || ''; render(); } }, t('browse')))),
        h('div', { class: 'muted small setup-note' }, t('mpvExternalNote')),
        field(t('defaultAnime4K'), preset)),
      sec(t('secPlayback'),
        toggle(auto, t('autoplay')), toggle(skipOpening, t('autoSkipOpening')), toggle(skipEnding, t('autoSkipEnding')),
        h('div', { class: 'two' }, field(t('audioLanguages'), alang), field(t('subtitleLanguages'), slang))),
      sec(t('secAppearance'), h('div', { class: 'two' }, field(t('interfaceTheme'), theme), field(t('primaryLanguage'), language))),
      sec(t('secAdvanced'), field(t('userAgent'), ua), field(t('extraArgs'), extra)),
      h('div', { class: 'foot' }, h('span', { class: 'muted small app-version' }, `${t('appVersion')}: ${state.version || '—'}`), h('button', { class: 'btn', onclick: close }, t('cancel')),
        h('button', { class: 'btn primary', onclick: async () => { await mutate('settings:set', { mpvPath: mpv.value.trim(), defaultPreset: preset.value, theme: theme.value, language: language.value, autoplayNext: auto.checked, skipOpening: skipOpening.checked, skipEnding: skipEnding.checked, alang: alang.value.trim(), slang: slang.value.trim(), userAgent: ua.value.trim(), extraArgs: extra.value.trim() }); toast(t('saved')); close(); } }, t('save')))];
  });
}

function shortcutsView() {
  const shortcuts = { next: 'PGDWN', previous: 'PGUP', skipIntro: '', skipEnding: '', ...(state.lib.settings.shortcuts || {}) };
  const inputs = Object.fromEntries(Object.entries(shortcuts).map(([key, value]) => [key, h('input', { class: 'input', value: value || '', placeholder: t('shortcutUnset') })]));
  return h('div', { class: 'page' },
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
