/* Satella — logique de l'interface */
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const U = 46; // taille d'une touche 1u en pixels

let LAYOUT = null;
let SETTINGS = { ledsEnabled: true, macrosEnabled: true, autoOptimize: false, autoOptimizeThreshold: 80 };
let STATE = null;       // état LED { keyboard, mouse }
let MACROS = [];
let KEY_NAMES = [];
let KEY_LABELS = {};
let CAPS = {};
let SHORTCUT_ERRORS = [];
let ACTIVE_PROFILE = null;
let DIMMED = false;
let LOCKS_AVAILABLE = true;   // témoins Verr. Maj / Verr. Num (Windows)

const kbSelection = new Set();
let mouseSelection = null;
let currentMacroId = null;
let recording = false;
let recordedSteps = [];
const recordOpts = { mouse: true, clickPositions: false, moves: false };
let lastFrame = null;

// Version sauvegardée de chaque macro (détection des modifications en cours)
const SAVED = new Map();

const EFFECTS = [
  ['static', 'Statique'],
  ['breathing', 'Respiration'],
  ['wave', 'Vague'],
  ['rainbow', 'Arc-en-ciel'],
  ['reactive', 'Réactif'],
  ['ripple', 'Onde de choc'],
  ['sparkle', 'Étincelles'],
  ['fire', 'Feu'],
  ['rain', 'Pluie'],
  ['scanner', 'Balayage'],
  ['spiral', 'Tourbillon'],
  ['disco', 'Disco'],
  ['gradient', 'Dégradé'],
  ['sysmon', 'Jauge système'],
  ['audio', 'Visualiseur audio'],
  ['screen', 'Ambiance écran'],
  ['heatmap', 'Carte de chaleur'],
  ['off', 'Éteint'],
];
const MOUSE_EFFECTS = [
  ['static', 'Statique'],
  ['breathing', 'Respiration'],
  ['wave', 'Vague'],
  ['rainbow', 'Arc-en-ciel'],
  ['sparkle', 'Étincelles'],
  ['off', 'Éteint'],
];
const EFFECT_HINTS = {
  sysmon: 'F1 à F12 : charge du processeur. Rangée des chiffres : mémoire vive. Les autres touches gardent la couleur choisie, atténuée.',
  audio: 'Le son joué par Windows anime le clavier : une colonne par bande de fréquence. La couleur 2 colore le haut des colonnes.',
  screen: 'Le clavier reprend les couleurs de l\'écran principal, zone par zone (films, jeux). La vitesse règle la réactivité.',
  heatmap: 'Chaque touche prend la couleur de son usage : bleu = rarement, rouge = très souvent. Seul le nombre d\'appuis par touche est compté, sur ce PC.',
};
const COLOR2_EFFECTS = ['gradient', 'audio'];

const SWATCH_COLORS = [
  '#ff0033', '#ff7a00', '#ffd500', '#2ee88a', '#00a8ff',
  '#7047ff', '#ff00d4', '#ffffff', '#00ffd0', '#ff4d5e',
];

function toast(msg, ms = 2500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, ms);
}

// Échappement HTML de tout texte saisi ou importé avant insertion dans
// innerHTML (noms, textes de macros, abréviations, noms USB...)
function esc(v) {
  return String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const clone = (v) => JSON.parse(JSON.stringify(v));
function rgbCss(rgb) { return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`; }
function uid() { return 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function fmtDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('fr-FR');
}

// Forme normalisée d'un raccourci (« Shift+Ctrl+A » = « Ctrl+Shift+A »)
function normAccel(a) {
  const parts = String(a || '').split('+').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const key = parts.pop();
  return [...new Set(parts)].sort().concat(key).join('+');
}

/* Icônes SVG au trait (aucun emoji dans l'interface) */
const ICON_PATHS = {
  play: '<path d="M8 5v14l11-7z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  record: '<circle cx="12" cy="12" r="7"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  down: '<path d="M12 5v14M5 12l7 7 7-7"/>',
  edit: '<path d="M17 3l4 4L8 20l-5 1 1-5z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  key: '<rect x="4" y="6" width="16" height="12" rx="2"/>',
  keyDown: '<rect x="4" y="4" width="16" height="12" rx="2"/><path d="M12 19v2"/>',
  keyUp: '<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 5V3"/>',
  text: '<path d="M5 6h14M12 6v13"/>',
  delay: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  mouse: '<path d="M12 3a6 6 0 0 1 6 6v6a6 6 0 0 1-12 0V9a6 6 0 0 1 6-6z"/><path d="M12 7v3"/>',
  move: '<path d="M12 3v18M3 12h18M12 3l-2 2M12 3l2 2M12 21l-2-2M12 21l2-2"/>',
  wheel: '<circle cx="12" cy="12" r="8"/><path d="M12 8v8"/>',
  loop: '<path d="M20 8a8 8 0 1 0 2 6"/><path d="M22 3v5h-5"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
  grip: '<path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01"/>',
  warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
};
function svg(name, cls = 'icon sm') {
  return `<svg class="${cls}" viewBox="0 0 24 24">${ICON_PATHS[name] || ''}</svg>`;
}

/* L'accent de l'interface suit la couleur d'éclairage du périphérique actif */
let accentDevice = 'keyboard';
function setAccent() {
  if (!STATE) return;
  const hex = STATE[accentDevice].baseColor || '#00a8ff';
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const root = document.documentElement.style;
  root.setProperty('--accent', hex);
  root.setProperty('--accent-text', lum > 150 ? '#0a0b0e' : '#ffffff');
}

/* Petite fenêtre de saisie (Electron ne gère pas window.prompt) */
function askText({ title, label, value = '', ok = 'Valider' }) {
  return new Promise((resolve) => {
    const modal = $('#modal');
    const backdrop = $('#modal-backdrop');
    modal.innerHTML = `
      <h3>${esc(title)}</h3>
      <label class="muted" style="font-size:13px">${esc(label)}</label>
      <input type="text" id="ask-input" maxlength="60" style="width:100%;margin:8px 0 14px">
      <div class="btn-row">
        <button class="btn primary" id="ask-ok">${esc(ok)}</button>
        <button class="btn" id="ask-cancel">Annuler</button>
      </div>`;
    const inputEl = $('#ask-input');
    inputEl.value = value;
    backdrop.hidden = false;
    inputEl.focus();
    inputEl.select();
    const done = (result) => {
      backdrop.hidden = true;
      backdrop.removeEventListener('modal-dismiss', onDismiss);
      resolve(result);
    };
    const onDismiss = () => resolve(null);
    backdrop.addEventListener('modal-dismiss', onDismiss, { once: true });
    $('#ask-ok').addEventListener('click', () => done(inputEl.value.trim()));
    $('#ask-cancel').addEventListener('click', () => done(null));
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(inputEl.value.trim());
      if (e.key === 'Escape') done(null);
    });
  });
}

/* ================= Navigation ================= */
let currentPage = 'home';
function showPage(name) {
  currentPage = name;
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + name));
  accentDevice = name === 'mouse' ? 'mouse' : 'keyboard';
  setAccent();
  window.satella.setPage(name); // l'aperçu n'est calculé que s'il est affiché
  // La mémoire n'est interrogée que sur les pages qui l'affichent
  clearInterval(memTimer);
  memTimer = null;
  if (name === 'optimizer') {
    refreshMemory();
    memTimer = setInterval(refreshMemory, 2000);
  } else if (name === 'settings') {
    refreshFootprint();
    refreshStatsInfo();
    refreshBackups();
    syncStartupState();
  } else if (name === 'profiles' && pendingProfiles) {
    renderProfiles(pendingProfiles);
  }
}
$$('.nav-btn').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.page)));
$('#card-keyboard').addEventListener('click', () => showPage('keyboard'));
$('#card-mouse').addEventListener('click', () => showPage('mouse'));

/* ================= Mises à jour automatiques ================= */
// Notes de version (Markdown simple : titres ##, listes -, `code`) en HTML échappé
function renderNotes(md) {
  const inline = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = [];
  let inList = false;
  for (const raw of String(md || '').split(/\r?\n/)) {
    const line = raw.trim();
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (item) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(item[1])}</li>`);
      continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }
    const title = /^#{1,6}\s+(.*)$/.exec(line);
    if (title) out.push(`<h4>${esc(title[1])}</h4>`);
    else if (line) out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

function showNotesModal(title, notes, actions = []) {
  const modal = $('#modal');
  modal.innerHTML = `
    <h3>${esc(title)}</h3>
    <div class="release-notes">${renderNotes(notes) || '<p class="muted">Pas de notes pour cette version.</p>'}</div>
    <div class="btn-row" style="margin-top:14px" id="notes-actions"></div>`;
  const row = $('#notes-actions');
  for (const a of [...actions, { label: 'Fermer', run: () => {} }]) {
    const b = document.createElement('button');
    b.className = 'btn' + (a.primary ? ' primary' : '');
    b.textContent = a.label;
    b.addEventListener('click', () => { $('#modal-backdrop').hidden = true; a.run(); });
    row.appendChild(b);
  }
  $('#modal-backdrop').hidden = false;
}

async function startUpdateDownload() {
  const out = $('#update-result');
  out.textContent = 'Téléchargement...';
  const dl = await window.satella.downloadUpdate();
  if (!dl.ok) out.textContent = 'Téléchargement impossible : ' + dl.error;
}

// Version disponible : téléchargement au clic, nouveautés consultables avant
function offerUpdate(latest, notes) {
  const out = $('#update-result');
  out.innerHTML = '';
  out.append(`Nouvelle version ${latest} disponible. `);
  const dl = document.createElement('button');
  dl.className = 'btn small primary';
  dl.textContent = 'Télécharger et installer';
  dl.addEventListener('click', startUpdateDownload);
  out.appendChild(dl);
  if (notes) {
    const nb = document.createElement('button');
    nb.className = 'btn small';
    nb.textContent = 'Nouveautés';
    nb.style.marginLeft = '6px';
    nb.addEventListener('click', () => showNotesModal(`Nouveautés de la version ${latest}`, notes,
      [{ label: 'Télécharger et installer', primary: true, run: startUpdateDownload }]));
    out.appendChild(nb);
  }
}

$('#update-check').addEventListener('click', async () => {
  const out = $('#update-result');
  out.textContent = 'Vérification en cours...';
  const res = await window.satella.checkUpdate();
  if (!res.ok) {
    out.textContent = 'Vérification impossible : ' + res.error;
    return;
  }
  if (res.newer) offerUpdate(res.latest, res.notes);
  else out.textContent = `Tu as la dernière version (${res.current}).`;
});
window.satella.onUpdateAvailable(({ latest, notes }) => {
  toast(`Nouvelle version ${latest} disponible (page Accueil).`, 5000);
  offerUpdate(latest, notes);
});
window.satella.onUpdateProgress(({ percent }) => {
  $('#update-result').textContent = `Téléchargement : ${percent}%`;
});
window.satella.onUpdateReady(({ version, auto }) => {
  const out = $('#update-result');
  out.innerHTML = '';
  out.append(`Version ${version} prête${auto ? ' : installée automatiquement à la fermeture de Satella' : ''}. `);
  const b = document.createElement('button');
  b.className = 'btn small primary';
  b.textContent = 'Redémarrer et installer';
  b.addEventListener('click', () => window.satella.installUpdate());
  out.appendChild(b);
  if (auto) toast(`Version ${version} téléchargée : installée à la fermeture, ou tout de suite depuis l'Accueil.`, 6000);
});
window.satella.onUpdateError(({ message }) => {
  $('#update-result').textContent = 'Erreur de mise à jour : ' + message;
});

/* ================= Clavier ================= */
let keyEls = [];
function buildKeyboard() {
  const board = $('#kb-board');
  board.style.width = LAYOUT.bounds.w * U + 'px';
  board.style.height = LAYOUT.bounds.h * U + 'px';
  board.innerHTML = '';
  for (const key of LAYOUT.keyboard) {
    const el = document.createElement('div');
    el.className = 'kb-key';
    el.dataset.id = key.id;
    el.style.left = key.x * U + 2 + 'px';
    el.style.top = key.y * U + 2 + 'px';
    el.style.width = key.w * U - 4 + 'px';
    el.style.height = key.h * U - 4 + 'px';
    el.innerHTML = `<div class="led"></div><span class="lbl">${esc(key.label)}</span>`;
    el.addEventListener('click', (e) => onKeyClick(key.id, e));
    board.appendChild(el);
  }
  keyEls = $$('.kb-key');
}

function onKeyClick(id, e) {
  if ($('#kb-paint').checked) {
    applyKeyColors({ [id]: $('#kb-color').value });
    return;
  }
  if (e.ctrlKey) {
    kbSelection.has(id) ? kbSelection.delete(id) : kbSelection.add(id);
  } else {
    kbSelection.clear();
    kbSelection.add(id);
  }
  refreshSelection();
}

function refreshSelection() {
  keyEls.forEach((el) => {
    el.classList.toggle('selected', kbSelection.has(el.dataset.id));
    setKeyVisual(el, lastFrame && lastFrame.keyboard[el.dataset.id]);
  });
  $('#kb-sel-count').textContent = kbSelection.size;
}

// Touches du calque (fixes par-dessus l'effet) : repère visuel
function refreshOverlayMarks() {
  const overlay = (STATE && STATE.keyboard.overlay) || {};
  keyEls.forEach((el) => el.classList.toggle('in-overlay', !!overlay[el.dataset.id]));
  $('#kb-overlay-count').textContent = Object.keys(overlay).length;
}

/* Sélection rectangle (marquee) */
(function marquee() {
  const wrap = $('#kb-wrap');
  const box = $('#kb-marquee');
  let start = null;
  let moved = false;

  wrap.addEventListener('mousedown', (e) => {
    if (e.target.closest('.kb-key') || e.button !== 0) return;
    const r = wrap.getBoundingClientRect();
    start = { x: e.clientX - r.left + wrap.scrollLeft, y: e.clientY - r.top + wrap.scrollTop, ctrl: e.ctrlKey };
    moved = false;
  });
  window.addEventListener('mousemove', (e) => {
    if (!start) return;
    moved = true;
    const r = wrap.getBoundingClientRect();
    const cur = { x: e.clientX - r.left + wrap.scrollLeft, y: e.clientY - r.top + wrap.scrollTop };
    const x = Math.min(start.x, cur.x), y = Math.min(start.y, cur.y);
    const w = Math.abs(cur.x - start.x), h = Math.abs(cur.y - start.y);
    Object.assign(box.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
    box.hidden = false;

    if (!start.ctrl) kbSelection.clear();
    const boardR = $('#kb-board').getBoundingClientRect();
    const offX = boardR.left - r.left + wrap.scrollLeft;
    const offY = boardR.top - r.top + wrap.scrollTop;
    for (const key of LAYOUT.keyboard) {
      const kx = offX + key.x * U, ky = offY + key.y * U;
      const inter = kx < x + w && kx + key.w * U > x && ky < y + h && ky + key.h * U > y;
      if (inter) kbSelection.add(key.id);
    }
    refreshSelection();
  });
  window.addEventListener('mouseup', (e) => {
    if (start && !moved && !e.target.closest('.kb-key')) {
      kbSelection.clear();
      refreshSelection();
    }
    start = null;
    box.hidden = true;
  });
})();

/* ---- Coloration : annuler / rétablir, couleurs récentes, préréglages ---- */
const kbHistory = { past: [], future: [] };

function kbSnapshot() {
  const k = STATE.keyboard;
  return clone({ effect: k.effect, colors: k.colors || {}, overlay: k.overlay || {} });
}

function resetKbHistory() {
  kbHistory.past = [];
  kbHistory.future = [];
  updateKbHistoryButtons();
}

function updateKbHistoryButtons() {
  $('#kb-undo').disabled = !kbHistory.past.length;
  $('#kb-redo').disabled = !kbHistory.future.length;
}

// Mémorise l'état avant une modification de coloration
function kbPush() {
  kbHistory.past.push(kbSnapshot());
  if (kbHistory.past.length > 50) kbHistory.past.shift();
  kbHistory.future = [];
  updateKbHistoryButtons();
}

function kbRestore(redo) {
  const from = redo ? kbHistory.future : kbHistory.past;
  const to = redo ? kbHistory.past : kbHistory.future;
  if (!from.length) return;
  to.push(kbSnapshot());
  const snap = from.pop();
  Object.assign(STATE.keyboard, snap);
  window.satella.led.set('keyboard', snap);
  syncToolbars();
  updateKbHistoryButtons();
}

// Couleurs par touche (mode statique), avec historique et couleurs récentes
function applyKeyColors(map, { remember = true } = {}) {
  kbPush();
  window.satella.led.setKeys('keyboard', map);
  STATE.keyboard.colors = { ...(STATE.keyboard.colors || {}), ...map };
  STATE.keyboard.effect = 'static';
  if (remember) rememberColor(Object.values(map)[0]);
  syncToolbars();
}

const RECENT_KEY = 'satella.recentColors';
let recentColors = [];
try { recentColors = JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { recentColors = []; }

function rememberColor(c) {
  if (!/^#[0-9a-f]{6}$/i.test(c || '')) return;
  const color = c.toLowerCase();
  recentColors = [color, ...recentColors.filter((x) => x !== color)].slice(0, 8);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(recentColors)); } catch { /* stockage indisponible */ }
  renderRecentColors();
}

function renderRecentColors() {
  const cont = $('#kb-recent');
  cont.innerHTML = '';
  $('#kb-recent-label').hidden = !recentColors.length;
  for (const c of recentColors) {
    if (!/^#[0-9a-f]{6}$/i.test(c)) continue;
    const sw = document.createElement('div');
    sw.className = 'swatch';
    sw.style.background = c;
    sw.title = c;
    sw.addEventListener('click', () => {
      $('#kb-color').value = c;
      onBaseColor('keyboard', c);
    });
    cont.appendChild(sw);
  }
}

const hexRgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgbHex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
function hueHex(h) {
  const f = (n) => { const k = (n + h / 60) % 6; return 255 * (1 - Math.max(0, Math.min(k, 4 - k, 1))); };
  return rgbHex(f(5), f(3), f(1));
}

// Préréglages : une couleur pour chaque touche du clavier
function presetColors(kind) {
  const c1 = $('#kb-color').value;
  const c2 = STATE.keyboard.color2 || '#ff00d4';
  const [a, b] = [hexRgb(c1), hexRgb(c2)];
  const moves = new Set(['w', 'a', 's', 'd', 'up', 'down', 'left', 'right']);
  const map = {};
  for (const k of LAYOUT.keyboard) {
    switch (kind) {
      case 'moves': map[k.id] = moves.has(k.id) ? c1 : c2; break;
      case 'rows': map[k.id] = hueHex((k.y / 6) * 300); break;
      case 'gradient': {
        const f = (k.x + k.w / 2) / LAYOUT.bounds.w;
        map[k.id] = rgbHex(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
        break;
      }
      case 'numpad': map[k.id] = /^(np|numlock)/.test(k.id) ? c2 : c1; break;
      default: break;
    }
  }
  return map;
}

function buildToolbars() {
  // Effets clavier
  const kbFx = $('#kb-effects');
  for (const [id, label] of EFFECTS) {
    const b = document.createElement('button');
    b.textContent = label;
    b.dataset.fx = id;
    b.addEventListener('click', () => {
      window.satella.led.set('keyboard', { effect: id });
      STATE.keyboard.effect = id;
      syncToolbars();
    });
    kbFx.appendChild(b);
  }
  // Effets souris
  const msFx = $('#mouse-effects');
  for (const [id, label] of MOUSE_EFFECTS) {
    const b = document.createElement('button');
    b.textContent = label;
    b.dataset.fx = id;
    b.addEventListener('click', () => {
      window.satella.led.set('mouse', { effect: id });
      STATE.mouse.effect = id;
      syncToolbars();
    });
    msFx.appendChild(b);
  }
  // Nuanciers
  for (const target of ['kb', 'mouse']) {
    const cont = $('#' + target + '-swatches');
    for (const c of SWATCH_COLORS) {
      const s = document.createElement('div');
      s.className = 'swatch';
      s.style.background = c;
      s.addEventListener('click', () => {
        $('#' + target + '-color').value = c;
        onBaseColor(target === 'kb' ? 'keyboard' : 'mouse', c);
      });
      cont.appendChild(s);
    }
  }

  $('#kb-color').addEventListener('input', (e) => onBaseColor('keyboard', e.target.value));
  $('#kb-color2').addEventListener('input', (e) => {
    STATE.keyboard.color2 = e.target.value;
    window.satella.led.set('keyboard', { color2: e.target.value });
  });
  $('#mouse-color').addEventListener('input', (e) => onBaseColor('mouse', e.target.value));

  bindSlider('#kb-bright', '#kb-bright-val', 'keyboard', 'brightness');
  bindSlider('#kb-speed', '#kb-speed-val', 'keyboard', 'speed');
  bindSlider('#mouse-bright', '#mouse-bright-val', 'mouse', 'brightness');
  bindSlider('#mouse-speed', '#mouse-speed-val', 'mouse', 'speed');

  $('#kb-dir').addEventListener('change', (e) => {
    STATE.keyboard.direction = e.target.value;
    window.satella.led.set('keyboard', { direction: e.target.value });
  });

  $('#kb-apply').addEventListener('click', () => {
    if (!kbSelection.size) return toast('Sélectionne d’abord des touches.');
    const color = $('#kb-color').value;
    const map = {};
    for (const id of kbSelection) map[id] = color;
    applyKeyColors(map);
  });
  $('#kb-select-all').addEventListener('click', () => {
    LAYOUT.keyboard.forEach((k) => kbSelection.add(k.id));
    refreshSelection();
  });
  $('#kb-clear-sel').addEventListener('click', () => { kbSelection.clear(); refreshSelection(); });
  $('#kb-reset').addEventListener('click', () => {
    kbPush();
    window.satella.led.clearKeys('keyboard');
    STATE.keyboard.colors = {};
  });
  $('#kb-undo').addEventListener('click', () => kbRestore(false));
  $('#kb-redo').addEventListener('click', () => kbRestore(true));
  $('#kb-preset').addEventListener('change', (e) => {
    const kind = e.target.value;
    e.target.value = '';
    if (kind) applyKeyColors(presetColors(kind), { remember: false });
  });

  // Calque : les touches sélectionnées gardent leur couleur par-dessus l'effet
  $('#kb-overlay-add').addEventListener('click', () => {
    if (!kbSelection.size) return toast('Sélectionne d’abord des touches.');
    const color = $('#kb-color').value;
    const map = {};
    for (const id of kbSelection) map[id] = color;
    kbPush();
    rememberColor(color);
    window.satella.led.setOverlay('keyboard', map);
    STATE.keyboard.overlay = { ...(STATE.keyboard.overlay || {}), ...map };
    refreshOverlayMarks();
    toast(`${kbSelection.size} touche(s) fixée(s) par-dessus l'effet.`);
  });
  $('#kb-overlay-remove').addEventListener('click', () => {
    const overlay = { ...(STATE.keyboard.overlay || {}) };
    const ids = kbSelection.size ? [...kbSelection] : Object.keys(overlay);
    if (!ids.length) return;
    kbPush();
    window.satella.led.removeOverlay('keyboard', ids);
    for (const id of ids) delete overlay[id];
    STATE.keyboard.overlay = overlay;
    refreshOverlayMarks();
  });

  $('#mouse-apply').addEventListener('click', () => {
    if (!mouseSelection) return toast('Sélectionne d’abord une zone.');
    const color = $('#mouse-color').value;
    window.satella.led.setKeys('mouse', { [mouseSelection]: color });
    STATE.mouse.effect = 'static';
    syncToolbars();
  });
  $('#mouse-reset').addEventListener('click', () => window.satella.led.clearKeys('mouse'));
}

function onBaseColor(device, color) {
  window.satella.led.set(device, { baseColor: color });
  STATE[device].baseColor = color;
  if (device === accentDevice) setAccent();
}

function bindSlider(sel, valSel, device, prop) {
  const input = $(sel);
  input.addEventListener('input', () => {
    $(valSel).textContent = input.value + '%';
    STATE[device][prop] = +input.value;
    window.satella.led.set(device, { [prop]: +input.value });
  });
}

function syncToolbars() {
  const fx = STATE.keyboard.effect;
  $$('#kb-effects button').forEach((b) => b.classList.toggle('active', b.dataset.fx === fx));
  $$('#mouse-effects button').forEach((b) => b.classList.toggle('active', b.dataset.fx === STATE.mouse.effect));
  $('#kb-dir-group').style.display = fx === 'wave' ? '' : 'none';
  const showC2 = COLOR2_EFFECTS.includes(fx) ? '' : 'none';
  $('#kb-color2-label').style.display = showC2;
  $('#kb-color2').style.display = showC2;
  $('#kb-color2').value = STATE.keyboard.color2 || '#ff00d4';
  $('#kb-color').value = STATE.keyboard.baseColor;
  $('#mouse-color').value = STATE.mouse.baseColor;
  $('#kb-bright').value = STATE.keyboard.brightness;
  $('#kb-bright-val').textContent = STATE.keyboard.brightness + '%';
  $('#kb-speed').value = STATE.keyboard.speed;
  $('#kb-speed-val').textContent = STATE.keyboard.speed + '%';
  $('#mouse-bright').value = STATE.mouse.brightness;
  $('#mouse-bright-val').textContent = STATE.mouse.brightness + '%';
  $('#mouse-speed').value = STATE.mouse.speed;
  $('#mouse-speed-val').textContent = STATE.mouse.speed + '%';
  $('#kb-dir').value = STATE.keyboard.direction;
  const hint = EFFECT_HINTS[fx];
  const hintEl = $('#kb-fx-hint');
  hintEl.textContent = hint || '';
  hintEl.hidden = !hint;
  if (fx === 'heatmap' && !SETTINGS.keyStats) {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.style.cssText = 'display:block;margin-top:8px';
    b.textContent = 'Activer le comptage des frappes';
    b.addEventListener('click', async () => {
      renderSettings(await window.satella.settings.set({ keyStats: true }));
      syncToolbars();
      toast('Statistiques de frappe activées (Paramètres pour les remettre à zéro).');
    });
    hintEl.appendChild(b);
  }
  refreshOverlayMarks();
  setAccent();
}

/* ================= Souris (SVG) ================= */
function buildMouse() {
  const wrap = $('#mouse-svg-wrap');
  wrap.innerHTML = `
  <svg width="300" height="420" viewBox="0 0 300 420">
    <path class="mouse-body" d="M150 15 C 70 15 45 90 45 180 L 45 300 C 45 375 95 405 150 405 C 205 405 255 375 255 300 L 255 180 C 255 90 230 15 150 15 Z"/>
    <line x1="150" y1="20" x2="150" y2="150" stroke="#2c3450" stroke-width="2"/>
    <rect class="mouse-zone" data-zone="wheel" x="138" y="60" width="24" height="52" rx="12" fill="#333"/>
    <circle class="mouse-zone" data-zone="logo" cx="150" cy="250" r="26" fill="#333"/>
    <path class="mouse-zone" data-zone="strip_left" d="M55 170 C 55 120 60 80 75 55 L 88 62 C 74 90 68 125 68 170 L 68 295 C 68 330 78 355 95 372 L 85 382 C 63 360 55 330 55 295 Z" fill="#333"/>
    <path class="mouse-zone" data-zone="strip_right" d="M245 170 C 245 120 240 80 225 55 L 212 62 C 226 90 232 125 232 170 L 232 295 C 232 330 222 355 205 372 L 215 382 C 237 360 245 330 245 295 Z" fill="#333"/>
    <path class="mouse-zone" data-zone="strip_bottom" d="M100 385 C 115 397 132 402 150 402 C 168 402 185 397 200 385 L 193 373 C 180 383 166 388 150 388 C 134 388 120 383 107 373 Z" fill="#333"/>
    <text class="mouse-zone-label" x="150" y="335" text-anchor="middle">PC365A</text>
  </svg>`;
  $$('.mouse-zone').forEach((el) => {
    el.addEventListener('click', () => {
      mouseSelection = el.dataset.zone;
      $$('.mouse-zone').forEach((z) => z.classList.toggle('selected', z === el));
      const zone = LAYOUT.mouse.find((z) => z.id === mouseSelection);
      $('#mouse-sel-label').textContent = zone ? zone.label : 'aucune';
    });
  });
}

/* ================= Aperçu temps réel ================= */
function buildHomePreviews() {
  for (const id of ['home-kb-preview', 'home-mouse-preview']) {
    const el = document.getElementById(id);
    el.innerHTML = '';
    const n = id.includes('kb') ? 24 : 5;
    for (let i = 0; i < n; i++) el.appendChild(document.createElement('span'));
  }
}

// Halo lumineux de la touche (diffusion des LEDs) + anneau de sélection
function setKeyVisual(el, rgb) {
  const parts = [];
  if (el.classList.contains('selected')) parts.push('0 0 0 1px #fff inset');
  if (rgb) {
    const lum = rgb[0] + rgb[1] + rgb[2];
    if (lum > 45) parts.push(`0 0 ${Math.round(6 + lum / 55)}px 1px rgba(${rgb[0]},${rgb[1]},${rgb[2]},.5)`);
  }
  el.style.boxShadow = parts.join(', ');
}

function applyFrame(frame) {
  lastFrame = frame;
  if (currentPage === 'keyboard') {
    for (const el of keyEls) {
      const rgb = frame.keyboard[el.dataset.id];
      if (!rgb) continue;
      el.firstElementChild.style.background = rgbCss(rgb);
      setKeyVisual(el, rgb);
    }
  }
  if (currentPage === 'mouse') {
    $$('.mouse-zone').forEach((el) => {
      const rgb = frame.mouse[el.dataset.zone];
      if (rgb && el.dataset.zone) {
        el.style.fill = rgbCss(rgb);
        el.style.filter = `drop-shadow(0 0 6px ${rgbCss(rgb)})`;
      }
    });
  }
  if (currentPage === 'home') {
    const kbSpans = $('#home-kb-preview').children;
    const keysList = LAYOUT.keyboard;
    for (let i = 0; i < kbSpans.length; i++) {
      const key = keysList[Math.floor((i / kbSpans.length) * keysList.length)];
      const rgb = frame.keyboard[key.id];
      if (rgb) kbSpans[i].style.background = rgbCss(rgb);
    }
    const msSpans = $('#home-mouse-preview').children;
    LAYOUT.mouse.forEach((z, i) => {
      const rgb = frame.mouse[z.id];
      if (rgb && msSpans[i]) msSpans[i].style.background = rgbCss(rgb);
    });
  }
}

/* ================= Visualiseur audio ================= */
// Capture du son de Windows (boucle de sortie, accordée par le processus
// principal) analysée en Web Audio ; 16 bandes envoyées ~30 fois/s.
const audioViz = (() => {
  let stream = null;
  let ctx = null;
  let analyser = null;
  let data = null;
  let timer = null;
  let starting = false;
  let warned = false;

  function report(msg) {
    window.satella.capture.reportError('audio', msg);
    if (!warned) toast('Visualiseur audio : ' + msg, 5000);
    warned = true;
  }

  async function start() {
    if (stream || starting) return;
    starting = true;
    try {
      // La vidéo est imposée par l'API : réduite au minimum et désactivée
      stream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: { width: 320, height: 180, frameRate: 1 },
      });
    } catch (err) {
      starting = false;
      report('capture du son impossible (' + err.message + ')');
      return;
    }
    starting = false;
    stream.getVideoTracks().forEach((t) => { t.enabled = false; });
    if (!stream.getAudioTracks().length) {
      report('aucun son capturé (disponible sous Windows uniquement)');
      stop();
      return;
    }
    warned = false;
    ctx = new AudioContext();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.55;
    ctx.createMediaStreamSource(stream).connect(analyser);
    data = new Uint8Array(analyser.frequencyBinCount);
    timer = setInterval(tick, 33);
  }

  function tick() {
    analyser.getByteFrequencyData(data);
    const nyquist = ctx.sampleRate / 2;
    const bands = [];
    // Bandes logarithmiques de 40 Hz à 16 kHz
    for (let i = 0; i < 16; i++) {
      const f0 = 40 * Math.pow(400, i / 16);
      const f1 = 40 * Math.pow(400, (i + 1) / 16);
      const b0 = Math.floor((f0 / nyquist) * data.length);
      const b1 = Math.max(b0 + 1, Math.ceil((f1 / nyquist) * data.length));
      let max = 0;
      for (let b = b0; b < b1 && b < data.length; b++) if (data[b] > max) max = data[b];
      bands.push(Math.max(0, Math.min(1, (max / 255 - 0.2) / 0.7)));
    }
    window.satella.capture.sendBands(bands);
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    if (ctx) ctx.close().catch(() => {});
    ctx = null;
  }

  return { start, stop };
})();
window.__satellaAudio = audioViz;

/* ================= Ambiance écran ================= */
// Capture vidéo de l'écran principal (10 images/s, basse définition) :
// moyenne des couleurs sur une grille 20 x 6 envoyée au moteur d'effets.
const SCREEN_COLS = 20;
const SCREEN_ROWS = 6;
const screenViz = (() => {
  let stream = null;
  let video = null;
  let ctx = null;
  let timer = null;
  let starting = false;
  let warned = false;
  const W = 160;
  const H = 90;
  const api = { start, stop, framesSent: 0 };

  function report(msg) {
    window.satella.capture.reportError('screen', msg);
    if (!warned) toast('Ambiance écran : ' + msg, 5000);
    warned = true;
  }

  async function start() {
    if (stream || starting) return;
    starting = true;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        video: { width: 640, height: 360, frameRate: 10 },
      });
    } catch (err) {
      starting = false;
      report('capture de l\'écran impossible (' + err.message + ')');
      return;
    }
    starting = false;
    warned = false;
    video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    video.play().catch(() => {});
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    ctx = canvas.getContext('2d', { willReadFrequently: true });
    timer = setInterval(tick, 100);
  }

  function tick() {
    if (!video || video.readyState < 2) return;
    ctx.drawImage(video, 0, 0, W, H);
    const px = ctx.getImageData(0, 0, W, H).data;
    const cw = W / SCREEN_COLS;
    const ch = H / SCREEN_ROWS;
    const grid = new Array(SCREEN_COLS * SCREEN_ROWS * 3);
    for (let r = 0; r < SCREEN_ROWS; r++) {
      for (let c = 0; c < SCREEN_COLS; c++) {
        let R = 0, G = 0, B = 0, n = 0;
        const y0 = Math.floor(r * ch), y1 = Math.floor((r + 1) * ch);
        const x0 = Math.floor(c * cw), x1 = Math.floor((c + 1) * cw);
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * W + x) * 4;
            R += px[i]; G += px[i + 1]; B += px[i + 2]; n++;
          }
        }
        const o = (r * SCREEN_COLS + c) * 3;
        grid[o] = Math.round(R / n);
        grid[o + 1] = Math.round(G / n);
        grid[o + 2] = Math.round(B / n);
      }
    }
    window.satella.capture.sendGrid(grid);
    api.framesSent++;
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    if (video) video.srcObject = null;
    video = null;
  }

  return api;
})();
window.__satellaScreen = screenViz;

window.satella.capture.onStop((kind) => {
  if (kind === 'audio') audioViz.stop();
  if (kind === 'screen') screenViz.stop();
});

/* ================= Macros ================= */
// Variables reconnues dans les étapes « Texte » et les abréviations
const TEXT_VARS_HELP = 'Variables : {date}, {heure}, {jour}, {mois}, {annee}, {presse-papiers} (texte copié), '
  + '{curseur} (le curseur s\'y place à la fin).';

const STEP_META = {
  keyTap: { icon: 'key', name: 'Touche' },
  keyDown: { icon: 'keyDown', name: 'Appui touche' },
  keyUp: { icon: 'keyUp', name: 'Relâche touche' },
  text: { icon: 'text', name: 'Texte' },
  delay: { icon: 'delay', name: 'Délai' },
  mouseClick: { icon: 'mouse', name: 'Clic' },
  mouseDown: { icon: 'mouse', name: 'Appui bouton' },
  mouseUp: { icon: 'mouse', name: 'Relâche bouton' },
  mouseMove: { icon: 'move', name: 'Déplacement' },
  mouseWheel: { icon: 'wheel', name: 'Molette' },
  loop: { icon: 'loop', name: 'Boucle' },
  runMacro: { icon: 'play', name: 'Exécuter macro' },
  open: { icon: 'open', name: 'Ouvrir' },
  waitKey: { icon: 'keyDown', name: 'Attendre touche' },
};

// Cible d'une étape « Ouvrir » (même règle que le processus principal) :
// lien web ou courriel, ou chemin Windows absolu
function validOpenTarget(v) {
  const s = String(v || '').trim();
  return /^(https?:\/\/|mailto:)[^\s<>"]+$/i.test(s) || /^([a-zA-Z]:\\|\\\\[^\\])[^\r\n\t<>"|?*]*$/.test(s);
}
const BUTTON_LABELS = { left: 'gauche', right: 'droit', middle: 'molette', x1: 'latéral 1', x2: 'latéral 2' };
const MAX_LOOP_DEPTH = 8;

function keyLabel(k) { return KEY_LABELS[k] || (k || '?').toUpperCase(); }

// Description en texte brut (échappée à l'insertion)
function stepDesc(s) {
  switch (s.type) {
    case 'keyTap': {
      const mods = (s.modifiers || []).map(keyLabel).join(' + ');
      return (mods ? mods + ' + ' : '') + keyLabel(s.key);
    }
    case 'keyDown': return 'Maintenir ' + keyLabel(s.key);
    case 'keyUp': return 'Relâcher ' + keyLabel(s.key);
    case 'text': {
      const v = String(s.value || '').replace(/\r?\n/g, ' ⏎ ');
      return `« ${v.slice(0, 40)}${v.length > 40 ? '…' : ''} »`;
    }
    case 'delay': return `${s.ms} ms`;
    case 'mouseClick': return `Clic ${BUTTON_LABELS[s.button] || s.button}${s.count > 1 ? ' ×' + s.count : ''}`;
    case 'mouseDown': return `Maintenir bouton ${BUTTON_LABELS[s.button] || s.button}`;
    case 'mouseUp': return `Relâcher bouton ${BUTTON_LABELS[s.button] || s.button}`;
    case 'mouseMove': return s.relative ? `Déplacer de (${s.x}, ${s.y})` : `Aller à (${s.x}, ${s.y})`;
    case 'mouseWheel': return `Molette ${s.horizontal ? (s.delta > 0 ? '→' : '←') : (s.delta > 0 ? '↑' : '↓')} (${Math.abs(s.delta / 120)} cran(s))`;
    case 'loop': return `Répéter ${s.count} fois (${(s.steps || []).length} étape(s))`;
    case 'runMacro': {
      const m = MACROS.find((x) => x.id === s.macroId);
      return m ? m.name : '(macro supprimée)';
    }
    case 'open': return s.target || '';
    case 'waitKey': return `Attendre ${keyLabel(s.key)}${s.timeoutMs ? ` (${s.timeoutMs / 1000} s max)` : ''}`;
    default: return s.type;
  }
}

function countSteps(list) {
  return (list || []).reduce((n, s) => n + 1 + (s.type === 'loop' ? countSteps(s.steps) : 0), 0);
}

function currentMacro() { return MACROS.find((m) => m.id === currentMacroId); }
function isUnsaved(m) { return SAVED.get(m.id) !== JSON.stringify(m); }
function markSaved(list) {
  SAVED.clear();
  for (const m of list) SAVED.set(m.id, JSON.stringify(m));
}
function shortcutError(kind, id) {
  return SHORTCUT_ERRORS.find((e) => e.kind === kind && e.id === id);
}

// Autre macro ou turbo utilisant déjà ce raccourci (avertissement)
function accelConflict(accel, self) {
  const k = normAccel(accel);
  const m = MACROS.find((x) => x !== self && x.enabled && x.trigger && normAccel(x.trigger.accelerator) === k);
  if (m) return `la macro « ${m.name} »`;
  const ti = TURBOS.findIndex((t) => t !== self && t.enabled && t.accelerator && normAccel(t.accelerator) === k);
  if (ti >= 0) return `le turbo n°${ti + 1}`;
  const app = APP_SHORTCUTS.find(([id]) => id !== self && (SETTINGS.appShortcuts || {})[id]
    && normAccel(SETTINGS.appShortcuts[id]) === k);
  if (app) return `la commande « ${app[1]} »`;
  return null;
}

async function playMacro(m, draft) {
  const res = await window.satella.macros.play(m.id, draft ? clone(m) : null);
  if (res && !res.ok) toast('Lecture impossible : ' + res.error, 4000);
}

function renderMacroList() {
  const list = $('#macro-list');
  list.innerHTML = '';
  if (!MACROS.length) {
    list.innerHTML = '<p class="muted">Aucune macro. Crée ta première macro !</p>';
    return;
  }
  for (const m of MACROS) {
    const el = document.createElement('div');
    const err = shortcutError('macro', m.id);
    el.className = 'macro-item' + (m.id === currentMacroId ? ' active' : '') + (m.enabled ? '' : ' disabled');
    el.dataset.id = m.id;
    el.innerHTML = `
      <span class="m-name">${esc(m.name)}${isUnsaved(m) ? ' <span class="m-unsaved" title="Modifications non sauvegardées">●</span>' : ''}</span>
      ${err ? `<span class="m-warn" title="Raccourci inactif : ${esc(err.reason)}">${svg('warn')}</span>` : ''}
      ${m.trigger && m.trigger.accelerator ? `<span class="m-trigger${err ? ' bad' : ''}">${esc(m.trigger.accelerator)}</span>` : ''}
      <button class="icon-btn m-play" title="Lire">${svg('play')}</button>`;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.m-play')) {
        playMacro(m, isUnsaved(m));
        return;
      }
      currentMacroId = m.id;
      renderMacroList();
      renderMacroEditor();
    });
    list.appendChild(el);
  }
}

/* ---- Annuler / rétablir (étapes de la macro en cours) ---- */
const history = { id: null, past: [], future: [] };

function resetHistory(id) {
  history.id = id;
  history.past = [];
  history.future = [];
}

function pushHistory() {
  const m = currentMacro();
  if (!m) return;
  if (history.id !== m.id) resetHistory(m.id);
  history.past.push(JSON.stringify(m.steps || []));
  if (history.past.length > 100) history.past.shift();
  history.future = [];
}

function undoSteps(redo = false) {
  const m = currentMacro();
  if (!m || history.id !== m.id) return;
  const from = redo ? history.future : history.past;
  const to = redo ? history.past : history.future;
  if (!from.length) return;
  to.push(JSON.stringify(m.steps || []));
  m.steps = JSON.parse(from.pop());
  renderSteps();
  renderMacroList();
}

function updateHistoryButtons() {
  const u = $('#me-undo');
  const r = $('#me-redo');
  if (u) u.disabled = !history.past.length;
  if (r) r.disabled = !history.future.length;
}

document.addEventListener('keydown', (e) => {
  if (currentPage === 'keyboard' && $('#modal-backdrop').hidden && !e.target.closest('input, textarea, select')) {
    const key = e.key.toLowerCase();
    if (e.ctrlKey && key === 'z' && !e.shiftKey) { e.preventDefault(); kbRestore(false); }
    else if (e.ctrlKey && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); kbRestore(true); }
    return;
  }
  if (currentPage !== 'macros' || !currentMacro() || !$('#modal-backdrop').hidden) return;
  if (e.target.closest('input, textarea, select')) return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey && k === 'z' && !e.shiftKey) { e.preventDefault(); undoSteps(false); }
  else if (e.ctrlKey && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); undoSteps(true); }
  else if (e.ctrlKey && k === 's') { e.preventDefault(); saveCurrentMacro(); }
});

function renderMacroEditor() {
  const ed = $('#macro-editor');
  const m = currentMacro();
  if (!m) {
    ed.innerHTML = '<p class="muted center">Sélectionne une macro ou crées-en une nouvelle.</p>';
    return;
  }
  if (history.id !== m.id) resetHistory(m.id);
  if (!m.options) m.options = {};
  const opts = m.options;
  const err = shortcutError('macro', m.id);
  ed.innerHTML = `
    <div class="form-grid">
      <label>Nom</label>
      <input type="text" id="me-name" maxlength="100" value="${esc(m.name)}">
      <label>Activée</label>
      <label class="check"><input type="checkbox" id="me-enabled" ${m.enabled ? 'checked' : ''}> la macro peut être déclenchée</label>
      <label>Déclencheur</label>
      <div class="btn-row">
        <input type="text" readonly class="trigger-input" id="me-trigger"
          value="${esc((m.trigger && m.trigger.accelerator) || '')}" placeholder="Clique puis presse un raccourci…">
        <button class="btn small" id="me-trigger-clear">Effacer</button>
        ${err ? `<span class="warn-text" style="flex-basis:100%">${svg('warn')} Raccourci inactif : ${esc(err.reason)}.</span>` : ''}
        <span class="muted" style="font-size:11.5px;flex-basis:100%">
          Toute touche est acceptée, seule ou combinée. Attention : une touche
          seule est réservée aux macros dans tout Windows tant que Satella
          tourne (un déclencheur « A » seul rend la lettre A intapable).</span>
      </div>
      <label>Répétitions</label>
      <div class="btn-row">
        <input type="number" id="me-repeat" min="1" max="9999" value="${+opts.repeat || 1}" style="width:80px" ${opts.loopInfinite ? 'disabled' : ''}>
        <label class="check"><input type="checkbox" id="me-infinite" ${opts.loopInfinite ? 'checked' : ''}> en boucle jusqu'à re-déclenchement</label>
      </div>
      <label>Délai entre répét.</label>
      <div class="btn-row">
        <input type="number" id="me-repeat-delay" min="0" max="600000" value="${+opts.repeatDelayMs || 0}" style="width:100px"> ms
      </div>
      <label>Vitesse ×<span id="me-speed-val">${+opts.speed || 1}</span></label>
      <input type="range" id="me-speed" min="0.25" max="4" step="0.25" value="${+opts.speed || 1}">
      <label>Durée d'appui</label>
      <div class="btn-row">
        <input type="number" id="me-hold" min="0" max="1000" value="${+opts.holdMs || 0}" style="width:80px"> ms
        <span class="muted" style="font-size:11.5px">maintien de chaque touche et clic ; 10 à 30 ms aident certains jeux</span>
      </div>
      <label>Variation aléatoire</label>
      <div class="btn-row">
        <input type="range" id="me-jitter" min="0" max="50" step="5" value="${+opts.jitter || 0}" style="width:140px">
        <span class="muted" id="me-jitter-val" style="font-family:var(--font-mono);font-size:12px">±${+opts.jitter || 0}%</span>
        <span class="muted" style="font-size:11.5px">des délais (rythme moins mécanique)</span>
      </div>
    </div>

    <div class="btn-row" style="margin-bottom:6px">
      <button class="btn primary" id="me-save" title="Ctrl+S">${svg('save')} Sauvegarder</button>
      <button class="btn" id="me-play" title="Joue la version affichée, même non sauvegardée">${svg('play')} Tester</button>
      <button class="btn" id="me-stop">${svg('stop')} Stop</button>
      <button class="btn ${recording ? 'danger' : ''}" id="me-record">${svg(recording ? 'stop' : 'record')} ${recording ? 'Arrêter l’enregistrement' : 'Enregistrer les entrées'}</button>
      <button class="btn danger" id="me-delete">${svg('trash')} Supprimer</button>
    </div>
    <div class="btn-row rec-opts" style="margin-bottom:6px">
      <span class="muted" style="font-size:12px">Enregistreur :</span>
      <label class="check"><input type="checkbox" id="rec-mouse" ${recordOpts.mouse ? 'checked' : ''}> clics et molette</label>
      <label class="check"><input type="checkbox" id="rec-pos" ${recordOpts.clickPositions ? 'checked' : ''}> clics à leur position</label>
      <label class="check"><input type="checkbox" id="rec-moves" ${recordOpts.moves ? 'checked' : ''}> mouvements</label>
    </div>
    ${recording ? `<div class="recording-banner"><div class="rec-dot"></div>
      <span>Enregistrement en cours (<span id="rec-count">${recordedSteps.length}</span> étapes). Utilise clavier et souris librement, puis clique sur Arrêter.</span></div>` : ''}

    <div class="steps-head">
      <h2>Étapes (<span id="me-steps-count">${countSteps(m.steps)}</span>)</h2>
      <span class="muted" id="me-unsaved" style="font-size:12px"></span>
      <button class="icon-btn" id="me-undo" title="Annuler (Ctrl+Z)">${svg('undo', 'icon')}</button>
      <button class="icon-btn" id="me-redo" title="Rétablir (Ctrl+Y)">${svg('redo', 'icon')}</button>
    </div>
    <p class="muted" style="font-size:11.5px">Glisse une étape par sa poignée pour la déplacer, y compris dans une boucle.</p>
    <div class="steps-list" id="me-steps"></div>
    <div class="add-step-bar" id="me-add-bar"></div>
  `;

  renderSteps();
  buildAddBar($('#me-add-bar'), [], 0);

  const touched = () => renderMacroList();
  $('#me-name').addEventListener('input', (e) => { m.name = e.target.value; touched(); });
  $('#me-enabled').addEventListener('change', (e) => { m.enabled = e.target.checked; touched(); });
  $('#me-infinite').addEventListener('change', (e) => {
    m.options.loopInfinite = e.target.checked;
    $('#me-repeat').disabled = e.target.checked;
    touched();
  });
  $('#me-repeat').addEventListener('input', (e) => { m.options.repeat = +e.target.value; touched(); });
  $('#me-repeat-delay').addEventListener('input', (e) => { m.options.repeatDelayMs = +e.target.value; touched(); });
  $('#me-speed').addEventListener('input', (e) => {
    m.options.speed = +e.target.value;
    $('#me-speed-val').textContent = e.target.value;
    touched();
  });
  $('#me-hold').addEventListener('input', (e) => { m.options.holdMs = Math.max(0, +e.target.value || 0); touched(); });
  $('#me-jitter').addEventListener('input', (e) => {
    m.options.jitter = +e.target.value;
    $('#me-jitter-val').textContent = '±' + e.target.value + '%';
    touched();
  });
  $('#me-trigger-clear').addEventListener('click', () => {
    m.trigger = null;
    $('#me-trigger').value = '';
    touched();
  });
  setupTriggerCapture($('#me-trigger'), m);

  $('#me-save').addEventListener('click', saveCurrentMacro);
  $('#me-play').addEventListener('click', () => playMacro(m, true));
  $('#me-stop').addEventListener('click', () => window.satella.macros.stop(m.id));
  $('#me-delete').addEventListener('click', async () => {
    if (!confirm(`Supprimer la macro « ${m.name} » ?`)) return;
    const drafts = MACROS.filter((x) => x.id !== m.id && isUnsaved(x));
    const saved = await window.satella.macros.remove(m.id);
    mergeSavedMacros(saved, drafts);
    currentMacroId = null;
    renderMacroList();
    renderMacroEditor();
  });
  $('#me-record').addEventListener('click', toggleRecording);
  $('#rec-mouse').addEventListener('change', (e) => { recordOpts.mouse = e.target.checked; });
  $('#rec-pos').addEventListener('change', (e) => { recordOpts.clickPositions = e.target.checked; });
  $('#rec-moves').addEventListener('change', (e) => { recordOpts.moves = e.target.checked; });
  $('#me-undo').addEventListener('click', () => undoSteps(false));
  $('#me-redo').addEventListener('click', () => undoSteps(true));
}

// Liste renvoyée par le processus principal (versions sauvegardées) +
// brouillons non sauvegardés des autres macros, conservés
// L'ordre affiché est conservé : un brouillon ne part pas en fin de liste
// quand une autre macro est sauvegardée.
function mergeSavedMacros(saved, drafts) {
  markSaved(saved);
  const byId = new Map(saved.map((s) => [s.id, s]));
  const merged = [];
  for (const m of MACROS) {
    const draft = drafts.find((d) => d.id === m.id);
    if (draft) merged.push(draft);
    else if (byId.has(m.id)) merged.push(byId.get(m.id));
    byId.delete(m.id);
  }
  for (const s of byId.values()) merged.push(s);
  MACROS = merged;
}

async function saveCurrentMacro() {
  const m = currentMacro();
  if (!m) return;
  if (!m.name.trim()) return toast('Donne un nom à la macro.');
  const drafts = MACROS.filter((x) => x.id !== m.id && isUnsaved(x));
  const saved = await window.satella.macros.save(clone(m));
  mergeSavedMacros(saved, drafts);
  renderMacroList();
  renderSteps();
  toast('Macro sauvegardée.');
}

/* Étapes : accès par chemin (boucles imbriquées sur plusieurs niveaux).
   getStepsAt([]) = étapes de la macro ; getStepsAt([2]) = étapes de la
   boucle n°2 ; getStepsAt([2, 0]) = boucle n°0 dans la boucle n°2... */
function getStepsAt(containerPath) {
  const m = currentMacro();
  if (!m.steps) m.steps = [];
  let list = m.steps;
  for (const i of containerPath) {
    const s = list[i];
    if (!s.steps) s.steps = [];
    list = s.steps;
  }
  return list;
}

function renderSteps() {
  const m = currentMacro();
  const cont = $('#me-steps');
  if (!m || !cont) return;
  cont.innerHTML = '';
  if (!m.steps) m.steps = [];
  $('#me-steps-count').textContent = countSteps(m.steps);
  $('#me-unsaved').textContent = isUnsaved(m) ? 'modifications non sauvegardées' : '';
  updateHistoryButtons();
  if (!m.steps.length) {
    cont.innerHTML = '<p class="muted">Aucune étape. Ajoute des étapes ou utilise l’enregistreur.</p>';
    return;
  }
  appendSteps(cont, m.steps, [], 0);
}

function appendSteps(cont, list, containerPath, depth) {
  list.forEach((s, i) => {
    const path = [...containerPath, i];
    cont.appendChild(stepRow(s, path, depth));
    if (s.type === 'loop') {
      appendSteps(cont, s.steps || [], path, depth + 1);
      const addRow = document.createElement('div');
      addRow.className = 'step-row nested add-row';
      addRow.style.marginLeft = (depth + 1) * 28 + 'px';
      addRow.innerHTML = `<span class="s-icon">${svg('loop')}</span>`;
      const bar = document.createElement('div');
      bar.className = 'add-step-bar';
      bar.style.margin = '0';
      buildAddBar(bar, path, depth + 1);
      addRow.appendChild(bar);
      // Déposer ici = ajouter à la fin de la boucle
      setupDropTarget(addRow, () => [path, (s.steps || []).length]);
      cont.appendChild(addRow);
    }
  });
}

/* ---- Glisser-déposer ---- */
let dragPath = null;

function setupDropTarget(el, target) {
  el.addEventListener('dragover', (e) => {
    if (!dragPath) return;
    e.preventDefault();
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drop-target');
    if (!dragPath) return;
    const [containerPath, index] = target();
    moveStep(dragPath, containerPath, index);
    dragPath = null;
  });
}

// Déplace l'étape `from` (chemin complet) à la position `toIndex` de la
// liste `toContainer`. Une boucle ne peut pas être déposée en elle-même.
function moveStep(from, toContainer, toIndex) {
  const inside = toContainer.length >= from.length && from.every((v, i) => toContainer[i] === v);
  if (inside) return toast('Une boucle ne peut pas être déplacée à l’intérieur d’elle-même.');
  if (toContainer.length + 1 > MAX_LOOP_DEPTH && getStepsAt(from.slice(0, -1))[from[from.length - 1]].type === 'loop') {
    return toast('Imbrication maximale atteinte.');
  }
  const fromList = getStepsAt(from.slice(0, -1));
  const fromIdx = from[from.length - 1];
  const toList = getStepsAt(toContainer); // référence résolue avant le retrait
  if (fromList === toList && (toIndex === fromIdx || toIndex === fromIdx + 1)) return;
  pushHistory();
  const [item] = fromList.splice(fromIdx, 1);
  let idx = toIndex;
  if (fromList === toList && fromIdx < toIndex) idx--;
  toList.splice(idx, 0, item);
  renderSteps();
  renderMacroList();
}

function stepRow(s, path, depth) {
  const meta = STEP_META[s.type] || { icon: 'key', name: s.type };
  const row = document.createElement('div');
  row.className = 'step-row' + (depth ? ' nested' : '');
  if (depth) row.style.marginLeft = depth * 28 + 'px';
  row.innerHTML = `
    <span class="s-grip" title="Glisser pour déplacer">${svg('grip')}</span>
    <span class="s-icon">${svg(meta.icon)}</span>
    <span class="s-type">${esc(meta.name)}</span>
    <span class="s-desc">${esc(stepDesc(s))}</span>
    <span class="s-actions">
      <button class="icon-btn" data-act="up" title="Monter">${svg('up')}</button>
      <button class="icon-btn" data-act="down" title="Descendre">${svg('down')}</button>
      <button class="icon-btn" data-act="edit" title="Modifier">${svg('edit')}</button>
      <button class="icon-btn" data-act="dup" title="Dupliquer">${svg('copy')}</button>
      <button class="icon-btn" data-act="del" title="Supprimer">${svg('close')}</button>
    </span>`;
  row.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.s-actions')) openStepModal(s.type, path);
  });
  row.querySelector('.s-actions').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    const act = btn && btn.dataset.act;
    if (!act) return;
    if (act === 'edit') return openStepModal(s.type, path);
    const list = getStepsAt(path.slice(0, -1));
    const idx = path[path.length - 1];
    if ((act === 'up' && idx === 0) || (act === 'down' && idx >= list.length - 1)) return;
    pushHistory();
    if (act === 'del') list.splice(idx, 1);
    else if (act === 'dup') list.splice(idx + 1, 0, clone(s));
    else if (act === 'up') [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]];
    else if (act === 'down') [list[idx + 1], list[idx]] = [list[idx], list[idx + 1]];
    renderSteps();
    renderMacroList();
  });
  // Glisser depuis la poignée uniquement (pas de déplacement accidentel)
  const grip = row.querySelector('.s-grip');
  grip.addEventListener('mousedown', () => { row.draggable = true; });
  row.addEventListener('dragstart', (e) => {
    dragPath = path;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', 'step');
    row.classList.add('dragging');
  });
  row.addEventListener('dragend', () => {
    row.draggable = false;
    row.classList.remove('dragging');
    dragPath = null;
  });
  setupDropTarget(row, () => [path.slice(0, -1), path[path.length - 1]]);
  return row;
}

function buildAddBar(container, containerPath, depth) {
  // Tous les types à tous les niveaux, sauf une boucle au-delà de la
  // profondeur maximale
  const types = Object.keys(STEP_META).filter((t) => t !== 'loop' || depth < MAX_LOOP_DEPTH);
  for (const t of types) {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.innerHTML = svg(STEP_META[t].icon) + ' ' + esc(STEP_META[t].name);
    b.addEventListener('click', () => openStepModal(t, null, containerPath));
    container.appendChild(b);
  }
}

// Macros qui finissent (directement ou non) par appeler `targetId` :
// les proposer dans « Exécuter macro » créerait une boucle infinie
function callersOf(targetId) {
  const calls = (steps, ids) => (steps || []).some((s) =>
    (s.type === 'runMacro' && ids.has(s.macroId)) || (s.type === 'loop' && calls(s.steps, ids)));
  const result = new Set([targetId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of MACROS) {
      if (!result.has(m.id) && calls(m.steps, result)) {
        result.add(m.id);
        changed = true;
      }
    }
  }
  return result;
}

/* ---- Modale d'édition d'étape ---- */
function openStepModal(type, editPath = null, addPath = []) {
  const modal = $('#modal');
  const backdrop = $('#modal-backdrop');
  const existing = editPath ? getStepsAt(editPath.slice(0, -1))[editPath[editPath.length - 1]] : null;
  const s = existing || { type };
  const meta = STEP_META[type];

  const keyOptions = KEY_NAMES.map((k) =>
    `<option value="${esc(k)}" ${s.key === k ? 'selected' : ''}>${esc(keyLabel(k))}</option>`).join('');
  const btnOptions = Object.entries(BUTTON_LABELS).map(([v, l]) =>
    `<option value="${v}" ${s.button === v ? 'selected' : ''}>${l}</option>`).join('');
  const forbidden = callersOf(currentMacroId);
  const macroOptions = MACROS.filter((m) => !forbidden.has(m.id)).map((m) =>
    `<option value="${esc(m.id)}" ${s.macroId === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('');

  let fields = '';
  switch (type) {
    case 'keyTap':
      fields = `
        <label>Touche</label><select id="sf-key">${keyOptions}</select>
        <label>Modificateurs</label>
        <div class="btn-row">
          ${['lctrl', 'lshift', 'lalt', 'lwin'].map((mod) => `
            <label class="check"><input type="checkbox" class="sf-mod" value="${mod}"
              ${(s.modifiers || []).includes(mod) ? 'checked' : ''}> ${esc(keyLabel(mod).replace(' gauche', ''))}</label>`).join('')}
        </div>`;
      break;
    case 'keyDown': case 'keyUp':
      fields = `<label>Touche</label><select id="sf-key">${keyOptions}</select>`;
      break;
    case 'text':
      fields = `<label>Texte à taper</label>
        <textarea id="sf-text" rows="4" style="width:100%">${esc(s.value || '')}</textarea>
        <p class="muted" style="grid-column:1/3;font-size:11.5px">Les retours à la ligne deviennent des appuis sur Entrée, les tabulations des appuis sur Tab.</p>
        <p class="muted" style="grid-column:1/3;font-size:11.5px">${TEXT_VARS_HELP}</p>`;
      break;
    case 'delay':
      fields = `<label>Durée (ms)</label><input type="number" id="sf-ms" min="1" max="600000" value="${+s.ms || 100}">`;
      break;
    case 'mouseClick':
      fields = `
        <label>Bouton</label><select id="sf-button">${btnOptions}</select>
        <label>Nombre de clics</label><input type="number" id="sf-count" min="1" max="100" value="${+s.count || 1}">`;
      break;
    case 'mouseDown': case 'mouseUp':
      fields = `<label>Bouton</label><select id="sf-button">${btnOptions}</select>`;
      break;
    case 'mouseMove':
      fields = `
        <label>X</label><input type="number" id="sf-x" value="${+s.x || 0}">
        <label>Y</label><input type="number" id="sf-y" value="${+s.y || 0}">
        <label class="check" style="grid-column:1/3"><input type="checkbox" id="sf-relative" ${s.relative ? 'checked' : ''}> Déplacement relatif (sinon position absolue, tous écrans confondus)</label>`;
      break;
    case 'mouseWheel':
      fields = `
        <label>Crans (+ haut / − bas)</label><input type="number" id="sf-cranks" min="-50" max="50" value="${(s.delta || 120) / 120}">
        <label class="check" style="grid-column:1/3"><input type="checkbox" id="sf-horizontal" ${s.horizontal ? 'checked' : ''}> Défilement horizontal</label>`;
      break;
    case 'loop':
      fields = `<label>Nombre de répétitions</label><input type="number" id="sf-count" min="1" max="10000" value="${+s.count || 2}">
        <p class="muted" style="grid-column:1/3">Les étapes de la boucle s'ajoutent ensuite sous celle-ci dans la liste.</p>`;
      break;
    case 'open':
      fields = `<label>Programme, fichier ou lien</label>
        <div class="btn-row">
          <input type="text" id="sf-target" style="flex:1" maxlength="1000" placeholder="https://… ou C:\\…\\programme.exe" value="${esc(s.target || '')}">
          <button class="btn small" id="sf-browse">Parcourir…</button>
        </div>
        <p class="muted" style="grid-column:1/3;font-size:11.5px">Un lien s'ouvre dans le navigateur, un programme se lance,
          un fichier s'ouvre avec son application habituelle.</p>`;
      break;
    case 'waitKey':
      fields = `<label>Touche attendue</label><select id="sf-key">${keyOptions}</select>
        <label>Attente maximale (s)</label>
        <input type="number" id="sf-timeout" min="0" max="600" step="0.5" value="${(+s.timeoutMs || 0) / 1000}">
        <p class="muted" style="grid-column:1/3;font-size:11.5px">La macro s'arrête là jusqu'à ce que tu appuies sur
          cette touche (0 = sans limite) ; passé le délai, elle continue.</p>`;
      break;
    case 'runMacro':
      fields = macroOptions
        ? `<label>Macro à exécuter</label><select id="sf-macro">${macroOptions}</select>`
        : '<p class="muted">Aucune autre macro disponible (celles qui appellent déjà cette macro sont exclues pour éviter une boucle infinie).</p>';
      break;
  }

  modal.innerHTML = `
    <h3>${svg(meta.icon, 'icon')} ${esc(meta.name)}</h3>
    <div class="form-grid">${fields}</div>
    <label>Pause après l'étape (ms)</label>
    <input type="number" id="sf-gap" min="0" max="60000" value="${s.gapMs !== undefined ? +s.gapMs : 15}" style="margin:6px 0 14px">
    <div class="btn-row">
      <button class="btn primary" id="sf-ok">Valider</button>
      <button class="btn" id="sf-cancel">Annuler</button>
    </div>`;
  backdrop.hidden = false;

  if ($('#sf-browse')) {
    $('#sf-browse').addEventListener('click', async () => {
      const file = await window.satella.pickFile();
      if (file) $('#sf-target').value = file;
    });
  }
  $('#sf-cancel').addEventListener('click', () => { backdrop.hidden = true; });
  $('#sf-ok').addEventListener('click', () => {
    const gap = $('#sf-gap').value;
    const out = { type, gapMs: gap === '' ? 15 : Math.max(0, +gap) };
    switch (type) {
      case 'keyTap':
        out.key = $('#sf-key').value;
        out.modifiers = $$('.sf-mod:checked').map((c) => c.value);
        break;
      case 'keyDown': case 'keyUp': out.key = $('#sf-key').value; break;
      case 'text': out.value = $('#sf-text').value; break;
      case 'delay': out.ms = Math.max(0, +$('#sf-ms').value || 0); break;
      case 'mouseClick': out.button = $('#sf-button').value; out.count = Math.max(1, +$('#sf-count').value || 1); break;
      case 'mouseDown': case 'mouseUp': out.button = $('#sf-button').value; break;
      case 'mouseMove':
        out.x = +$('#sf-x').value || 0; out.y = +$('#sf-y').value || 0;
        out.relative = $('#sf-relative').checked;
        break;
      case 'mouseWheel': {
        const cranks = +$('#sf-cranks').value;
        if (!cranks) return toast('Indique un nombre de crans non nul.');
        out.delta = cranks * 120;
        out.horizontal = $('#sf-horizontal').checked;
        break;
      }
      case 'loop':
        out.count = Math.max(1, +$('#sf-count').value || 1);
        out.steps = existing ? existing.steps || [] : [];
        break;
      case 'open':
        out.target = $('#sf-target').value.trim();
        if (!validOpenTarget(out.target)) {
          return toast('Indique un lien (https://…) ou le chemin complet d\'un programme ou fichier (C:\\…).', 4500);
        }
        break;
      case 'waitKey':
        out.key = $('#sf-key').value;
        out.timeoutMs = Math.max(0, Math.min(600000, Math.round((+$('#sf-timeout').value || 0) * 1000)));
        break;
      case 'runMacro':
        if (!$('#sf-macro')) { backdrop.hidden = true; return; }
        out.macroId = $('#sf-macro').value;
        break;
    }
    pushHistory();
    if (editPath) {
      const list = getStepsAt(editPath.slice(0, -1));
      list[editPath[editPath.length - 1]] = out;
    } else {
      getStepsAt(addPath).push(out);
    }
    backdrop.hidden = true;
    renderSteps();
    renderMacroList();
  });
}
$('#modal-backdrop').addEventListener('click', (e) => {
  if (calib) return; // pas de fermeture accidentelle pendant la calibration
  if (e.target === e.currentTarget) {
    e.currentTarget.hidden = true;
    e.currentTarget.dispatchEvent(new Event('modal-dismiss'));
  }
});

/* ================= Calibration de la carte des touches ================= */
let calib = null; // { slot, map, mapped, lastAdvance }
const CALIB_TOTAL = 128;

async function calibLight() {
  const res = await window.satella.calib.light(calib.slot);
  if (!res.ok) {
    toast('Calibration : ' + res.error, 4000);
    await calibStop(false);
  }
}

function renderCalibModal() {
  if (!calib) return;
  const last = calib.lastLabel
    ? `<p class="muted" style="margin-top:8px">Dernière touche associée : ${esc(calib.lastLabel)}</p>` : '';
  const dup = calib.dupWarn
    ? `<p style="margin-top:8px;color:var(--warn)">Appui reconnu comme « ${esc(calib.dupWarn)} », déjà associée.
       Si la touche allumée est sa jumelle (Alt droit, Ctrl droit...), le clavier envoie le même code :
       associe-la manuellement ci-dessous.</p>` : '';
  const options = LAYOUT.keyboard.map((k) => {
    const label = keyLabel(k.id) + (calib.map[k.id] !== undefined ? ' (déjà associée)' : '');
    return `<option value="${esc(k.id)}">${esc(label)}</option>`;
  }).join('');
  $('#modal').innerHTML = `
    <h3>${svg('key', 'icon')} Calibration (${calib.slot + 1} / ${CALIB_TOTAL})</h3>
    <p>Une touche de ton clavier vient de s'allumer en <b>vert</b>.
       Presse cette touche. S'il n'y a aucune touche allumée, clique sur Passer.</p>
    <p class="muted" style="margin-top:8px">${calib.mapped} touche(s) associée(s) pour l'instant.</p>
    ${last}
    ${dup}
    <div class="btn-row" style="margin-top:14px">
      <select id="calib-manual-key">${options}</select>
      <button class="btn small" id="calib-manual">Associer manuellement</button>
    </div>
    <p class="muted" style="font-size:11.5px;margin-top:4px">
      Pour une touche muette comme Fn : choisis son nom ci-dessus puis Associer.</p>
    <div class="btn-row" style="margin-top:14px">
      <button class="btn primary" id="calib-skip">Passer (rien d'allumé)</button>
      <button class="btn" id="calib-finish">Terminer et enregistrer</button>
      <button class="btn danger" id="calib-cancel">Annuler</button>
    </div>`;
  $('#calib-skip').addEventListener('click', () => calibAdvance());
  $('#calib-finish').addEventListener('click', () => calibStop(true));
  $('#calib-cancel').addEventListener('click', () => calibStop(false));
  $('#calib-manual').addEventListener('click', () => {
    const id = $('#calib-manual-key').value;
    calib.map[id] = calib.slot;
    calib.mapped = Object.keys(calib.map).length;
    calib.lastLabel = `${keyLabel(id)} (emplacement ${calib.slot}, manuel)`;
    calibAdvance();
  });
}

async function calibAdvance() {
  calib.slot++;
  calib.dupWarn = '';
  calib.lastAdvance = Date.now();
  if (calib.slot >= CALIB_TOTAL) return calibStop(true);
  renderCalibModal();
  await calibLight();
}

async function calibStop(save) {
  const map = calib ? calib.map : {};
  const mapped = calib ? calib.mapped : 0;
  calib = null;
  $('#modal-backdrop').hidden = true;
  if (save && mapped > 0) {
    await window.satella.calib.finish(map);
    toast(`Calibration enregistrée : ${mapped} touche(s) associée(s).`);
  } else {
    await window.satella.calib.cancel();
    if (save) toast('Calibration vide : rien à enregistrer.');
    else toast('Calibration annulée.');
  }
}

$('#kb-calibrate').addEventListener('click', async () => {
  if (!DIRECT.keyboard) return toast('Clavier non connecté en direct.');
  calib = { slot: 0, map: {}, mapped: 0, lastAdvance: Date.now(), lastLabel: '' };
  $('#modal-backdrop').hidden = false;
  renderCalibModal();
  await calibLight();
});

window.satella.macros.onKeyActivity(({ key }) => {
  if (!calib || !key) return;
  if (Date.now() - calib.lastAdvance < 300) return; // anti-rebond
  if (calib.map[key] !== undefined && calib.map[key] !== calib.slot) {
    // Touche jumelle probable (Alt droit, Ctrl droit... certains claviers
    // envoient le même code que la variante gauche) : ne rien écraser,
    // demander une association manuelle.
    calib.dupWarn = keyLabel(key);
    renderCalibModal();
    return;
  }
  calib.map[key] = calib.slot;
  calib.mapped = Object.keys(calib.map).length;
  calib.lastLabel = `${keyLabel(key)} (emplacement ${calib.slot})`;
  calibAdvance();
});

/* ---- Capture du déclencheur ---- */
// Traduit un événement clavier du navigateur en accélérateur Electron
function acceleratorFromEvent(e) {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Super');
  const codeMap = {
    Space: 'Space', Enter: 'Return', NumpadEnter: 'Return', Escape: 'Esc',
    Backspace: 'Backspace', Tab: 'Tab', CapsLock: 'Capslock',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End',
    PageUp: 'PageUp', PageDown: 'PageDown', PrintScreen: 'PrintScreen',
    NumLock: 'Numlock', ScrollLock: 'Scrolllock',
    Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
    BracketLeft: '[', BracketRight: ']', Backslash: '\\', Backquote: '`',
    Minus: '-', Equal: '=', IntlBackslash: '\\',
    NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadAdd: 'numadd',
    NumpadSubtract: 'numsub', NumpadDecimal: 'numdec',
  };
  let key = null;
  if (/^Key([A-Z])$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit(\d)$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  else if (/^Numpad(\d)$/.test(e.code)) key = 'num' + e.code.slice(6);
  else if (codeMap[e.code]) key = codeMap[e.code];
  if (!key) return null;
  parts.push(key);
  return parts.join('+');
}

// Champ de capture générique : focus, pression d'un raccourci, rappel
function captureAccelerator(inputEl, getCurrent, onAccel, self) {
  inputEl.addEventListener('focus', () => {
    inputEl.classList.add('capturing');
    inputEl.value = 'Presse un raccourci…';
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const accel = acceleratorFromEvent(e);
      if (!accel) return;
      const other = accelConflict(accel, self);
      if (other) toast(`Attention : ${accel} est déjà utilisé par ${other}.`, 4000);
      onAccel(accel);
      inputEl.value = accel;
      inputEl.blur();
    };
    inputEl.addEventListener('keydown', onKey);
    inputEl.addEventListener('blur', () => {
      inputEl.classList.remove('capturing');
      inputEl.removeEventListener('keydown', onKey);
      inputEl.value = getCurrent() || '';
    }, { once: true });
  });
}

function setupTriggerCapture(inputEl, macro) {
  captureAccelerator(
    inputEl,
    () => macro.trigger && macro.trigger.accelerator,
    (accel) => {
      macro.trigger = { type: 'hotkey', accelerator: accel };
      renderMacroList();
    },
    macro
  );
}

/* ---- Enregistreur ---- */
async function toggleRecording() {
  const m = currentMacro();
  if (!m) return;
  if (!recording) {
    if (!CAPS.uiohook) return toast("L'écoute globale n'est pas disponible sur ce système.");
    recording = true;
    recordedSteps = [];
    await window.satella.macros.recordStart({ ...recordOpts });
    renderMacroEditor();
  } else {
    recording = false;
    let steps = await window.satella.macros.recordStop();
    steps = trimRecordingTail(steps);
    pushHistory();
    m.steps = (m.steps || []).concat(steps);
    renderMacroEditor();
    renderMacroList();
    toast(`${steps.length} étape(s) ajoutée(s) depuis l'enregistrement.`);
  }
}

// Retire le clic final sur le bouton « Arrêter » (et les délais orphelins)
function trimRecordingTail(steps) {
  const out = [...steps];
  while (out.length) {
    const last = out[out.length - 1];
    if (['mouseDown', 'mouseUp', 'mouseMove', 'delay'].includes(last.type)) out.pop();
    else break;
  }
  return out;
}

function newMacro() {
  const m = {
    id: uid(),
    name: 'Nouvelle macro',
    enabled: true,
    trigger: null,
    options: { repeat: 1, loopInfinite: false, repeatDelayMs: 0, speed: 1, holdMs: 0, jitter: 0 },
    steps: [],
  };
  MACROS.push(m);
  currentMacroId = m.id;
  renderMacroList();
  renderMacroEditor();
}
$('#macro-new').addEventListener('click', newMacro);

// Nouvelle liste de macros venue du processus principal (profil chargé)
function replaceMacros(list, reason) {
  const lost = MACROS.filter(isUnsaved);
  MACROS = list;
  markSaved(list);
  currentMacroId = MACROS.some((m) => m.id === currentMacroId) ? currentMacroId : null;
  renderMacroList();
  renderMacroEditor();
  if (lost.length && reason) {
    toast(`${reason} : modifications non sauvegardées abandonnées (${lost.map((m) => m.name).join(', ')}).`, 5000);
  }
}

/* ================= Périphériques ================= */
let DIRECT = { keyboard: null, mouse: null };

function updateBadge() {
  const badge = $('#backend-badge');
  const row = (label, direct) => `
    <div class="dev-status ${direct ? 'on' : ''}">
      <span class="dot"></span>
      <span class="dv-name">${label}</span>
      <span class="dv-via">${direct ? 'DIRECT' : 'ABSENT'}</span>
    </div>`;
  badge.innerHTML = row('GS98', DIRECT.keyboard) + row('PC365A', DIRECT.mouse) + `
    <button class="side-toggle ${DIMMED ? 'on' : ''}" id="leds-toggle"
      title="Éteindre ou rallumer toutes les LED">${DIMMED ? 'LED éteintes · rallumer' : 'Éteindre les LED'}</button>
    <div class="side-profile" title="Les modifications d'éclairage et de macros sont enregistrées dans ce profil">
      Profil : <b>${ACTIVE_PROFILE ? esc(ACTIVE_PROFILE) : 'aucun'}</b></div>`;
  $('#leds-toggle').addEventListener('click', async () => {
    DIMMED = await window.satella.led.setManualOff(!DIMMED);
    updateBadge();
  });
}

function renderDirectPanel(status) {
  DIRECT = status;
  updateBadge();
  const p = $('#direct-panel');
  const row = (dev, label, chip) => `
    <div class="hid-row">
      <span style="flex:1">${label}</span>
      <span class="h-ids">${chip}</span>
      ${dev
        ? '<span class="tag tag-target">Connecté en direct</span>'
        : '<span class="tag tag-vendor">Non détecté</span>'}
    </div>`;
  p.innerHTML = `
    <h2 style="margin-top:0">Pilotage USB direct, intégré à Satella</h2>
    <p class="muted" style="margin-bottom:10px">
      Satella parle directement au matériel, sans logiciel tiers. Le clavier utilise
      ses effets natifs (dont l'éclairage touche par touche) et mémorise les
      réglages dans sa propre mémoire. Un périphérique rebranché reçoit
      automatiquement les réglages en cours.
    </p>
    ${row(status.keyboard, 'Clavier SURMEN GS98, puce EVision', '320F:505B')}
    ${row(status.mouse, 'Souris Risophy PC365A, puce Areson', '25A7:FA7B')}
    ${status.error ? `<p class="muted">Attention : ${esc(status.error)}</p>` : ''}
  `;
}

function renderHidList(hid) {
  const p = $('#hid-list');
  if (!hid.available) {
    p.innerHTML = `<p class="muted">Détection USB indisponible : ${esc(hid.error || '')}</p>`;
    return;
  }
  const devs = hid.devices.filter((d) => d.product || d.manufacturer);
  devs.sort((a, b) => (b.isLikelyTarget - a.isLikelyTarget));
  p.innerHTML = devs.map((d) => `
    <div class="hid-row">
      <span style="flex:1">${d.manufacturer ? esc(d.manufacturer) + ' · ' : ''}${esc(d.product || '(sans nom)')}</span>
      <span class="h-ids">${esc(d.vid)}:${esc(d.pid)}</span>
      ${d.isLikelyTarget ? '<span class="tag tag-target">Ton périphérique</span>' : ''}
      ${d.looksLikeKeyboard ? '<span class="tag tag-kb">Clavier</span>' : ''}
      ${d.looksLikeMouse ? '<span class="tag tag-mouse">Souris</span>' : ''}
      ${d.hasVendorInterface ? '<span class="tag tag-vendor">Canal RGB potentiel</span>' : ''}
    </div>`).join('') || '<p class="muted">Aucun périphérique HID détecté.</p>';
}

$('#dev-refresh').addEventListener('click', async () => {
  renderHidList(await window.satella.devices.refreshHid());
  toast('Liste actualisée.');
});

/* ---- Diagnostic matériel ---- */
const DIAG_MOUSE_MODES = [
  [0x00, '0 : vague arc-en-ciel'], [0x01, '1 : respiration'], [0x02, '2 : statique'],
  [0x03, '3 : cycle de spectre'], [0x04, '4 : éteint'], [0x05, '5 : vague monochrome'],
  [0x06, '6 : inconnu'], [0x07, '7 : respiration multicolore'], [0x08, '8 : inconnu'],
];
(function buildDiag() {
  const cont = $('#diag-mouse-modes');
  for (const [value, label] of DIAG_MOUSE_MODES) {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.textContent = label;
    b.addEventListener('click', async () => {
      const res = await window.satella.devices.testMouse(value);
      $('#diag-result').textContent = res.ok
        ? `Souris : mode ${value} envoyé. Qu'affiche la souris ?`
        : `Souris : échec (${res.error})`;
    });
    cont.appendChild(b);
  }
  // Visualiseur de frappes : montre exactement ce que Satella reçoit
  let keysDebug = false;
  const keysSeen = [];
  $('#diag-keys-toggle').addEventListener('click', async () => {
    keysDebug = !keysDebug;
    await window.satella.devices.hookDebug(keysDebug);
    $('#diag-keys-toggle').textContent = keysDebug ? "Arrêter l'écoute" : "Activer l'écoute";
    if (keysDebug) { keysSeen.length = 0; $('#diag-keys').textContent = 'Presse des touches...'; }
  });
  window.satella.macros.onKeyActivity(({ key }) => {
    if (!keysDebug || !key) return;
    keysSeen.push(keyLabel(key));
    if (keysSeen.length > 10) keysSeen.shift();
    $('#diag-keys').textContent = keysSeen.join('  >  ');
  });

  $$('.diag-kb').forEach((b) => b.addEventListener('click', async () => {
    const [r, g, v] = b.dataset.rgb.split(',').map(Number);
    const res = await window.satella.devices.testKeyboard(r, g, v);
    $('#diag-result').textContent = res.ok
      ? `Clavier : ${b.textContent.toLowerCase()} statique envoyé.`
      : `Clavier : échec (${res.error})`;
  }));
})();

/* ================= Profils ================= */
let pendingProfiles = null; // liste reçue pendant qu'on éditait la page

function setActiveProfile(name) {
  ACTIVE_PROFILE = name || null;
  updateBadge();
}

async function renderProfiles(payload) {
  const { profiles, active } = payload || await window.satella.profiles.list();
  pendingProfiles = null;
  setActiveProfile(active);
  const p = $('#profile-list');
  p.innerHTML = profiles.map((pr) => `
    <div class="profile-row ${pr.name === active ? 'active' : ''}" data-name="${esc(pr.name)}">
      <div class="p-main">
        <span class="p-name">${esc(pr.name)}
          ${pr.name === active ? '<span class="tag tag-target">Actif</span>' : ''}
          ${pr.isDefault ? '<span class="tag tag-kb">Par défaut</span>' : ''}
          ${pr.schedule ? `<span class="tag tag-mouse" title="Profil programmé">${esc(pr.schedule.from)} – ${esc(pr.schedule.to)}</span>` : ''}</span>
        <span class="p-date" title="Dernière modification">${esc(fmtDate(pr.savedAt))}</span>
        <button class="btn small p-load">Charger</button>
        <button class="btn small p-default">${pr.isDefault ? 'Retirer le défaut' : 'Par défaut'}</button>
        <button class="btn small p-rename">Renommer</button>
        <button class="btn small p-export">Exporter</button>
        <button class="btn small danger p-del">Supprimer</button>
      </div>
      <div class="p-apps">
        <input type="text" class="p-apps-input" placeholder="Applications liées : jeu.exe, autre.exe"
          value="${esc((pr.apps || []).join(', '))}">
        <button class="btn small p-apps-save">Lier</button>
      </div>
      <div class="p-sched">
        <label class="check"><input type="checkbox" class="p-sched-on" ${pr.schedule ? 'checked' : ''}> Actif chaque jour de</label>
        <input type="time" class="p-sched-from" value="${esc(pr.schedule ? pr.schedule.from : '09:00')}">
        <label class="muted">à</label>
        <input type="time" class="p-sched-to" value="${esc(pr.schedule ? pr.schedule.to : '18:00')}">
        <span class="muted p-sched-hint">(une application liée reste prioritaire)</span>
      </div>
    </div>`).join('') || '<p class="muted">Aucun profil sauvegardé.</p>';

  const rowName = (e) => e.target.closest('.profile-row').dataset.name;
  $$('.p-default').forEach((b) => b.addEventListener('click', async (e) => {
    const name = rowName(e);
    const pr = profiles.find((x) => x.name === name);
    renderProfiles(await window.satella.profiles.setMeta(name, { isDefault: !(pr && pr.isDefault) }));
  }));
  $$('.p-apps-save').forEach((b) => b.addEventListener('click', async (e) => {
    const row = e.target.closest('.profile-row');
    const apps = row.querySelector('.p-apps-input').value.split(',');
    renderProfiles(await window.satella.profiles.setMeta(row.dataset.name, { apps }));
    toast('Applications liées au profil.');
  }));
  // Profil programmé : plage horaire enregistrée à chaque modification
  $$('.p-sched').forEach((box) => {
    const save = async () => {
      const row = box.closest('.profile-row');
      const on = box.querySelector('.p-sched-on').checked;
      const from = box.querySelector('.p-sched-from').value;
      const to = box.querySelector('.p-sched-to').value;
      if (on && (!from || !to || from === to)) return toast('Choisis une heure de début et une heure de fin différentes.');
      renderProfiles(await window.satella.profiles.setMeta(row.dataset.name, { schedule: on ? { from, to } : null }));
      toast(on ? `Profil programmé de ${from} à ${to}.` : 'Horaire retiré.');
    };
    box.querySelector('.p-sched-on').addEventListener('change', save);
    for (const sel of ['.p-sched-from', '.p-sched-to']) {
      box.querySelector(sel).addEventListener('change', () => { if (box.querySelector('.p-sched-on').checked) save(); });
    }
  });
  $$('.p-load').forEach((b) => b.addEventListener('click', (e) => loadProfile(rowName(e))));
  $$('.p-rename').forEach((b) => b.addEventListener('click', async (e) => {
    const name = rowName(e);
    const next = await askText({ title: 'Renommer le profil', label: 'Nouveau nom', value: name, ok: 'Renommer' });
    if (!next || next === name) return;
    const res = await window.satella.profiles.rename(name, next);
    if (!res.ok) toast('Renommage impossible : ' + res.error, 4000);
    renderProfiles(res);
  }));
  $$('.p-export').forEach((b) => b.addEventListener('click', async (e) => {
    const res = await window.satella.data.exportProfile(rowName(e));
    if (res.ok) toast('Profil exporté : ' + res.file, 4000);
    else if (!res.canceled) toast('Export impossible : ' + res.error, 4000);
  }));
  $$('.p-del').forEach((b) => b.addEventListener('click', async (e) => {
    const name = rowName(e);
    if (!confirm(`Supprimer le profil « ${name} » ?`)) return;
    renderProfiles(await window.satella.profiles.remove(name));
  }));
}

async function loadProfile(name) {
  const res = await window.satella.profiles.load(name);
  if (!res) return;
  STATE = res.ledState;
  resetKbHistory();
  replaceMacros(res.macros, `Profil « ${name} » chargé`);
  syncToolbars();
  renderProfiles(res);
  toast(`Profil « ${name} » chargé.`);
}

// Mise à jour venue du processus principal : différée si l'utilisateur
// est en train de saisir sur la page Profils
function onProfilesChanged(payload) {
  setActiveProfile(payload.active);
  const editing = currentPage === 'profiles' && document.activeElement
    && document.activeElement.closest && document.activeElement.closest('#profile-list');
  if (currentPage === 'profiles' && !editing) renderProfiles(payload);
  else pendingProfiles = payload;
}

$('#profile-save').addEventListener('click', async () => {
  const name = $('#profile-name').value.trim();
  if (!name) return toast('Donne un nom au profil.');
  renderProfiles(await window.satella.profiles.save(name));
  $('#profile-name').value = '';
  toast(`Profil « ${name} » sauvegardé et actif.`);
});
$('#profile-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#profile-save').click();
});

$('#data-export-all').addEventListener('click', async () => {
  const res = await window.satella.data.exportAll();
  if (res.ok) toast('Sauvegarde enregistrée : ' + res.file, 4000);
  else if (!res.canceled) toast('Sauvegarde impossible : ' + res.error, 4000);
});
$('#data-import').addEventListener('click', async () => {
  onImported(await window.satella.data.import());
});

// Résultat d'un import (fichier choisi ou sauvegarde automatique)
function onImported(res) {
  if (!res.ok) {
    if (!res.canceled) toast('Import impossible : ' + res.error, 5000);
    return;
  }
  if (res.kind === 'profile') {
    toast(`Profil « ${res.name} » importé.`);
  } else {
    STATE = res.ledState;
    resetKbHistory();
    replaceMacros(res.macros, null);
    SNIPPETS = res.snippets;
    TURBOS = res.turbos;
    syncToolbars();
    renderSnippets();
    renderTurbos();
    toast('Sauvegarde restaurée.');
  }
  renderProfiles(res);
}

/* ================= Expansion de texte ================= */
let SNIPPETS = [];

function saveSnippets() {
  window.satella.snippets.set(SNIPPETS);
}

function renderSnippets() {
  const cont = $('#snippet-list');
  cont.innerHTML = '';
  if (!SNIPPETS.length) {
    cont.innerHTML = '<p class="muted">Aucune abréviation pour l\'instant.</p>';
    return;
  }
  SNIPPETS.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'snippet-row';
    row.innerHTML = `
      <input type="text" class="sn-abbr" maxlength="32" placeholder=";abrev" value="${esc(s.abbr || '')}">
      <textarea class="sn-text" rows="1" placeholder="Texte de remplacement">${esc(s.text || '')}</textarea>
      <label class="switch"><input type="checkbox" class="sn-on" ${s.enabled ? 'checked' : ''}><span></span></label>
      <button class="icon-btn sn-del" title="Supprimer">${svg('close')}</button>`;
    row.querySelector('.sn-abbr').addEventListener('change', (e) => {
      const abbr = e.target.value.trim();
      const dup = SNIPPETS.find((x, j) => j !== i && x.abbr && x.abbr.toLowerCase() === abbr.toLowerCase());
      if (dup) toast(`L'abréviation « ${abbr} » existe déjà.`, 3500);
      if (abbr && [...abbr].length < 2) toast('Une abréviation doit faire au moins 2 caractères.', 3500);
      SNIPPETS[i].abbr = abbr;
      saveSnippets();
    });
    row.querySelector('.sn-text').addEventListener('change', (e) => {
      SNIPPETS[i].text = e.target.value;
      saveSnippets();
    });
    row.querySelector('.sn-on').addEventListener('change', (e) => {
      SNIPPETS[i].enabled = e.target.checked;
      saveSnippets();
    });
    row.querySelector('.sn-del').addEventListener('click', () => {
      SNIPPETS.splice(i, 1);
      saveSnippets();
      renderSnippets();
    });
    cont.appendChild(row);
  });
}

$('#snippet-add').addEventListener('click', () => {
  SNIPPETS.push({ id: uid(), abbr: '', text: '', enabled: true });
  renderSnippets();
  const inputs = $$('#snippet-list .sn-abbr');
  if (inputs.length) inputs[inputs.length - 1].focus();
});

/* ================= Mode turbo ================= */
let TURBOS = [];
const TURBO_TARGETS = [
  ['mouse:left', 'Clic gauche'],
  ['mouse:right', 'Clic droit'],
  ['mouse:middle', 'Clic molette'],
  ['key', 'Touche...'],
];

function saveTurbos() {
  window.satella.turbos.set(clone(TURBOS));
}

function turboTargetValue(t) {
  return t.target && t.target.type === 'key' ? 'key' : 'mouse:' + ((t.target && t.target.button) || 'left');
}

function renderTurbos() {
  const cont = $('#turbo-list');
  cont.innerHTML = '';
  if (!TURBOS.length) {
    cont.innerHTML = '<p class="muted">Aucun turbo pour l\'instant.</p>';
    return;
  }
  TURBOS.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'turbo-row';
    row.dataset.id = t.id;
    const err = shortcutError('turbo', t.id);
    const targetOpts = TURBO_TARGETS.map(([v, l]) =>
      `<option value="${v}" ${turboTargetValue(t) === v ? 'selected' : ''}>${l}</option>`).join('');
    const keyOpts = KEY_NAMES.map((k) =>
      `<option value="${esc(k)}" ${t.target && t.target.key === k ? 'selected' : ''}>${esc(keyLabel(k))}</option>`).join('');
    row.innerHTML = `
      <span class="turbo-dot" title="Actif quand allumé"></span>
      <select class="tb-target">${targetOpts}</select>
      <select class="tb-key" style="display:${turboTargetValue(t) === 'key' ? '' : 'none'}">${keyOpts}</select>
      <label class="muted" style="font-size:12px">Cadence</label>
      <input type="range" class="tb-cps" min="1" max="50" value="${+t.cps || 10}" style="width:110px">
      <span class="muted tb-cps-val" style="font-family:var(--font-mono);font-size:12px">${+t.cps || 10}/s</span>
      <input type="text" readonly class="trigger-input tb-accel" style="min-width:130px"
        value="${esc(t.accelerator || '')}" placeholder="Raccourci...">
      <label class="switch"><input type="checkbox" class="tb-on" ${t.enabled ? 'checked' : ''}><span></span></label>
      <button class="icon-btn tb-del" title="Supprimer">${svg('close')}</button>
      ${err ? `<span class="warn-text" style="flex-basis:100%">${svg('warn')} Raccourci inactif : ${esc(err.reason)}.</span>` : ''}`;

    row.querySelector('.tb-target').addEventListener('change', (e) => {
      const v = e.target.value;
      TURBOS[i].target = v === 'key'
        ? { type: 'key', key: (TURBOS[i].target && TURBOS[i].target.key) || 'space' }
        : { type: 'mouse', button: v.split(':')[1] };
      saveTurbos();
      renderTurbos();
    });
    row.querySelector('.tb-key').addEventListener('change', (e) => {
      TURBOS[i].target = { type: 'key', key: e.target.value };
      saveTurbos();
    });
    row.querySelector('.tb-cps').addEventListener('input', (e) => {
      row.querySelector('.tb-cps-val').textContent = e.target.value + '/s';
    });
    row.querySelector('.tb-cps').addEventListener('change', (e) => {
      TURBOS[i].cps = +e.target.value;
      saveTurbos();
    });
    captureAccelerator(
      row.querySelector('.tb-accel'),
      () => TURBOS[i].accelerator,
      (accel) => { TURBOS[i].accelerator = accel; saveTurbos(); },
      t
    );
    row.querySelector('.tb-on').addEventListener('change', (e) => {
      TURBOS[i].enabled = e.target.checked;
      saveTurbos();
    });
    row.querySelector('.tb-del').addEventListener('click', () => {
      TURBOS.splice(i, 1);
      saveTurbos();
      renderTurbos();
    });
    cont.appendChild(row);
  });
}

$('#turbo-add').addEventListener('click', () => {
  TURBOS.push({
    id: uid(), target: { type: 'mouse', button: 'left' },
    cps: 10, accelerator: '', enabled: true,
  });
  saveTurbos();
  renderTurbos();
});

/* ================= Optimiseur mémoire ================= */
const GO = 1073741824;
let memTimer = null;

function renderMemory(st) {
  if (!st) return;
  $('#mem-used').textContent = (st.usedPhys / GO).toFixed(1);
  $('#mem-total').textContent = (st.totalPhys / GO).toFixed(1);
  $('#mem-free').textContent = (st.availPhys / GO).toFixed(1);
  const fill = $('#mem-fill');
  fill.style.width = st.load + '%';
  fill.className = 'mem-fill' + (st.load >= 85 ? ' high' : st.load >= 70 ? ' warn' : '');
}

async function refreshMemory() {
  renderMemory(await window.satella.memory.status());
}

$('#mem-optimize').addEventListener('click', async () => {
  const btn = $('#mem-optimize');
  btn.disabled = true;
  $('#mem-result').textContent = 'Libération en cours...';
  const res = await window.satella.memory.optimize();
  btn.disabled = false;
  if (!res.ok) {
    $('#mem-result').textContent = 'Impossible : ' + (res.error || 'erreur inconnue');
    return;
  }
  renderMemory(res.after);
  const mo = Math.round(res.freed / 1048576);
  $('#mem-result').textContent = mo > 0
    ? `${(res.freed / GO).toFixed(2)} Go libérés · ${res.processes} processus`
    + (res.systemPurged ? ' · cache système purgé' : ' · cache système non purgé (admin requis)')
    : `Rien à libérer pour l'instant · ${res.processes} processus traités`;
});

$('#mem-auto').addEventListener('change', (e) => {
  window.satella.settings.set({ autoOptimize: e.target.checked });
});
$('#mem-threshold').addEventListener('input', (e) => {
  $('#mem-threshold-val').textContent = e.target.value + '%';
});
$('#mem-threshold').addEventListener('change', (e) => {
  window.satella.settings.set({ autoOptimizeThreshold: +e.target.value });
});

/* ================= Paramètres ================= */
function renderSettings(s) {
  SETTINGS = s;
  $('#set-leds').checked = s.ledsEnabled;
  $('#set-macros').checked = s.macrosEnabled;
  $('#set-startup').checked = s.launchAtStartup;
  $('#set-startmin').checked = s.startMinimized;
  $('#row-start-min').style.opacity = s.launchAtStartup ? '1' : '.45';
  $('#set-startmin').disabled = !s.launchAtStartup;
  $('#set-appprofiles').checked = s.appProfiles;
  $('#set-idleoff').checked = s.idleOff;
  $('#set-idle-min').value = s.idleMinutes;
  $('#set-idle-val').textContent = s.idleMinutes + ' min';
  $('#set-offlock').checked = !!s.offOnLock;
  $('#set-flash').checked = !!s.flashOnMacro;
  $('#set-locks').checked = !!s.lockIndicators;
  $('#set-lock-color').value = s.lockColor || '#ffffff';
  $('#set-autobackup').checked = s.autoBackup !== false;
  $('#set-keystats').checked = !!s.keyStats;
  $('#set-night').checked = !!s.nightMode;
  $('#set-night-from').value = s.nightFrom || '23:00';
  $('#set-night-to').value = s.nightTo || '07:00';
  $('#set-night-action').value = s.nightAction === 'dim' ? 'dim' : 'off';
  $('#set-night-level').value = s.nightLevel || 30;
  $('#set-night-level-val').textContent = (s.nightLevel || 30) + '%';
  $('#set-night-level').disabled = s.nightAction !== 'dim';
  $('#set-autoupdate').checked = s.autoCheckUpdates;
  $('#set-autoinstall').checked = !!s.autoInstallUpdates;
  $('#set-autoinstall').disabled = !s.autoCheckUpdates;
  $('#row-autoinstall').style.opacity = s.autoCheckUpdates ? '1' : '.45';
  $('#mem-auto').checked = s.autoOptimize;
  $('#mem-threshold').value = s.autoOptimizeThreshold;
  $('#mem-threshold-val').textContent = s.autoOptimizeThreshold + '%';
  // Pages sans objet quand le module est coupé
  $$('.nav-btn').forEach((b) => {
    const p = b.dataset.page;
    if (p === 'keyboard' || p === 'mouse') b.style.display = s.ledsEnabled ? '' : 'none';
    if (p === 'macros') b.style.display = s.macrosEnabled ? '' : 'none';
  });
  const active = $('.nav-btn.active');
  if (active && active.style.display === 'none') showPage('home');
  if (!TIMER.running && document.activeElement !== $('#timer-minutes')) $('#timer-minutes').value = s.timerMinutes || 25;
  renderAppShortcuts();
}

// Interrupteurs simples : réglage booléen <-> case à cocher
const SETTING_SWITCHES = {
  '#set-startmin': 'startMinimized',
  '#set-appprofiles': 'appProfiles',
  '#set-idleoff': 'idleOff',
  '#set-offlock': 'offOnLock',
  '#set-flash': 'flashOnMacro',
  '#set-autoupdate': 'autoCheckUpdates',
  '#set-autoinstall': 'autoInstallUpdates',
  '#set-keystats': 'keyStats',
  '#set-night': 'nightMode',
  '#set-locks': 'lockIndicators',
  '#set-autobackup': 'autoBackup',
};
for (const [sel, key] of Object.entries(SETTING_SWITCHES)) {
  $(sel).addEventListener('change', async (e) => {
    renderSettings(await window.satella.settings.set({ [key]: e.target.checked }));
  });
}

$('#set-startup').addEventListener('change', async (e) => {
  renderSettings(await window.satella.settings.set({ launchAtStartup: e.target.checked }));
  toast(e.target.checked
    ? 'Satella se lancera au démarrage de Windows.'
    : 'Lancement au démarrage désactivé.');
});
$('#set-idle-min').addEventListener('input', (e) => {
  $('#set-idle-val').textContent = e.target.value + ' min';
});
$('#set-idle-min').addEventListener('change', (e) => {
  window.satella.settings.set({ idleMinutes: +e.target.value });
});

$('#set-leds').addEventListener('change', async (e) => {
  renderSettings(await window.satella.settings.set({ ledsEnabled: e.target.checked }));
  toast(e.target.checked ? 'Gestion des LED activée.' : 'Gestion des LED désactivée.');
});
$('#set-macros').addEventListener('change', async (e) => {
  renderSettings(await window.satella.settings.set({ macrosEnabled: e.target.checked }));
  toast(e.target.checked ? 'Macros activées.' : 'Macros désactivées.');
});

// Dépannage
$('#diag-copy').addEventListener('click', async () => {
  await window.satella.diagnostic();
  toast('Rapport de diagnostic copié dans le presse-papiers.');
});
$('#diag-logs').addEventListener('click', () => window.satella.openLogs());
$('#diag-data').addEventListener('click', () => window.satella.openData());

// L'entrée de démarrage peut être retirée depuis le gestionnaire des tâches
// de Windows : on reflète l'état réel plutôt que le réglage enregistré.
async function syncStartupState() {
  const real = await window.satella.settings.startupState();
  if (real !== SETTINGS.launchAtStartup) {
    renderSettings(await window.satella.settings.set({ launchAtStartup: real }));
  }
}

// Mode nuit : plage horaire, action et niveau d'atténuation
for (const [sel, key] of [['#set-night-from', 'nightFrom'], ['#set-night-to', 'nightTo'], ['#set-night-action', 'nightAction']]) {
  $(sel).addEventListener('change', async (e) => {
    if (!e.target.value) return;
    renderSettings(await window.satella.settings.set({ [key]: e.target.value }));
  });
}
$('#set-night-level').addEventListener('input', (e) => {
  $('#set-night-level-val').textContent = e.target.value + '%';
});
$('#set-night-level').addEventListener('change', (e) => {
  window.satella.settings.set({ nightLevel: +e.target.value });
});

// Statistiques de frappe : total, touches les plus utilisées, remise à zéro
async function refreshStatsInfo() {
  const st = await window.satella.stats.get();
  const info = $('#set-stats-info');
  if (!st || !st.total) {
    info.textContent = 'Aucune frappe comptée pour l\'instant.';
    return;
  }
  const top = Object.entries(st.counts).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, n]) => `${keyLabel(k)} (${n.toLocaleString('fr-FR')})`).join(', ');
  const since = st.since ? ` depuis le ${new Date(st.since).toLocaleDateString('fr-FR')}` : '';
  info.textContent = `${st.total.toLocaleString('fr-FR')} frappes comptées${since}. Les plus utilisées : ${top}.`;
}
$('#set-stats-reset').addEventListener('click', async () => {
  if (!confirm('Remettre à zéro les statistiques de frappe ?')) return;
  await window.satella.stats.reset();
  refreshStatsInfo();
  toast('Statistiques remises à zéro.');
});

// Témoins Verr. Maj / Verr. Num : couleur
$('#set-lock-color').addEventListener('change', async (e) => {
  renderSettings(await window.satella.settings.set({ lockColor: e.target.value }));
});

/* ---- Raccourcis de l'application ---- */
const APP_SHORTCUTS = [
  ['leds', 'Éteindre / rallumer les LED'],
  ['nextProfile', 'Profil suivant'],
  ['brightUp', 'Luminosité +'],
  ['brightDown', 'Luminosité −'],
  ['stopAll', 'Arrêter toutes les macros et turbos'],
  ['timer', 'Démarrer / arrêter le minuteur'],
];

function renderAppShortcuts() {
  const box = $('#app-shortcuts');
  const focused = document.activeElement;
  if (!box || (focused && focused.classList.contains('capturing') && box.contains(focused))) return; // capture en cours
  const sc = SETTINGS.appShortcuts || {};
  box.innerHTML = APP_SHORTCUTS.map(([id, label]) => {
    const err = shortcutError('app', id);
    return `<div class="app-sc-row" data-id="${id}">
      <span class="sc-name">${esc(label)}</span>
      <input type="text" readonly class="trigger-input" value="${esc(sc[id] || '')}" placeholder="Aucun">
      <button class="btn small sc-clear" ${sc[id] ? '' : 'disabled'}>Effacer</button>
      ${err ? `<span class="warn-text" style="flex-basis:100%">${svg('warn')} Raccourci inactif : ${esc(err.reason)}.</span>` : ''}
    </div>`;
  }).join('');
  box.querySelectorAll('.app-sc-row').forEach((row) => {
    const id = row.dataset.id;
    captureAccelerator(row.querySelector('.trigger-input'), () => (SETTINGS.appShortcuts || {})[id],
      (accel) => saveAppShortcut(id, accel), id);
    row.querySelector('.sc-clear').addEventListener('click', () => saveAppShortcut(id, ''));
  });
}

async function saveAppShortcut(id, accel) {
  const next = { ...(SETTINGS.appShortcuts || {}), [id]: accel };
  renderSettings(await window.satella.settings.set({ appShortcuts: next }));
}

/* ---- Sauvegardes automatiques ---- */
function fmtBackupDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
}

async function refreshBackups() {
  const list = await window.satella.backups.list();
  const box = $('#backup-list');
  if (!list.length) {
    box.innerHTML = '<span class="muted" style="font-size:12.5px">Aucune sauvegarde pour l\'instant.</span>';
    return;
  }
  box.innerHTML = list.map((b) => `<div class="backup-item" data-name="${esc(b.name)}">
      <span class="b-date">${esc(fmtBackupDate(b.date))}</span>
      <span class="muted">${Math.max(1, Math.round(b.size / 1024))} Ko</span>
      <button class="btn small b-restore">Restaurer</button>
    </div>`).join('');
  box.querySelectorAll('.b-restore').forEach((btn) => {
    btn.addEventListener('click', async () => {
      onImported(await window.satella.backups.restore(btn.closest('.backup-item').dataset.name));
    });
  });
}

$('#backup-now').addEventListener('click', async () => {
  const res = await window.satella.backups.now();
  await refreshBackups();
  toast(res.ok ? 'Sauvegarde créée.' : 'Sauvegarde impossible (voir le journal).');
});
$('#backup-folder').addEventListener('click', () => window.satella.backups.openFolder());

/* ---- Minuteur (Accueil) ---- */
let TIMER = { running: false, done: false };
let timerTicker = null;

function fmtDuration(ms) {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return h ? `${h}:${mmss}` : mmss;
}

function renderTimer() {
  const left = $('#timer-left');
  left.classList.toggle('running', !!TIMER.running);
  left.classList.toggle('done', !!TIMER.done);
  $('#timer-stop').hidden = !TIMER.running && !TIMER.done;
  if (TIMER.running) left.textContent = fmtDuration(Math.max(0, TIMER.ms - (Date.now() - TIMER.t0)));
  else left.textContent = TIMER.done ? 'Terminé' : '--:--';
  clearInterval(timerTicker);
  timerTicker = TIMER.running ? setInterval(renderTimer, 500) : null;
}

function onTimerState(st) {
  TIMER = st || { running: false, done: false };
  renderTimer();
}

async function startTimer(minutes) {
  const m = Math.round(Number(minutes));
  if (!(m >= 1 && m <= 180)) return toast('Durée entre 1 et 180 minutes.');
  $('#timer-minutes').value = m;
  onTimerState(await window.satella.timer.start(m));
  toast(`Minuteur de ${m} min lancé.`);
}

$$('[data-timer]').forEach((b) => b.addEventListener('click', () => startTimer(+b.dataset.timer)));
$('#timer-start').addEventListener('click', () => startTimer($('#timer-minutes').value));
$('#timer-stop').addEventListener('click', async () => onTimerState(await window.satella.timer.stop()));

async function refreshFootprint() {
  const st = await window.satella.memory.status();
  if (!st) return;
  $('#set-footprint').textContent =
    `Mémoire vive du système : ${(st.usedPhys / GO).toFixed(1)} Go utilisés sur `
    + `${(st.totalPhys / GO).toFixed(1)} Go (${st.load}%). `
    + `Modules actifs : ${[SETTINGS.ledsEnabled && 'LED', SETTINGS.macrosEnabled && 'macros']
      .filter(Boolean).join(', ') || 'aucun'}.`;
}

/* ================= Palette de commandes (Ctrl+K) ================= */
const fold = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
let paletteAll = [];
let paletteItems = [];
let paletteSel = 0;

async function paletteCommands() {
  const items = [];
  const add = (group, label, run, hint = '') => items.push({ group, label, run, hint, text: fold(`${group} ${label} ${hint}`) });
  $$('.nav-btn').filter((b) => b.style.display !== 'none')
    .forEach((b) => add('Page', `Aller à : ${b.textContent.trim()}`, () => showPage(b.dataset.page)));
  if (SETTINGS.macrosEnabled) {
    MACROS.forEach((m) => add('Macro', `Lancer « ${m.name} »`, () => playMacro(m), (m.trigger && m.trigger.accelerator) || ''));
    add('Macro', 'Nouvelle macro', () => { showPage('macros'); $('#macro-new').click(); });
  }
  const { profiles } = await window.satella.profiles.list();
  profiles.forEach((p) => add('Profil', `Charger « ${p.name} »`, () => loadProfile(p.name)));
  if (SETTINGS.ledsEnabled) {
    EFFECTS.forEach(([fx, label]) => add('Effet clavier', label, () => {
      showPage('keyboard');
      const btn = $(`#kb-effects button[data-fx="${fx}"]`);
      if (btn) btn.click();
    }));
    add('Action', DIMMED ? 'Rallumer les LED' : 'Éteindre les LED', () => $('#leds-toggle').click());
    add('Action', 'Luminosité +', () => window.satella.runAction('brightUp'));
    add('Action', 'Luminosité −', () => window.satella.runAction('brightDown'));
  }
  add('Action', 'Profil suivant', () => window.satella.runAction('nextProfile'));
  add('Action', 'Arrêter toutes les macros et turbos', () => window.satella.runAction('stopAll'));
  [5, 15, 25, 45, 60].forEach((m) => add('Minuteur', `Minuteur ${m} min`, () => startTimer(m)));
  if (TIMER.running || TIMER.done) add('Minuteur', 'Arrêter le minuteur', async () => onTimerState(await window.satella.timer.stop()));
  add('Action', 'Sauvegarder maintenant', async () => {
    const res = await window.satella.backups.now();
    toast(res.ok ? 'Sauvegarde créée.' : 'Sauvegarde impossible (voir le journal).');
  });
  add('Action', 'Vérifier les mises à jour', () => { showPage('home'); $('#update-check').click(); });
  add('Action', 'Copier le diagnostic', () => $('#diag-copy').click());
  return items;
}

function renderPalette() {
  const q = fold($('#palette-input').value).split(/\s+/).filter(Boolean);
  paletteItems = paletteAll.filter((it) => q.every((w) => it.text.includes(w))).slice(0, 60);
  paletteSel = Math.min(paletteSel, Math.max(0, paletteItems.length - 1));
  const list = $('#palette-list');
  list.innerHTML = paletteItems.map((it, i) => `
    <div class="pal-item${i === paletteSel ? ' sel' : ''}" data-i="${i}" role="option" aria-selected="${i === paletteSel}">
      <span class="pal-group">${esc(it.group)}</span>
      <span class="pal-label">${esc(it.label)}</span>
      ${it.hint ? `<kbd>${esc(it.hint)}</kbd>` : ''}
    </div>`).join('') || '<p class="muted pal-empty">Aucun résultat.</p>';
  const sel = list.querySelector('.pal-item.sel');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

async function openPalette() {
  if (!$('#modal-backdrop').hidden || !$('#palette-backdrop').hidden) return;
  paletteAll = await paletteCommands();
  paletteSel = 0;
  $('#palette-input').value = '';
  $('#palette-backdrop').hidden = false;
  renderPalette();
  $('#palette-input').focus();
}

function closePalette() {
  $('#palette-backdrop').hidden = true;
}

function runPaletteItem(i) {
  const it = paletteItems[i];
  if (!it) return;
  closePalette();
  Promise.resolve().then(it.run).catch((err) => toast('Commande impossible : ' + err.message, 4000));
}

$('#palette-open').addEventListener('click', openPalette);
$('#palette-input').addEventListener('input', () => { paletteSel = 0; renderPalette(); });
$('#palette-input').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = paletteItems.length;
    if (n) paletteSel = (paletteSel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    renderPalette();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    runPaletteItem(paletteSel);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closePalette();
  }
});
$('#palette-list').addEventListener('click', (e) => {
  const item = e.target.closest('.pal-item');
  if (item) runPaletteItem(+item.dataset.i);
});
$('#palette-list').addEventListener('mousemove', (e) => {
  const item = e.target.closest('.pal-item');
  if (!item || +item.dataset.i === paletteSel) return;
  paletteSel = +item.dataset.i;
  $$('#palette-list .pal-item').forEach((el, i) => el.classList.toggle('sel', i === paletteSel));
});
$('#palette-backdrop').addEventListener('mousedown', (e) => { if (e.target.id === 'palette-backdrop') closePalette(); });
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if ($('#palette-backdrop').hidden) openPalette();
    else closePalette();
  }
});

/* ================= Import par glisser-déposer ================= */
// Seuls les fichiers venus de l'extérieur sont concernés (le réordonnancement
// des étapes de macro utilise aussi le glisser-déposer)
const isFileDrag = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (!isFileDrag(e)) return;
  dragDepth++;
  $('#drop-overlay').hidden = false;
});
document.addEventListener('dragleave', (e) => {
  if (!isFileDrag(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('#drop-overlay').hidden = true;
});
document.addEventListener('dragover', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('drop', async (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').hidden = true;
  const file = e.dataTransfer.files[0];
  if (!file) return;
  if (!/\.(satella|json)$/i.test(file.name)) return toast('Seuls les fichiers .satella peuvent être importés.');
  onImported(await window.satella.data.importFile(file));
});

/* ================= Initialisation ================= */
async function init() {
  const data = await window.satella.init();
  LAYOUT = data.layout;
  STATE = data.ledState;
  MACROS = data.macros;
  markSaved(MACROS);
  KEY_NAMES = data.keyNames;
  KEY_LABELS = data.keyLabels;
  CAPS = data.capabilities;
  SHORTCUT_ERRORS = data.shortcutErrors || [];
  ACTIVE_PROFILE = data.active || null;
  DIMMED = !!data.dimmed;
  LOCKS_AVAILABLE = data.locksAvailable !== false;
  $('#set-locks-warn').hidden = LOCKS_AVAILABLE;
  onTimerState(data.timer);
  $('#app-version').textContent = data.version || '?';
  renderSettings(data.settings || SETTINGS);
  SNIPPETS = data.snippets || [];
  TURBOS = data.turbos || [];
  renderSnippets();
  renderTurbos();
  if (!data.memoryAvailable) {
    $('#mem-panel').innerHTML = '<p class="muted">Optimiseur indisponible sur ce système.</p>';
  }

  buildKeyboard();
  buildMouse();
  buildToolbars();
  buildHomePreviews();
  renderRecentColors();
  syncToolbars();
  renderMacroList();
  renderMacroEditor();
  renderDirectPanel(data.direct);
  renderHidList(data.hid);
  renderProfiles({ profiles: data.profiles || [], active: data.active });

  window.satella.led.onFrame(applyFrame);
  window.satella.led.onDimmed(({ dimmed }) => {
    DIMMED = dimmed;
    updateBadge();
  });
  // Luminosité changée par un raccourci de l'application
  window.satella.led.onState((state) => {
    STATE = state;
    syncToolbars();
  });
  window.satella.timer.onState(onTimerState);
  window.satella.devices.onDirectStatus(renderDirectPanel);
  window.satella.macros.onRecordEvent((step) => {
    if (!recording) return;
    recordedSteps.push(step);
    const counter = $('#rec-count');
    if (counter) counter.textContent = recordedSteps.length;
  });
  window.satella.macros.onPlayState(({ id, playing }) => {
    const el = document.querySelector(`.macro-item[data-id="${CSS.escape(id)}"]`);
    if (el) el.classList.toggle('playing', playing);
  });
  window.satella.macros.onPlayError(({ message }) => toast('Erreur macro : ' + message, 4000));
  window.satella.shortcuts.onErrors((errors) => {
    SHORTCUT_ERRORS = errors || [];
    renderMacroList();
    renderTurbos();
    renderAppShortcuts();
    if (currentMacro()) {
      const err = shortcutError('macro', currentMacroId);
      const holder = $('#me-trigger');
      if (holder) {
        const row = holder.parentElement;
        const old = row.querySelector('.warn-text');
        if (old) old.remove();
        if (err) {
          const span = document.createElement('span');
          span.className = 'warn-text';
          span.style.flexBasis = '100%';
          span.innerHTML = `${svg('warn')} Raccourci inactif : ${esc(err.reason)}.`;
          row.insertBefore(span, row.querySelector('.muted'));
        }
      }
    }
  });
  window.satella.settings.onChanged(renderSettings);
  window.satella.turbos.onState(({ id, running }) => {
    const row = document.querySelector(`.turbo-row[data-id="${CSS.escape(id)}"]`);
    if (row) row.querySelector('.turbo-dot').classList.toggle('on', running);
    if (running) toast('Turbo activé. Le même raccourci l\'arrête.');
  });
  window.satella.profiles.onChanged(onProfilesChanged);
  window.satella.profiles.onAutoApplied((res) => {
    STATE = res.ledState;
    resetKbHistory();
    replaceMacros(res.macros, `Profil « ${res.name} » appliqué`);
    syncToolbars();
    onProfilesChanged(res);
    if (res.manual) toast(`Profil « ${res.name} » chargé.`);
    else if (res.exe) toast(`Profil « ${res.name} » appliqué pour ${res.exe}.`);
    else if (res.schedule) toast(`Profil « ${res.name} » appliqué (horaire ${res.schedule.from} – ${res.schedule.to}).`);
    else toast(`Profil par défaut « ${res.name} » appliqué.`);
  });
  window.satella.memory.onAuto((res) => {
    if (res && res.ok && res.freed > 0) {
      toast(`Nettoyage automatique : ${(res.freed / GO).toFixed(2)} Go libérés.`);
      if ($('#page-optimizer').classList.contains('active')) renderMemory(res.after);
    }
  });

  window.satella.setPage(currentPage);
  window.satella.ready();

  // Première ouverture après une mise à jour : les nouveautés, une fois
  if (data.whatsNew) {
    setTimeout(() => showNotesModal(`Satella ${data.whatsNew.version} : quoi de neuf ?`, data.whatsNew.notes), 600);
  }
}

init();
