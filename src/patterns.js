// Espansione di pattern e liste di link in episodi.
function pad(n, width) { return String(n).padStart(width, '0'); }

// "https://x/ep{ep}.mp4" oppure "{ep:02}" per lo zero-padding
function expandPattern(pattern, from, to) {
  if (!/\{ep(:\d+)?\}/.test(pattern)) throw new Error('Il pattern deve contenere {ep} (es. https://sito/ep{ep}.mp4 oppure {ep:02}).');
  from = Number(from); to = Number(to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) throw new Error('Intervallo di episodi non valido.');
  if (to - from > 999) throw new Error('Massimo 1000 episodi per volta.');
  const out = [];
  for (let n = from; n <= to; n++) {
    out.push({ number: n, url: pattern.replace(/\{ep(?::(\d+))?\}/g, (_, w) => (w ? pad(n, Number(w)) : String(n))) });
  }
  return out;
}

// Una riga per link. Righe vuote e commenti (#) ignorati.
function expandList(text, start = 1) {
  const urls = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  return urls.map((url, i) => ({ number: Number(start) + i, url }));
}

// Playlist .m3u/.m3u8 locale: ogni voce è un episodio (usa #EXTINF per il titolo)
function parseM3U(text, start = 1) {
  const out = [];
  let title = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) { title = line.includes(',') ? line.slice(line.indexOf(',') + 1).trim() : null; continue; }
    if (line.startsWith('#')) continue;
    out.push({ number: Number(start) + out.length, url: line, title });
    title = null;
  }
  return out;
}

function isValidSource(url) {
  return /^(https?|rtmps?|ftp|file):\/\//i.test(url) || /^[a-zA-Z]:[\\/]/.test(url) || url.startsWith('/') || url.startsWith('\\\\');
}

function hostLabel(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'file locale'; }
}


// Cerca nel link il numero che indica l'episodio. Ignora il nome del server (srv18, cdn2…).
// `hint` = numero dell'episodio che l'utente dice di aver incollato: lo usa per scegliere tra più numeri.
// Ritorna { number, candidates: [{ text, number, index, score, width, pattern }] } (il migliore è il primo) oppure null.
function detectEpisodeNumber(url, hint) {
  url = String(url || '').trim();
  if (!url) return null;
  const hostMatch = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(url);
  const start = hostMatch ? hostMatch[0].length : 0;
  let pathEnd = url.search(/[?#]/); if (pathEnd < 0 || pathEnd < start) pathEnd = url.length;
  const fileStart = Math.max(url.lastIndexOf('/', pathEnd - 1), url.lastIndexOf('\\', pathEnd - 1)) + 1;
  // l'estensione (.mp4, .mkv, .m3u8) non contiene numeri di episodio
  const ext = /\.[a-z0-9]{2,5}$/i.exec(url.slice(fileStart, pathEnd));
  const extStart = ext ? pathEnd - ext[0].length : pathEnd;
  const hintNum = hint === undefined || hint === null || hint === '' || Number.isNaN(Number(hint)) ? null : Number(hint);

  const found = [];
  const re = /\d+/g; re.lastIndex = start;
  let m;
  while ((m = re.exec(url))) {
    const text = m[0]; const idx = m.index;
    if (idx >= extStart && idx < pathEnd) continue;
    const before = url.slice(Math.max(start, idx - 14), idx);
    const after = url.slice(idx + text.length, idx + text.length + 4);
    let score = 0;
    if (idx >= pathEnd) score -= 4;                       // parametri della query (?id=123)
    else if (idx >= fileStart) score += 5;                // nel nome del file
    if (/(?:^|[^a-z])(?:ep|eps|episode|episodio|epis|puntata|ova|e)[\s._-]*$/i.test(before)) score += 6; // Ep_01, E05, episodio-3
    if (/(?:^|[^a-z])(?:s|season|stagione)[\s._-]*$/i.test(before)) score -= 4;                         // S02
    if ((text.length >= 3 && /^p/i.test(after)) || /[xh]$/i.test(before) || /^bit/i.test(after)) score -= 10; // 1080p, x264, h264, 10bit
    if (/[^a-z]v$/i.test(before) || /^v$/i.test(before)) score -= 3;                                    // v2
    if (text.length === 4 && /^(19|20)\d\d$/.test(text)) score -= 4;                                    // anno
    if (text.length >= 5) score -= 3;                                                                    // id lunghi, hash
    if (hintNum !== null && Number(text) === hintNum) score += 20; // quello che dice l'utente pesa più di ogni indizio
    score += idx * 0.0001;                                                                                // a parità, il più a destra
    const width = text.length > 1 && text[0] === '0' ? text.length : 0;
    const pattern = url.slice(0, idx) + (width ? `{ep:${width}}` : '{ep}') + url.slice(idx + text.length);
    found.push({ text, number: Number(text), index: idx, score, width, pattern });
  }
  if (!found.length) return null;
  found.sort((a, b) => b.score - a.score);
  return { number: found[0].number, candidates: found };
}

module.exports = { detectEpisodeNumber, expandPattern, expandList, parseM3U, isValidSource, hostLabel };
