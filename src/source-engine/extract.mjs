import { load } from 'cheerio';
import { parse } from 'acorn';
import { LabError, invariant } from './errors.mjs';

// Interpret a narrow AST of data literals. No eval, vm, Function or provider JavaScript.
function literal(node, depth = 0) {
  invariant(node && depth < 30, 'unsafe_script_value');
  if (node.type === 'Literal' && (node.value == null || ['string', 'boolean', 'number'].includes(typeof node.value)))
    return node.value;
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'Literal'
    && typeof node.argument.value === 'number') return -node.argument.value;
  if (node.type === 'ArrayExpression') return node.elements.map(n => literal(n, depth + 1));
  if (node.type === 'ObjectExpression') {
    const out = Object.create(null);
    for (const p of node.properties) {
      invariant(p.type === 'Property' && p.kind === 'init' && !p.method && !p.computed, 'unsafe_script_value');
      const key = p.key.type === 'Identifier' ? p.key.name : p.key.value;
      invariant(typeof key === 'string' && !['__proto__', 'constructor', 'prototype'].includes(key), 'unsafe_script_key');
      out[key] = literal(p.value, depth + 1);
    }
    return out;
  }
  throw new LabError('unsafe_script_value');
}

export function windowData(html) {
  invariant(Buffer.byteLength(html) < 4 * 1024 * 1024, 'response_too_large');
  const $ = load(html), result = Object.create(null);
  const scripts = $('script').toArray().map(e => $(e).html() || '');
  for (const source of scripts) {
    if (!/window\.(?:masterPlaylist|downloadUrl|video|canPlayFHD)\s*=/.test(source)) continue;
    let tree;
    try { tree = parse(source, { ecmaVersion: 'latest' }); }
    catch { throw new LabError('script_schema_changed'); }
    for (const stmt of tree.body) {
      const n = stmt.type === 'ExpressionStatement' ? stmt.expression : null;
      if (n?.type !== 'AssignmentExpression' || n.operator !== '=') continue;
      if (n.left.type !== 'MemberExpression' || n.left.computed || n.left.object.name !== 'window') continue;
      const name = n.left.property.name;
      if (!['masterPlaylist', 'downloadUrl', 'video', 'canPlayFHD'].includes(name)) continue;
      const value = literal(n.right);
      invariant(result[name] === undefined || JSON.stringify(result[name]) === JSON.stringify(value), 'conflicting_script_data');
      result[name] = value;
    }
  }
  return result;
}

export function vixSources(html, embedUrl, now = Date.now()) {
  const data = windowData(html), sources = [];
  if (data.masterPlaylist) {
    const m = data.masterPlaylist;
    invariant(m.url && m.params && typeof m.params === 'object', 'playlist_schema_changed');
    const url = new URL(String(m.url).replace('?b:1', '?b=1'), embedUrl);
    for (const [key, value] of Object.entries(m.params)) {
      invariant(['string', 'number', 'boolean'].includes(typeof value), 'playlist_schema_changed');
      url.searchParams.set(key, String(value));
    }
    if (data.canPlayFHD === true) url.searchParams.set('h', '1');
    const expiry = /^\d+$/.test(String(m.params.expires)) ? Number(m.params.expires) * 1000 : null;
    invariant(!expiry || expiry > now + 30000, 'signed_url_expired');
    sources.push({ type: 'hls', url: url.href, headers: { Referer: embedUrl }, expiresAt: expiry });
  }
  if (typeof data.downloadUrl === 'string' && data.downloadUrl) {
    sources.push({ type: 'file', url: new URL(data.downloadUrl, embedUrl).href,
      headers: { Referer: embedUrl }, expiresAt: null });
  }
  invariant(sources.length, 'media_unresolved');
  return sources;
}

export function inertiaProps(html) {
  const $ = load(html), raw = $('#app').attr('data-page');
  invariant(raw, 'page_schema_changed');
  try { return JSON.parse(raw).props || {}; }
  catch { throw new LabError('invalid_json'); }
}

export function csrfMeta(html, attribute = 'name') {
  const $ = load(html);
  return $('meta[' + attribute + '="csrf-token"]').attr('content') || null;
}
