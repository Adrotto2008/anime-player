'use strict';
const api = window.animeApi; // il ponte si chiama animeApi: un `const api` accanto a `window.api` darebbe errore di ridichiarazione
const state = { lib: { series: [], settings: {} }, presets: [], view: { name: 'home' }, filter: '', player: { playing: false } };

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
async function call(ch, ...args) {
  try { return await api.invoke(ch, ...args); } catch (e) { toast(cleanErr(e), 'error'); throw e; }
}
async function mutate(ch, ...args) { const lib = await call(ch, ...args); if (lib && lib.series) { state.lib = lib; render(); } return lib; }

const getSeries = (id) => state.lib.series.find((s) => s.id === id);
const presetLabel = (id) => (state.presets.find((p) => p.id === id) || {}).label || id;
const defaultPreset = () => state.lib.settings.defaultPreset || 'aa-hq';

/* ---------- dialog ---------- */
function openDialog(title, bodyBuilder) {
  const root = $('#dialog-root');
  const close = () => { scrim.remove(); };
  const scrim = h('div', { class: 'scrim', onmousedown: (e) => { if (e.target === scrim) close(); } });
  const dlg = h('div', { class: 'dialog', role: 'dialog', 'aria-label': title }, h('h2', null, title));
  dlg.append(...[].concat(bodyBuilder(close)));
  scrim.append(dlg);
  scrim.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
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
    h('div', { class: 'brand' }, 'Anime Player', h('small', null, 'mpv + Anime4K')),
    h('button', { class: 'nav', 'aria-current': v === 'home' || v === 'series' ? 'page' : null, onclick: () => go({ name: 'home' }) }, 'Libreria'),
    h('button', { class: 'nav', onclick: openLinkDialog }, 'Apri un link'),
    h('button', { class: 'nav', onclick: openSettings }, 'Impostazioni'),
    h('div', { class: 'spacer' }),
    h('button', { class: 'mpvstat' + (hasMpv ? '' : ' bad'), onclick: openSettings }, hasMpv ? 'mpv pronto' : 'mpv non trovato: configuralo'),
  );
}
function renderPlayer() {
  const p = state.player; const el = $('#nowplaying');
  el.hidden = !p.playing;
  if (!p.playing) return;
  el.replaceChildren(h('span', { class: 'dot' }), h('div', { class: 't' }, h('b', null, p.title), h('span', { class: 'muted' }, `  ·  Anime4K ${p.preset}`)),
    h('span', { class: 'muted small' }, 'Ctrl+1…6 Fast · Alt+1…6 HQ · Ctrl+0 spento · PgDown prossimo'),
    h('button', { class: 'btn sm', onclick: () => call('player:stop') }, 'Ferma'));
}

/* ---------- navigazione ---------- */
function go(view) { state.view = view; render(); $('#main').scrollTop = 0; }
function render() {
  renderRail(); renderPlayer();
  const main = $('#main');
  if (document.activeElement && main.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
  main.replaceChildren(state.view.name === 'series' && getSeries(state.view.id) ? seriesView(getSeries(state.view.id)) : homeView());
}

/* ---------- home ---------- */
function continueItems() {
  const out = [];
  for (const s of state.lib.series) {
    let last = null;
    for (const e of s.episodes) if (e.progress.updatedAt && (!last || e.progress.updatedAt > last.progress.updatedAt)) last = e;
    if (!last) continue;
    let target = null;
    if (!last.progress.watched && last.sources.length) target = last;
    else target = s.episodes.slice(s.episodes.indexOf(last) + 1).find((e) => e.sources.length && !e.progress.watched);
    if (target) out.push({ s, e: target });
  }
  return out.sort((a, b) => b.s.lastWatchedAt - a.s.lastWatchedAt).slice(0, 8);
}
const pct = (e) => (e.progress.duration > 0 && e.progress.pos > 0 ? Math.min(100, (e.progress.pos / e.progress.duration) * 100) : 0);

function homeView() {
  const q = state.filter.trim().toLowerCase();
  const list = state.lib.series.filter((s) => !q || s.title.toLowerCase().includes(q)).sort((a, b) => a.title.localeCompare(b.title));
  const cont = q ? [] : continueItems();
  const search = h('input', { class: 'input search', type: 'search', placeholder: 'Filtra la libreria', value: state.filter, 'aria-label': 'Filtra la libreria', oninput: (e) => { state.filter = e.target.value; const pos = e.target.selectionStart; render(); const n = $('.search'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } } });
  return h('div', null,
    h('div', { class: 'head' }, h('h1', null, 'Libreria'), h('div', { class: 'row' }, search, h('button', { class: 'btn primary', onclick: openAddSeries }, 'Aggiungi serie'))),
    cont.length ? h('section', { class: 'section' }, h('h2', null, 'Continua a guardare'),
      h('div', { class: 'strip' }, cont.map(({ s, e }) => h('button', { class: 'resume', onclick: () => play(s.id, e.id) },
        h('div', { class: 'pic', style: bg(e.thumb || s.banner || s.cover) }, pct(e) ? h('div', { class: 'bar' }, h('i', { style: { width: pct(e) + '%' } })) : null),
        h('div', { class: 'meta' }, h('b', null, s.title), h('span', { class: 'muted small' }, `Episodio ${e.number}${e.title ? ' · ' + e.title : ''}`)))))) : null,
    list.length ? h('div', { class: 'grid' }, list.map((s) => {
      const seen = s.episodes.filter((e) => e.progress.watched).length;
      return h('button', { class: 'poster', onclick: () => go({ name: 'series', id: s.id }) },
        h('div', { class: 'cover', style: bg(s.cover) }, s.cover ? null : s.title.slice(0, 1).toUpperCase()),
        h('div', { class: 't' }, s.title),
        h('div', { class: 'muted small' }, s.episodes.length ? `${seen} di ${s.episodes.length} visti` : 'Nessun episodio'));
    })) : h('div', { class: 'empty' }, h('h2', null, state.lib.series.length ? 'Nessun risultato' : 'La libreria è vuota'),
      state.lib.series.length ? 'Nessuna serie corrisponde al filtro.' : 'Cerca un anime per scaricare poster e titoli degli episodi, poi incolla i link delle puntate.',
      state.lib.series.length ? null : h('div', null, h('button', { class: 'btn primary', onclick: openAddSeries }, 'Aggiungi la prima serie'))));
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
    h('button', { 'aria-pressed': String(!s.preset), onclick: () => setPreset(null) }, 'Predefinito'),
    h('button', { 'aria-pressed': String(s.preset === 'off'), onclick: () => setPreset('off') }, 'Spento'),
    ...MODES.map(([id, label]) => h('button', { 'aria-pressed': String(!!s.preset && effMode === id), onclick: () => setPreset(`${id}-${s.preset ? effTier : 'fast'}`) }, label)),
  ];
  const tierBtns = ['fast', 'hq'].map((t) => h('button', { 'aria-pressed': String(!!s.preset && s.preset !== 'off' && effTier === t), disabled: !s.preset || s.preset === 'off', onclick: () => setPreset(`${effMode}-${t}`) }, t === 'fast' ? 'Fast' : 'HQ'));

  const desc = h('div', { class: 'desc' }, s.description || 'Nessuna descrizione.');
  const more = s.description && s.description.length > 260 ? h('button', { class: 'link', onclick: (e) => { desc.classList.toggle('open'); e.target.textContent = desc.classList.contains('open') ? 'Mostra meno' : 'Leggi tutto'; } }, 'Leggi tutto') : null;
  const meta = [s.year, s.format && s.format.replace('_', ' '), s.score ? `★ ${s.score.toFixed(1)}` : null, s.episodeCount ? `${s.episodeCount} episodi` : null].filter(Boolean).join('  ·  ');

  return h('div', null,
    h('section', { class: 'hero', style: { '--bg': s.banner || s.cover ? `url("${s.banner || s.cover}")` : 'none' } },
      h('button', { class: 'link back', onclick: () => go({ name: 'home' }) }, '← Libreria'),
      h('div', { class: 'body' }, h('div', { class: 'cover', style: bg(s.cover) }),
        h('div', null, h('h1', null, s.title), h('div', { class: 'muted' }, meta),
          h('div', { class: 'chips' }, (s.genres || []).slice(0, 6).map((g) => h('span', { class: 'chip' }, g))), desc, more,
          h('div', { class: 'row wrap', style: { marginTop: '14px' } },
            h('button', { class: 'btn primary', onclick: () => openAddLinks(s) }, 'Aggiungi link'),
            s.anilistId ? h('button', { class: 'btn', onclick: async () => { toast('Aggiorno le informazioni…'); await mutate('series:refresh', s.id); toast('Informazioni aggiornate'); } }, 'Aggiorna info') : null,
            h('button', { class: 'btn danger', onclick: () => { if (confirm(`Eliminare "${s.title}" dalla libreria? I link e i progressi andranno persi.`)) mutate('series:delete', s.id).then(() => go({ name: 'home' })); } }, 'Elimina serie'))))),
    h('section', { class: 'a4k' }, h('h3', null, 'Anime4K per questa serie'),
      h('div', { class: 'muted small', style: { marginBottom: '10px' } }, `Attivo: ${presetLabel(eff)}. Fast è pensato per GPU come la GTX 1650, HQ per schede più potenti. Dentro mpv puoi cambiarlo al volo con Ctrl+1…6.`),
      h('div', { class: 'row wrap' }, h('div', { class: 'seg', role: 'group', 'aria-label': 'Modo' }, modeBtns), h('div', { class: 'seg', role: 'group', 'aria-label': 'Qualità' }, tierBtns)),
      h('details', { class: 'adv' }, h('summary', null, 'Opzioni avanzate'),
        field('Referer (solo se il sito dei video lo richiede)', h('input', { class: 'input', value: s.referer || '', placeholder: 'https://…', onchange: (e) => mutate('series:update', s.id, { referer: e.target.value.trim() }) })))),
    h('section', null, h('h2', { style: { marginBottom: '12px' } }, 'Episodi'),
      s.episodes.length ? h('div', { class: 'eps' }, s.episodes.map((e) => episodeRow(s, e))) :
        h('div', { class: 'empty' }, h('h2', null, 'Ancora nessun episodio'), 'Aggiungi i link: un pattern come ep{ep}.mp4 crea tutti gli episodi in un colpo solo.', h('div', null, h('button', { class: 'btn primary', onclick: () => openAddLinks(s) }, 'Aggiungi link')))));
}

function episodeRow(s, e) {
  const has = e.sources.length > 0; const p = e.progress; const resume = !p.watched && p.pos > 10;
  return h('div', { class: 'ep' + (p.watched ? ' done' : '') },
    h('div', { class: 'th', style: bg(e.thumb || s.banner || s.cover) }, e.thumb ? null : h('span', { class: 'num' }, String(e.number)), pct(e) && !p.watched ? h('div', { class: 'bar' }, h('i', { style: { width: pct(e) + '%' } })) : null),
    h('div', null, h('div', { class: 'name' }, `${e.number}. ${e.title || 'Episodio ' + e.number}`),
      h('div', { class: 'muted small' }, has ? `${e.sources.length} ${e.sources.length === 1 ? 'sorgente' : 'sorgenti'}${p.watched ? ' · visto' : resume ? ' · da riprendere' : ''}` : 'Nessun link')),
    h('div', { class: 'acts' },
      h('button', { class: 'btn sm' + (has ? ' primary' : ''), disabled: !has, onclick: () => play(s.id, e.id) }, p.watched ? 'Rivedi' : resume ? 'Riprendi' : 'Guarda'),
      h('button', { class: 'btn sm', onclick: () => openEditLinks(s, e) }, 'Link'),
      h('button', { class: 'btn sm', onclick: () => mutate('episodes:mark', s.id, e.id, !p.watched) }, p.watched ? 'Non visto' : 'Visto'),
      h('button', { class: 'btn sm danger', onclick: () => mutate('episodes:delete', s.id, e.id) }, 'Elimina')));
}

async function play(sid, eid) { try { await call('player:play', sid, eid); } catch { /* toast già mostrato */ } }

/* ---------- dialoghi ---------- */
function openAddSeries() {
  openDialog('Aggiungi una serie', (close) => {
    const q = h('input', { class: 'input', placeholder: 'Titolo dell\'anime (es. Frieren)', 'aria-label': 'Titolo' });
    const results = h('div', { class: 'results' });
    const add = async (payload, btn) => {
      btn.disabled = true; btn.textContent = 'Aggiungo…';
      try { const r = await call('series:create', payload); state.lib = r.lib; close(); go({ name: 'series', id: r.id }); } catch { btn.disabled = false; btn.textContent = 'Aggiungi'; }
    };
    const search = async () => {
      const text = q.value.trim(); if (!text) return;
      results.replaceChildren(h('div', { class: 'muted' }, 'Cerco…'));
      try {
        const list = await call('series:search', text);
        results.replaceChildren(...(list.length ? list.map((m) => {
          const btn = h('button', { class: 'btn sm primary' }, 'Aggiungi'); btn.onclick = () => add({ anilistId: m.anilistId }, btn);
          return h('div', { class: 'res' }, h('div', { class: 'c', style: bg(m.cover) }), h('div', null, h('b', null, m.title), h('div', { class: 'muted small' }, [m.year, m.format && m.format.replace('_', ' '), m.episodeCount ? m.episodeCount + ' ep.' : null].filter(Boolean).join(' · '))), btn);
        }) : [h('div', { class: 'muted' }, 'Nessun risultato.')]));
      } catch { results.replaceChildren(); }
    };
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
    const manual = h('button', { class: 'link', onclick: async () => { const t = q.value.trim(); if (!t) { toast('Scrivi prima un titolo.', 'error'); return; } const r = await call('series:create', { title: t }); state.lib = r.lib; close(); go({ name: 'series', id: r.id }); } }, 'Aggiungi senza ricerca, solo con questo titolo');
    return [h('div', { class: 'row' }, q, h('button', { class: 'btn primary', onclick: search }, 'Cerca')), results, h('div', { style: { marginTop: '14px' } }, manual), h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: close }, 'Chiudi'))];
  });
}

function openAddLinks(s) {
  openDialog(`Aggiungi link a "${s.title}"`, (close) => {
    const fill = (pattern, n) => pattern.replace(/\{ep(?::(\d+))?\}/g, (_, w) => (w ? String(n).padStart(Number(w), '0') : String(n)));
    const defTo = String(s.episodeCount || s.episodes.length || 12);
    const range = () => { const from = h('input', { class: 'input', type: 'number', min: '0', value: '1' }); const to = h('input', { class: 'input', type: 'number', min: '0', value: defTo }); return { from, to, box: h('div', { class: 'two' }, field('Dall\'episodio', from), field('All\'episodio', to)) }; };
    let tab = 'link';

    /* --- scheda 1: da un link (riconosce da solo il numero) --- */
    const sample = h('input', { class: 'input', placeholder: 'Incolla il link di UN episodio (va bene anche il primo)' });
    const num = h('input', { class: 'input', type: 'number', min: '0' });
    const r1 = range();
    const chips = h('div', { class: 'chips' });
    const info = h('div', { class: 'mono muted' });
    let det = null; let chosen = 0; let timer = null;
    const paint = () => {
      chips.replaceChildren(); info.replaceChildren();
      if (!sample.value.trim()) return;
      if (!det) { info.textContent = 'Non trovo nessun numero in questo link: usa la scheda "Pattern" e scrivi {ep} dove cambia l\'episodio.'; return; }
      const c = det.candidates[chosen]; const url = sample.value.trim();
      if (det.candidates.length > 1) {
        chips.append(h('span', { class: 'muted small' }, 'Più numeri nel link, scegli quello dell\'episodio:'));
        det.candidates.forEach((k, i) => chips.append(h('button', { class: 'chip pick', 'aria-pressed': String(i === chosen), onclick: () => { chosen = i; num.value = k.number; paint(); } }, `…${url.slice(Math.max(0, k.index - 6), k.index)}[${k.text}]${url.slice(k.index + k.text.length, k.index + k.text.length + 6)}…`)));
      }
      const a = Number(r1.from.value); const z = Number(r1.to.value);
      info.append(h('div', null, 'Il numero dell\'episodio è ', h('b', null, c.text), c.width ? ` (scritto a ${c.width} cifre)` : ''), h('div', null, 'Primo: ', fill(c.pattern, a)), h('div', null, 'Ultimo: ', fill(c.pattern, z)));
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
    const lBox = h('div', null, field('Link di un episodio', sample), field('Questo link è l\'episodio numero (lo correggo io se sbaglio a leggerlo)', num), r1.box, chips, info);

    /* --- scheda 2: pattern scritto a mano --- */
    const pattern = h('input', { class: 'input', placeholder: 'https://sito.example/anime/ep{ep:02}.mp4' });
    const r2 = range();
    const pBox = h('div', { hidden: true }, field('Pattern del link — usa {ep} oppure {ep:02} per lo zero iniziale', pattern), r2.box);

    /* --- scheda 3: elenco --- */
    const list = h('textarea', { class: 'input', placeholder: 'Un link per riga, nell\'ordine degli episodi' });
    const start = h('input', { class: 'input', type: 'number', min: '0', value: '1' });
    const eBox = h('div', { hidden: true }, field('Link', list), field('Il primo link è l\'episodio numero', start),
      h('button', { class: 'btn sm', onclick: async () => { await mutate('episodes:addM3U', s.id, { start: Number(start.value) }); close(); } }, 'Importa una playlist .m3u / .m3u8'));

    const boxes = { link: lBox, pattern: pBox, list: eBox };
    const tabs = h('div', { class: 'seg', style: { marginBottom: '14px' } },
      ...[['link', 'Da un link'], ['pattern', 'Pattern'], ['list', 'Elenco']].map(([id, label]) => h('button', { 'aria-pressed': String(id === tab), onclick: (e) => { tab = id; for (const [k, b] of Object.entries(boxes)) b.hidden = k !== id; [...e.target.parentNode.children].forEach((b) => b.setAttribute('aria-pressed', String(b === e.target))); } }, label)));
    const ok = h('button', { class: 'btn primary', onclick: async () => {
      try {
        if (tab === 'link') {
          if (!det) { toast('Incolla prima il link di un episodio.', 'error'); return; }
          await mutate('episodes:addPattern', s.id, { pattern: det.candidates[chosen].pattern, from: r1.from.value, to: r1.to.value });
        } else if (tab === 'pattern') await mutate('episodes:addPattern', s.id, { pattern: pattern.value, from: r2.from.value, to: r2.to.value });
        else await mutate('episodes:addList', s.id, { text: list.value, start: Number(start.value) });
        toast('Link aggiunti'); close();
      } catch { /* toast già mostrato */ }
    } }, 'Aggiungi');
    return [tabs, lBox, pBox, eBox, h('div', { class: 'muted small', style: { marginTop: '10px' } }, 'mpv apre direttamente file video e playlist HLS (.m3u8); per i siti supportati da yt-dlp basta il link della pagina.'), h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: close }, 'Annulla'), ok)];
  });
}

function openEditLinks(s, e) {
  openDialog(`Episodio ${e.number} — link`, (close) => {
    const ta = h('textarea', { class: 'input', value: e.sources.map((x) => x.url).join('\n') });
    return [h('div', { class: 'muted small', style: { marginBottom: '8px' } }, 'Un link per riga. Se il primo non funziona, l\'app prova il successivo.'), ta,
      h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: close }, 'Annulla'),
        h('button', { class: 'btn primary', onclick: async () => { try { await mutate('episodes:setSources', s.id, e.id, ta.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)); close(); } catch { /* toast */ } } }, 'Salva'))];
  });
}

function openLinkDialog() {
  openDialog('Apri un link', (close) => {
    const url = h('input', { class: 'input', placeholder: 'https://… oppure percorso di un file' });
    const sel = h('select', { class: 'input' }, h('option', { value: '' }, `Predefinito (${presetLabel(defaultPreset())})`), ...state.presets.map((p) => h('option', { value: p.id }, p.label)));
    const go_ = async () => { try { await call('player:playUrl', url.value, sel.value || null); close(); } catch { /* toast */ } };
    url.addEventListener('keydown', (e) => { if (e.key === 'Enter') go_(); });
    return [field('Link del video', url), field('Anime4K', sel), h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: close }, 'Annulla'), h('button', { class: 'btn primary', onclick: go_ }, 'Guarda'))];
  });
}

function openSettings() {
  const st = state.lib.settings;
  openDialog('Impostazioni', (close) => {
    const mpv = h('input', { class: 'input', value: st.mpvPath || '', placeholder: 'C:\\Programmi\\mpv\\mpv.exe' });
    const preset = h('select', { class: 'input', value: st.defaultPreset }, state.presets.map((p) => h('option', { value: p.id }, p.label)));
    preset.value = st.defaultPreset || 'aa-hq';
    const auto = h('input', { type: 'checkbox' }); auto.checked = !!st.autoplayNext;
    const alang = h('input', { class: 'input', value: st.alang || '' });
    const slang = h('input', { class: 'input', value: st.slang || '' });
    const ua = h('input', { class: 'input', value: st.userAgent || '', placeholder: 'Lascia vuoto per l\'impostazione di mpv' });
    const extra = h('input', { class: 'input', value: st.extraArgs || '', placeholder: 'es. --fullscreen --volume=70' });
    return [
      field('Percorso di mpv', h('div', { class: 'row' }, mpv,
        h('button', { class: 'btn', onclick: async () => { const r = await call('mpv:detect'); if (r.path) { mpv.value = r.path; state.lib = r.lib; render(); toast('mpv trovato'); } else toast('mpv non trovato: scegli il file a mano.', 'error'); } }, 'Cerca'),
        h('button', { class: 'btn', onclick: async () => { const l = await call('mpv:browse'); state.lib = l; mpv.value = l.settings.mpvPath || ''; render(); } }, 'Sfoglia'))),
      field('Anime4K predefinito', preset),
      h('label', { class: 'row', style: { marginBottom: '14px' } }, auto, 'Passa all\'episodio successivo alla fine'),
      h('div', { class: 'two' }, field('Lingue audio (in ordine)', alang), field('Lingue sottotitoli (in ordine)', slang)),
      field('User agent', ua), field('Argomenti extra per mpv', extra),
      h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: close }, 'Annulla'),
        h('button', { class: 'btn primary', onclick: async () => { await mutate('settings:set', { mpvPath: mpv.value.trim(), defaultPreset: preset.value, autoplayNext: auto.checked, alang: alang.value.trim(), slang: slang.value.trim(), userAgent: ua.value.trim(), extraArgs: extra.value.trim() }); toast('Impostazioni salvate'); close(); } }, 'Salva'))];
  });
}

/* ---------- avvio ---------- */
(async function init() {
  api.on('lib:changed', (lib) => { state.lib = lib; render(); });
  api.on('player:state', (p) => { state.player = p; renderPlayer(); });
  api.on('player:error', (m) => toast(m, 'error'));
  state.lib = await api.invoke('lib:get');
  state.presets = await api.invoke('presets:list');
  state.player = await api.invoke('player:state');
  render();
  if (!state.lib.settings.mpvPath) toast('mpv non trovato: apri Impostazioni e indica dove si trova mpv.exe.', 'error');
})();
