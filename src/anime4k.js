// Preset Anime4K v4.0.1 (catene ufficiali da GLSL_Instructions.md di bloc97/Anime4K)
const path = require('path');

const TIERS = {
  fast: { label: 'Fast', R1: 'M', U1: 'M', D1: 'M', R2: 'S', U2: 'S' },
  hq:   { label: 'HQ',   R1: 'VL', U1: 'VL', D1: 'VL', R2: 'M', U2: 'M' },
};

const MODES = ['A', 'B', 'C', 'A+A', 'B+B', 'C+A'];

function chainFor(mode, t) {
  const clamp = 'Anime4K_Clamp_Highlights';
  const adp = ['Anime4K_AutoDownscalePre_x2', 'Anime4K_AutoDownscalePre_x4'];
  const restore = (s) => `Anime4K_Restore_CNN_${s}`;
  const soft = (s) => `Anime4K_Restore_CNN_Soft_${s}`;
  const up = (s) => `Anime4K_Upscale_CNN_x2_${s}`;
  const den = (s) => `Anime4K_Upscale_Denoise_CNN_x2_${s}`;
  switch (mode) {
    case 'A':   return [clamp, restore(t.R1), up(t.U1), ...adp, up(t.U2)];
    case 'B':   return [clamp, soft(t.R1), up(t.U1), ...adp, up(t.U2)];
    case 'C':   return [clamp, den(t.D1), ...adp, up(t.U2)];
    case 'A+A': return [clamp, restore(t.R1), up(t.U1), ...adp, restore(t.R2), up(t.U2)];
    case 'B+B': return [clamp, soft(t.R1), up(t.U1), ...adp, soft(t.R2), up(t.U2)];
    case 'C+A': return [clamp, den(t.D1), ...adp, restore(t.R2), up(t.U2)];
  }
  throw new Error('Modo sconosciuto: ' + mode);
}

const PRESETS = { off: { id: 'off', label: 'Spento', chain: [] } };
for (const [tierId, t] of Object.entries(TIERS)) {
  for (const mode of MODES) {
    const id = `${mode.toLowerCase().replace('+', '')}-${tierId}`;
    PRESETS[id] = { id, mode, tier: tierId, label: `Mode ${mode} (${t.label})`, chain: chainFor(mode, t) };
  }
}

const DEFAULT_PRESET = 'aa-hq';

function listPresets() {
  return Object.values(PRESETS).map(({ id, label, tier, mode }) => ({ id, label, tier, mode }));
}

function resolvePreset(id) {
  return PRESETS[id] || PRESETS[DEFAULT_PRESET];
}

function toPosix(p) { return p.replace(/\\/g, '/'); }

// Lista shader per mpv: separatore ';' su Windows, ':' altrove (manuale mpv)
function shaderList(presetId, shaderDir) {
  const p = resolvePreset(presetId);
  const sep = process.platform === 'win32' ? ';' : ':';
  return p.chain.map((n) => toPosix(path.join(shaderDir, n + '.glsl'))).join(sep);
}

// input.conf: CTRL+1..6 = preset Fast, ALT+1..6 = preset HQ, CTRL+0 = spento.
// PGDOWN/PGUP o > < = episodio successivo/precedente (gestito dall'app).
function buildInputConf(shaderDir, shortcuts = {}) {
  const lines = [];
  MODES.forEach((mode, i) => {
    for (const [key, tierId] of [['CTRL', 'fast'], ['ALT', 'hq']]) {
      const id = `${mode.toLowerCase().replace('+', '')}-${tierId}`;
      const p = PRESETS[id];
      lines.push(`${key}+${i + 1} no-osd change-list glsl-shaders set "${shaderList(id, shaderDir)}"; show-text "Anime4K: ${p.label}" 2000`);
    }
  });
  lines.push('CTRL+0 no-osd change-list glsl-shaders clr ""; show-text "Anime4K spento" 2000');
  lines.push(`${shortcuts.next || 'PGDWN'} script-message ap-next`, `${shortcuts.previous || 'PGUP'} script-message ap-prev`);
  if (shortcuts.skipIntro) lines.push(`${shortcuts.skipIntro} script-message ap-skip-intro`);
  if (shortcuts.skipEnding) lines.push(`${shortcuts.skipEnding} script-message ap-skip-ending`);
  return lines.join('\n') + '\n';
}

// Divide una stringa di argomenti rispettando le virgolette
function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(str || ''))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

function buildArgs({ settings, presetId, startPos, title, referer, url, inputConf, pipe, shaderDir }) {
  const args = [
    `--input-ipc-server=${pipe}`,
    `--input-conf=${toPosix(inputConf)}`,
    `--force-media-title=${title}`,
    '--keep-open=no',
    '--save-position-on-quit=no',
    '--hwdec=auto-safe',
    `--alang=${settings.alang || 'jpn,ja,eng,en'}`,
    `--slang=${settings.slang || 'ita,it,eng,en'}`,
  ];
  const preset = resolvePreset(presetId);
  if (preset.chain.length) {
    args.push(`--glsl-shaders=${shaderList(preset.id, shaderDir)}`, '--scale=ewa_lanczossharp', '--cscale=ewa_lanczossharp');
  }
  if (startPos > 0) args.push(`--start=${Math.floor(startPos)}`);
  if (referer) args.push(`--referrer=${referer}`);
  if (settings.userAgent) args.push(`--user-agent=${settings.userAgent}`);
  args.push(...splitArgs(settings.extraArgs));
  args.push('--', url);
  return args;
}

module.exports = { PRESETS, DEFAULT_PRESET, listPresets, resolvePreset, shaderList, buildInputConf, buildArgs, splitArgs };
