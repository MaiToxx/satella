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

const kbSelection = new Set();
let mouseSelection = null;
let currentMacroId = null;
let recording = false;
let recordedSteps = [];
let lastFrame = null;

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

function rgbCss(rgb) { return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`; }
function uid() { return 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

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

/* ================= Navigation ================= */
function showPage(name) {
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + name));
  accentDevice = name === 'mouse' ? 'mouse' : 'keyboard';
  setAccent();
  // La mémoire n'est interrogée que sur les pages qui l'affichent
  clearInterval(memTimer);
  memTimer = null;
  if (name === 'optimizer') {
    refreshMemory();
    memTimer = setInterval(refreshMemory, 2000);
  } else if (name === 'settings') {
    refreshFootprint();
    syncStartupState();
  }
}
$$('.nav-btn').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.page)));
$('#card-keyboard').addEventListener('click', () => showPage('keyboard'));
$('#card-mouse').addEventListener('click', () => showPage('mouse'));

/* ================= Mises à jour automatiques ================= */
$('#update-check').addEventListener('click', async () => {
  const out = $('#update-result');
  out.textContent = 'Vérification en cours...';
  const res = await window.satella.checkUpdate();
  if (!res.ok) {
    out.textContent = 'Vérification impossible : ' + res.error;
    return;
  }
  if (res.newer) {
    out.textContent = `Nouvelle version ${res.latest} : téléchargement...`;
    const dl = await window.satella.downloadUpdate();
    if (!dl.ok) out.textContent = 'Téléchargement impossible : ' + dl.error;
  } else {
    out.textContent = `Tu as la dernière version (${res.current}).`;
  }
});
window.satella.onUpdateAvailable(({ latest }) => {
  toast(`Nouvelle version ${latest} disponible.`, 5000);
  const out = $('#update-result');
  out.innerHTML = '';
  out.append(`Nouvelle version ${latest} disponible. `);
  const b = document.createElement('button');
  b.className = 'btn small primary';
  b.textContent = 'Télécharger et installer';
  b.addEventListener('click', async () => {
    out.textContent = 'Téléchargement...';
    const dl = await window.satella.downloadUpdate();
    if (!dl.ok) out.textContent = 'Téléchargement impossible : ' + dl.error;
  });
  out.appendChild(b);
});
window.satella.onUpdateProgress(({ percent }) => {
  $('#update-result').textContent = `Téléchargement : ${percent}%`;
});
window.satella.onUpdateReady(({ version }) => {
  const out = $('#update-result');
  out.innerHTML = '';
  out.append(`Version ${version} prête. `);
  const b = document.createElement('button');
  b.className = 'btn small primary';
  b.textContent = 'Redémarrer et installer';
  b.addEventListener('click', () => window.satella.installUpdate());
  out.appendChild(b);
});
window.satella.onUpdateError(({ message }) => {
  $('#update-result').textContent = 'Erreur de mise à jour : ' + message;
});

/* ================= Clavier ================= */
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
    el.innerHTML = `<div class="led"></div><span class="lbl">${key.label}</span>`;
    el.addEventListener('click', (e) => onKeyClick(key.id, e));
    board.appendChild(el);
  }
}

function onKeyClick(id, e) {
  if ($('#kb-paint').checked) {
    const color = $('#kb-color').value;
    window.satella.led.setKeys('keyboard', { [id]: color });
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
  $$('.kb-key').forEach((el) => {
    el.classList.toggle('selected', kbSelection.has(el.dataset.id));
    setKeyVisual(el, lastFrame && lastFrame.keyboard[el.dataset.id]);
  });
  $('#kb-sel-count').textContent = kbSelection.size;
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

  $('#kb-dir').addEventListener('change', (e) => window.satella.led.set('keyboard', { direction: e.target.value }));

  $('#kb-apply').addEventListener('click', () => {
    if (!kbSelection.size) return toast('Sélectionne d’abord des touches.');
    const color = $('#kb-color').value;
    const map = {};
    for (const id of kbSelection) map[id] = color;
    window.satella.led.setKeys('keyboard', map);
    STATE.keyboard.effect = 'static';
    syncToolbars();
  });
  $('#kb-select-all').addEventListener('click', () => {
    LAYOUT.keyboard.forEach((k) => kbSelection.add(k.id));
    refreshSelection();
  });
  $('#kb-clear-sel').addEventListener('click', () => { kbSelection.clear(); refreshSelection(); });
  $('#kb-reset').addEventListener('click', () => window.satella.led.clearKeys('keyboard'));

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
    window.satella.led.set(device, { [prop]: +input.value });
  });
}

function syncToolbars() {
  $$('#kb-effects button').forEach((b) => b.classList.toggle('active', b.dataset.fx === STATE.keyboard.effect));
  $$('#mouse-effects button').forEach((b) => b.classList.toggle('active', b.dataset.fx === STATE.mouse.effect));
  $('#kb-dir-group').style.display = STATE.keyboard.effect === 'wave' ? '' : 'none';
  const showC2 = STATE.keyboard.effect === 'gradient' ? '' : 'none';
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
  $$('.kb-key').forEach((el) => {
    const rgb = frame.keyboard[el.dataset.id];
    if (!rgb) return;
    el.firstElementChild.style.background = rgbCss(rgb);
    setKeyVisual(el, rgb);
  });
  // Souris
  $$('.mouse-zone').forEach((el) => {
    const rgb = frame.mouse[el.dataset.zone];
    if (rgb && el.dataset.zone) {
      el.style.fill = rgbCss(rgb);
      el.style.filter = `drop-shadow(0 0 6px ${rgbCss(rgb)})`;
    }
  });
  // Mini-aperçus accueil
  const kbSpans = $('#home-kb-preview').children;
  const keys = LAYOUT.keyboard;
  for (let i = 0; i < kbSpans.length; i++) {
    const key = keys[Math.floor((i / kbSpans.length) * keys.length)];
    const rgb = frame.keyboard[key.id];
    if (rgb) kbSpans[i].style.background = rgbCss(rgb);
  }
  const msSpans = $('#home-mouse-preview').children;
  LAYOUT.mouse.forEach((z, i) => {
    const rgb = frame.mouse[z.id];
    if (rgb && msSpans[i]) msSpans[i].style.background = rgbCss(rgb);
  });
}

/* ================= Macros ================= */
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
};
const BUTTON_LABELS = { left: 'gauche', right: 'droit', middle: 'molette', x1: 'latéral 1', x2: 'latéral 2' };

function keyLabel(k) { return KEY_LABELS[k] || (k || '?').toUpperCase(); }

function stepDesc(s) {
  switch (s.type) {
    case 'keyTap': {
      const mods = (s.modifiers || []).map(keyLabel).join(' + ');
      return (mods ? mods + ' + ' : '') + keyLabel(s.key);
    }
    case 'keyDown': return 'Maintenir ' + keyLabel(s.key);
    case 'keyUp': return 'Relâcher ' + keyLabel(s.key);
    case 'text': return `« ${String(s.value || '').slice(0, 40)}${(s.value || '').length > 40 ? '…' : ''} »`;
    case 'delay': return `${s.ms} ms`;
    case 'mouseClick': return `Clic ${BUTTON_LABELS[s.button] || s.button}${s.count > 1 ? ' ×' + s.count : ''}`;
    case 'mouseDown': return `Maintenir bouton ${BUTTON_LABELS[s.button] || s.button}`;
    case 'mouseUp': return `Relâcher bouton ${BUTTON_LABELS[s.button] || s.button}`;
    case 'mouseMove': return s.relative ? `Déplacer de (${s.x}, ${s.y})` : `Aller à (${s.x}, ${s.y})`;
    case 'mouseWheel': return `Molette ${s.delta > 0 ? '↑' : '↓'} (${Math.abs(s.delta / 120)} cran(s))`;
    case 'loop': return `Répéter ${s.count} fois (${(s.steps || []).length} étape(s))`;
    case 'runMacro': {
      const m = MACROS.find((x) => x.id === s.macroId);
      return m ? m.name : '(macro supprimée)';
    }
    default: return s.type;
  }
}

function currentMacro() { return MACROS.find((m) => m.id === currentMacroId); }

function renderMacroList() {
  const list = $('#macro-list');
  list.innerHTML = '';
  if (!MACROS.length) {
    list.innerHTML = '<p class="muted">Aucune macro. Crée ta première macro !</p>';
    return;
  }
  for (const m of MACROS) {
    const el = document.createElement('div');
    el.className = 'macro-item' + (m.id === currentMacroId ? ' active' : '') + (m.enabled ? '' : ' disabled');
    el.dataset.id = m.id;
    el.innerHTML = `
      <span class="m-name">${m.name}</span>
      ${m.trigger && m.trigger.accelerator ? `<span class="m-trigger">${m.trigger.accelerator}</span>` : ''}
      <button class="icon-btn m-play" title="Lire">${svg('play')}</button>`;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.m-play')) {
        window.satella.macros.play(m.id);
        return;
      }
      currentMacroId = m.id;
      renderMacroList();
      renderMacroEditor();
    });
    list.appendChild(el);
  }
}

function renderMacroEditor() {
  const ed = $('#macro-editor');
  const m = currentMacro();
  if (!m) {
    ed.innerHTML = '<p class="muted center">Sélectionne une macro ou crées-en une nouvelle.</p>';
    return;
  }
  const opts = m.options || {};
  ed.innerHTML = `
    <div class="form-grid">
      <label>Nom</label>
      <input type="text" id="me-name" value="${m.name.replace(/"/g, '&quot;')}">
      <label>Activée</label>
      <label class="check"><input type="checkbox" id="me-enabled" ${m.enabled ? 'checked' : ''}> la macro peut être déclenchée</label>
      <label>Déclencheur</label>
      <div class="btn-row">
        <input type="text" readonly class="trigger-input" id="me-trigger"
          value="${(m.trigger && m.trigger.accelerator) || ''}" placeholder="Clique puis presse un raccourci…">
        <button class="btn small" id="me-trigger-clear">Effacer</button>
        <span class="muted" style="font-size:11.5px;flex-basis:100%">
          Toute touche est acceptée, seule ou combinée. Attention : une touche
          seule est réservée aux macros dans tout Windows tant que Satella
          tourne (un déclencheur « A » seul rend la lettre A intapable).</span>
      </div>
      <label>Répétitions</label>
      <div class="btn-row">
        <input type="number" id="me-repeat" min="1" max="9999" value="${opts.repeat || 1}" style="width:80px" ${opts.loopInfinite ? 'disabled' : ''}>
        <label class="check"><input type="checkbox" id="me-infinite" ${opts.loopInfinite ? 'checked' : ''}> en boucle jusqu'à re-déclenchement</label>
      </div>
      <label>Délai entre répét.</label>
      <div class="btn-row">
        <input type="number" id="me-repeat-delay" min="0" max="600000" value="${opts.repeatDelayMs || 0}" style="width:100px"> ms
      </div>
      <label>Vitesse ×<span id="me-speed-val">${opts.speed || 1}</span></label>
      <input type="range" id="me-speed" min="0.25" max="4" step="0.25" value="${opts.speed || 1}">
    </div>

    <div class="btn-row" style="margin-bottom:6px">
      <button class="btn primary" id="me-save">${svg('save')} Sauvegarder</button>
      <button class="btn" id="me-play">${svg('play')} Tester</button>
      <button class="btn" id="me-stop">${svg('stop')} Stop</button>
      <button class="btn ${recording ? 'danger' : ''}" id="me-record">${svg(recording ? 'stop' : 'record')} ${recording ? 'Arrêter l’enregistrement' : 'Enregistrer les entrées'}</button>
      <button class="btn danger" id="me-delete">${svg('trash')} Supprimer</button>
    </div>
    ${recording ? `<div class="recording-banner"><div class="rec-dot"></div>
      <span>Enregistrement en cours (<span id="rec-count">${recordedSteps.length}</span> étapes). Utilise clavier et souris librement, puis clique sur Arrêter.</span></div>` : ''}

    <h2>Étapes (${(m.steps || []).length})</h2>
    <div class="steps-list" id="me-steps"></div>
    <div class="add-step-bar" id="me-add-bar"></div>
  `;

  renderSteps();
  buildAddBar($('#me-add-bar'), []);

  $('#me-name').addEventListener('input', (e) => { m.name = e.target.value; });
  $('#me-enabled').addEventListener('change', (e) => { m.enabled = e.target.checked; });
  $('#me-infinite').addEventListener('change', (e) => {
    m.options.loopInfinite = e.target.checked;
    $('#me-repeat').disabled = e.target.checked;
  });
  $('#me-repeat').addEventListener('input', (e) => { m.options.repeat = +e.target.value; });
  $('#me-repeat-delay').addEventListener('input', (e) => { m.options.repeatDelayMs = +e.target.value; });
  $('#me-speed').addEventListener('input', (e) => {
    m.options.speed = +e.target.value;
    $('#me-speed-val').textContent = e.target.value;
  });
  $('#me-trigger-clear').addEventListener('click', () => {
    m.trigger = null;
    $('#me-trigger').value = '';
  });
  setupTriggerCapture($('#me-trigger'), m);

  $('#me-save').addEventListener('click', saveCurrentMacro);
  $('#me-play').addEventListener('click', () => window.satella.macros.play(m.id));
  $('#me-stop').addEventListener('click', () => window.satella.macros.stop(m.id));
  $('#me-delete').addEventListener('click', async () => {
    if (!confirm(`Supprimer la macro « ${m.name} » ?`)) return;
    MACROS = await window.satella.macros.remove(m.id);
    currentMacroId = null;
    renderMacroList();
    renderMacroEditor();
  });
  $('#me-record').addEventListener('click', toggleRecording);
}

async function saveCurrentMacro() {
  const m = currentMacro();
  if (!m) return;
  if (!m.name.trim()) return toast('Donne un nom à la macro.');
  MACROS = await window.satella.macros.save(JSON.parse(JSON.stringify(m)));
  renderMacroList();
  toast('Macro sauvegardée.');
}

/* Étapes : accès par chemin (imbrication 1 niveau pour les boucles) */
function getStepsAt(path) {
  const m = currentMacro();
  if (!path.length) return m.steps;
  return m.steps[path[0]].steps;
}

function renderSteps() {
  const m = currentMacro();
  const cont = $('#me-steps');
  cont.innerHTML = '';
  if (!m.steps) m.steps = [];
  if (!m.steps.length) {
    cont.innerHTML = '<p class="muted">Aucune étape. Ajoute des étapes ou utilise l’enregistreur.</p>';
    return;
  }
  m.steps.forEach((s, i) => {
    cont.appendChild(stepRow(s, [i], false));
    if (s.type === 'loop') {
      (s.steps || []).forEach((sub, j) => cont.appendChild(stepRow(sub, [i, j], true)));
      const addRow = document.createElement('div');
      addRow.className = 'step-row nested';
      addRow.innerHTML = `<span class="s-icon">${svg('loop')}</span>`;
      const bar = document.createElement('div');
      bar.className = 'add-step-bar';
      bar.style.margin = '0';
      buildAddBar(bar, [i], true);
      addRow.appendChild(bar);
      cont.appendChild(addRow);
    }
  });
}

function stepRow(s, path, nested) {
  const meta = STEP_META[s.type] || { icon: 'key', name: s.type };
  const row = document.createElement('div');
  row.className = 'step-row' + (nested ? ' nested' : '');
  row.innerHTML = `
    <span class="s-icon">${svg(meta.icon)}</span>
    <span class="s-type">${meta.name}</span>
    <span class="s-desc">${stepDesc(s)}</span>
    <span class="s-actions">
      <button class="icon-btn" data-act="up" title="Monter">${svg('up')}</button>
      <button class="icon-btn" data-act="down" title="Descendre">${svg('down')}</button>
      <button class="icon-btn" data-act="edit" title="Modifier">${svg('edit')}</button>
      <button class="icon-btn" data-act="dup" title="Dupliquer">${svg('copy')}</button>
      <button class="icon-btn" data-act="del" title="Supprimer">${svg('close')}</button>
    </span>`;
  row.querySelector('.s-actions').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    const act = btn && btn.dataset.act;
    if (!act) return;
    const list = getStepsAt(path.slice(0, -1));
    const idx = path[path.length - 1];
    if (act === 'del') list.splice(idx, 1);
    else if (act === 'dup') list.splice(idx + 1, 0, JSON.parse(JSON.stringify(s)));
    else if (act === 'up' && idx > 0) [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]];
    else if (act === 'down' && idx < list.length - 1) [list[idx + 1], list[idx]] = [list[idx], list[idx + 1]];
    else if (act === 'edit') return openStepModal(s.type, path);
    renderSteps();
  });
  return row;
}

function buildAddBar(container, path, nested = false) {
  const types = nested
    ? ['keyTap', 'keyDown', 'keyUp', 'text', 'delay', 'mouseClick', 'mouseMove', 'mouseWheel']
    : Object.keys(STEP_META);
  for (const t of types) {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.innerHTML = svg(STEP_META[t].icon) + ' ' + STEP_META[t].name;
    b.addEventListener('click', () => openStepModal(t, null, path));
    container.appendChild(b);
  }
}

/* ---- Modale d'édition d'étape ---- */
function openStepModal(type, editPath = null, addPath = []) {
  const modal = $('#modal');
  const backdrop = $('#modal-backdrop');
  const existing = editPath ? getStepsAt(editPath.slice(0, -1))[editPath[editPath.length - 1]] : null;
  const s = existing || { type };
  const meta = STEP_META[type];

  const keyOptions = KEY_NAMES.map((k) =>
    `<option value="${k}" ${s.key === k ? 'selected' : ''}>${keyLabel(k)}</option>`).join('');
  const btnOptions = Object.entries(BUTTON_LABELS).map(([v, l]) =>
    `<option value="${v}" ${s.button === v ? 'selected' : ''}>${l}</option>`).join('');
  const macroOptions = MACROS.filter((m) => m.id !== currentMacroId).map((m) =>
    `<option value="${m.id}" ${s.macroId === m.id ? 'selected' : ''}>${m.name}</option>`).join('');

  let fields = '';
  switch (type) {
    case 'keyTap':
      fields = `
        <label>Touche</label><select id="sf-key">${keyOptions}</select>
        <label>Modificateurs</label>
        <div class="btn-row">
          ${['lctrl', 'lshift', 'lalt', 'lwin'].map((mod) => `
            <label class="check"><input type="checkbox" class="sf-mod" value="${mod}"
              ${(s.modifiers || []).includes(mod) ? 'checked' : ''}> ${keyLabel(mod).replace(' gauche', '')}</label>`).join('')}
        </div>`;
      break;
    case 'keyDown': case 'keyUp':
      fields = `<label>Touche</label><select id="sf-key">${keyOptions}</select>`;
      break;
    case 'text':
      fields = `<label>Texte à taper</label>
        <textarea id="sf-text" rows="4" style="width:100%;background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:7px;padding:8px">${s.value || ''}</textarea>`;
      break;
    case 'delay':
      fields = `<label>Durée (ms)</label><input type="number" id="sf-ms" min="1" max="600000" value="${s.ms || 100}">`;
      break;
    case 'mouseClick':
      fields = `
        <label>Bouton</label><select id="sf-button">${btnOptions}</select>
        <label>Nombre de clics</label><input type="number" id="sf-count" min="1" max="100" value="${s.count || 1}">`;
      break;
    case 'mouseDown': case 'mouseUp':
      fields = `<label>Bouton</label><select id="sf-button">${btnOptions}</select>`;
      break;
    case 'mouseMove':
      fields = `
        <label>X</label><input type="number" id="sf-x" value="${s.x || 0}">
        <label>Y</label><input type="number" id="sf-y" value="${s.y || 0}">
        <label class="check" style="grid-column:1/3"><input type="checkbox" id="sf-relative" ${s.relative ? 'checked' : ''}> Déplacement relatif (sinon position absolue à l'écran)</label>`;
      break;
    case 'mouseWheel':
      fields = `
        <label>Crans (+ haut / − bas)</label><input type="number" id="sf-cranks" min="-50" max="50" value="${(s.delta || 120) / 120}">
        <label class="check" style="grid-column:1/3"><input type="checkbox" id="sf-horizontal" ${s.horizontal ? 'checked' : ''}> Défilement horizontal</label>`;
      break;
    case 'loop':
      fields = `<label>Nombre de répétitions</label><input type="number" id="sf-count" min="1" max="10000" value="${s.count || 2}">
        <p class="muted" style="grid-column:1/3">Les étapes de la boucle s'ajoutent ensuite sous celle-ci dans la liste.</p>`;
      break;
    case 'runMacro':
      fields = macroOptions
        ? `<label>Macro à exécuter</label><select id="sf-macro">${macroOptions}</select>`
        : '<p class="muted">Aucune autre macro disponible.</p>';
      break;
  }

  modal.innerHTML = `
    <h3>${svg(meta.icon, 'icon')} ${meta.name}</h3>
    <div class="form-grid">${fields}</div>
    <label>Pause après l'étape (ms)</label>
    <input type="number" id="sf-gap" min="0" max="60000" value="${s.gapMs !== undefined ? s.gapMs : 15}" style="margin:6px 0 14px">
    <div class="btn-row">
      <button class="btn primary" id="sf-ok">Valider</button>
      <button class="btn" id="sf-cancel">Annuler</button>
    </div>`;
  backdrop.hidden = false;

  $('#sf-cancel').addEventListener('click', () => { backdrop.hidden = true; });
  $('#sf-ok').addEventListener('click', () => {
    const out = { type, gapMs: +($('#sf-gap').value || 15) };
    switch (type) {
      case 'keyTap':
        out.key = $('#sf-key').value;
        out.modifiers = $$('.sf-mod:checked').map((c) => c.value);
        break;
      case 'keyDown': case 'keyUp': out.key = $('#sf-key').value; break;
      case 'text': out.value = $('#sf-text').value; break;
      case 'delay': out.ms = +$('#sf-ms').value; break;
      case 'mouseClick': out.button = $('#sf-button').value; out.count = +$('#sf-count').value; break;
      case 'mouseDown': case 'mouseUp': out.button = $('#sf-button').value; break;
      case 'mouseMove':
        out.x = +$('#sf-x').value; out.y = +$('#sf-y').value;
        out.relative = $('#sf-relative').checked;
        break;
      case 'mouseWheel':
        out.delta = (+$('#sf-cranks').value || 1) * 120;
        out.horizontal = $('#sf-horizontal').checked;
        break;
      case 'loop':
        out.count = +$('#sf-count').value;
        out.steps = existing ? existing.steps || [] : [];
        break;
      case 'runMacro':
        if (!$('#sf-macro')) { backdrop.hidden = true; return; }
        out.macroId = $('#sf-macro').value;
        break;
    }
    if (editPath) {
      const list = getStepsAt(editPath.slice(0, -1));
      list[editPath[editPath.length - 1]] = out;
    } else {
      getStepsAt(addPath).push(out);
    }
    backdrop.hidden = true;
    renderSteps();
  });
}
$('#modal-backdrop').addEventListener('click', (e) => {
  if (calib) return; // pas de fermeture accidentelle pendant la calibration
  if (e.target === e.currentTarget) e.currentTarget.hidden = true;
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
    ? `<p class="muted" style="margin-top:8px">Dernière touche associée : ${calib.lastLabel}</p>` : '';
  const dup = calib.dupWarn
    ? `<p style="margin-top:8px;color:var(--warn)">Appui reconnu comme « ${calib.dupWarn} », déjà associée.
       Si la touche allumée est sa jumelle (Alt droit, Ctrl droit...), le clavier envoie le même code :
       associe-la manuellement ci-dessous.</p>` : '';
  const options = LAYOUT.keyboard.map((k) => {
    const label = keyLabel(k.id) + (calib.map[k.id] !== undefined ? ' (déjà associée)' : '');
    return `<option value="${k.id}">${label}</option>`;
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
function setupTriggerCapture(inputEl, macro) {
  inputEl.addEventListener('focus', () => {
    inputEl.classList.add('capturing');
    inputEl.value = 'Presse un raccourci…';
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
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
      if (!key) return;
      parts.push(key);
      const accel = parts.join('+');
      macro.trigger = { type: 'hotkey', accelerator: accel };
      inputEl.value = accel;
      inputEl.blur();
    };
    inputEl.addEventListener('keydown', onKey);
    inputEl.addEventListener('blur', () => {
      inputEl.classList.remove('capturing');
      inputEl.removeEventListener('keydown', onKey);
      inputEl.value = (macro.trigger && macro.trigger.accelerator) || '';
    }, { once: true });
  });
}

/* ---- Enregistreur ---- */
async function toggleRecording() {
  const m = currentMacro();
  if (!m) return;
  if (!recording) {
    if (!CAPS.uiohook) return toast("L'écoute globale n'est pas disponible sur ce système.");
    recording = true;
    recordedSteps = [];
    await window.satella.macros.recordStart({ mouse: true, moves: false });
    renderMacroEditor();
  } else {
    recording = false;
    let steps = await window.satella.macros.recordStop();
    steps = trimRecordingTail(steps);
    m.steps = (m.steps || []).concat(steps);
    renderMacroEditor();
    toast(`${steps.length} étape(s) ajoutée(s) depuis l'enregistrement.`);
  }
}

// Retire le clic final sur le bouton « Arrêter » (et les délais orphelins)
function trimRecordingTail(steps) {
  const out = [...steps];
  while (out.length) {
    const last = out[out.length - 1];
    if (last.type === 'mouseDown' || last.type === 'mouseUp' || last.type === 'delay') out.pop();
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
    options: { repeat: 1, loopInfinite: false, repeatDelayMs: 0, speed: 1 },
    steps: [],
  };
  MACROS.push(m);
  currentMacroId = m.id;
  renderMacroList();
  renderMacroEditor();
}
$('#macro-new').addEventListener('click', newMacro);

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
  badge.innerHTML = row('GS98', DIRECT.keyboard) + row('PC365A', DIRECT.mouse);
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
      réglages dans sa propre mémoire.
    </p>
    ${row(status.keyboard, 'Clavier SURMEN GS98, puce EVision', '320F:505B')}
    ${row(status.mouse, 'Souris Risophy PC365A, puce Areson', '25A7:FA7B')}
    ${status.error ? `<p class="muted">Attention : ${status.error}</p>` : ''}
  `;
}

function renderHidList(hid) {
  const p = $('#hid-list');
  if (!hid.available) {
    p.innerHTML = `<p class="muted">Détection USB indisponible : ${hid.error || ''}</p>`;
    return;
  }
  const devs = hid.devices.filter((d) => d.product || d.manufacturer);
  devs.sort((a, b) => (b.isLikelyTarget - a.isLikelyTarget));
  p.innerHTML = devs.map((d) => `
    <div class="hid-row">
      <span style="flex:1">${d.manufacturer ? d.manufacturer + ' · ' : ''}${d.product || '(sans nom)'}</span>
      <span class="h-ids">${d.vid}:${d.pid}</span>
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
async function renderProfiles() {
  const profiles = await window.satella.profiles.list();
  const p = $('#profile-list');
  p.innerHTML = profiles.map((pr) => `
    <div class="profile-row" data-name="${pr.name.replace(/"/g, '&quot;')}">
      <div class="p-main">
        <span class="p-name">${pr.name}
          ${pr.isDefault ? '<span class="tag tag-kb">Par défaut</span>' : ''}</span>
        <span class="p-date">${new Date(pr.savedAt).toLocaleString('fr-FR')}</span>
        <button class="btn small p-load">Charger</button>
        <button class="btn small p-default">${pr.isDefault ? 'Retirer le défaut' : 'Par défaut'}</button>
        <button class="btn small danger p-del">Supprimer</button>
      </div>
      <div class="p-apps">
        <input type="text" class="p-apps-input" placeholder="Applications liées : jeu.exe, autre.exe"
          value="${(pr.apps || []).join(', ')}">
        <button class="btn small p-apps-save">Lier</button>
      </div>
    </div>`).join('') || '<p class="muted">Aucun profil sauvegardé.</p>';

  $$('.p-default').forEach((b) => b.addEventListener('click', async (e) => {
    const row = e.target.closest('.profile-row');
    const pr = profiles.find((x) => x.name === row.dataset.name);
    await window.satella.profiles.setMeta(row.dataset.name, { isDefault: !(pr && pr.isDefault) });
    renderProfiles();
  }));
  $$('.p-apps-save').forEach((b) => b.addEventListener('click', async (e) => {
    const row = e.target.closest('.profile-row');
    const apps = row.querySelector('.p-apps-input').value.split(',');
    await window.satella.profiles.setMeta(row.dataset.name, { apps });
    renderProfiles();
    toast('Applications liées au profil.');
  }));

  $$('.p-load').forEach((b) => b.addEventListener('click', async (e) => {
    const name = e.target.closest('.profile-row').dataset.name;
    const res = await window.satella.profiles.load(name);
    if (res) {
      STATE = res.ledState;
      MACROS = res.macros;
      currentMacroId = null;
      syncToolbars();
      renderMacroList();
      renderMacroEditor();
      toast(`Profil « ${name} » chargé.`);
    }
  }));
  $$('.p-del').forEach((b) => b.addEventListener('click', async (e) => {
    const name = e.target.closest('.profile-row').dataset.name;
    if (!confirm(`Supprimer le profil « ${name} » ?`)) return;
    await window.satella.profiles.remove(name);
    renderProfiles();
  }));
}

$('#profile-save').addEventListener('click', async () => {
  const name = $('#profile-name').value.trim();
  if (!name) return toast('Donne un nom au profil.');
  await window.satella.profiles.save(name);
  $('#profile-name').value = '';
  renderProfiles();
  toast(`Profil « ${name} » sauvegardé.`);
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
  $('#set-autoupdate').checked = s.autoCheckUpdates;
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
}

$('#set-startup').addEventListener('change', async (e) => {
  renderSettings(await window.satella.settings.set({ launchAtStartup: e.target.checked }));
  toast(e.target.checked
    ? 'Satella se lancera au démarrage de Windows.'
    : 'Lancement au démarrage désactivé.');
});
$('#set-startmin').addEventListener('change', async (e) => {
  renderSettings(await window.satella.settings.set({ startMinimized: e.target.checked }));
});

$('#set-appprofiles').addEventListener('change', async (e) => {
  renderSettings(await window.satella.settings.set({ appProfiles: e.target.checked }));
});
$('#set-idleoff').addEventListener('change', async (e) => {
  renderSettings(await window.satella.settings.set({ idleOff: e.target.checked }));
});
$('#set-idle-min').addEventListener('input', (e) => {
  $('#set-idle-val').textContent = e.target.value + ' min';
});
$('#set-idle-min').addEventListener('change', (e) => {
  window.satella.settings.set({ idleMinutes: +e.target.value });
});
$('#set-autoupdate').addEventListener('change', async (e) => {
  renderSettings(await window.satella.settings.set({ autoCheckUpdates: e.target.checked }));
});

$('#set-leds').addEventListener('change', async (e) => {
  renderSettings(await window.satella.settings.set({ ledsEnabled: e.target.checked }));
  toast(e.target.checked ? 'Gestion des LED activée.' : 'Gestion des LED désactivée.');
});
$('#set-macros').addEventListener('change', async (e) => {
  renderSettings(await window.satella.settings.set({ macrosEnabled: e.target.checked }));
  toast(e.target.checked ? 'Macros activées.' : 'Macros désactivées.');
});

// L'entrée de démarrage peut être retirée depuis le gestionnaire des tâches
// de Windows : on reflète l'état réel plutôt que le réglage enregistré.
async function syncStartupState() {
  const real = await window.satella.settings.startupState();
  if (real !== SETTINGS.launchAtStartup) {
    renderSettings(await window.satella.settings.set({ launchAtStartup: real }));
  }
}

async function refreshFootprint() {
  const st = await window.satella.memory.status();
  if (!st) return;
  $('#set-footprint').textContent =
    `Mémoire vive du système : ${(st.usedPhys / GO).toFixed(1)} Go utilisés sur `
    + `${(st.totalPhys / GO).toFixed(1)} Go (${st.load}%). `
    + `Modules actifs : ${[SETTINGS.ledsEnabled && 'LED', SETTINGS.macrosEnabled && 'macros']
      .filter(Boolean).join(', ') || 'aucun'}.`;
}

/* ================= Initialisation ================= */
async function init() {
  const data = await window.satella.init();
  LAYOUT = data.layout;
  STATE = data.ledState;
  MACROS = data.macros;
  KEY_NAMES = data.keyNames;
  KEY_LABELS = data.keyLabels;
  CAPS = data.capabilities;
  $('#app-version').textContent = data.version || '?';
  renderSettings(data.settings || SETTINGS);
  if (!data.memoryAvailable) {
    $('#mem-panel').innerHTML = '<p class="muted">Optimiseur indisponible sur ce système.</p>';
  }

  buildKeyboard();
  buildMouse();
  buildToolbars();
  buildHomePreviews();
  syncToolbars();
  renderMacroList();
  renderMacroEditor();
  renderDirectPanel(data.direct);
  renderHidList(data.hid);
  renderProfiles();

  window.satella.led.onFrame(applyFrame);
  window.satella.devices.onDirectStatus(renderDirectPanel);
  window.satella.macros.onRecordEvent((step) => {
    if (!recording) return;
    recordedSteps.push(step);
    const banner = $('.recording-banner');
    const counter = $('#rec-count');
    if (counter) counter.textContent = recordedSteps.length;
  });
  window.satella.macros.onPlayState(({ id, playing }) => {
    const el = document.querySelector(`.macro-item[data-id="${id}"]`);
    if (el) el.classList.toggle('playing', playing);
  });
  window.satella.macros.onPlayError(({ message }) => toast('Erreur macro : ' + message, 4000));
  window.satella.settings.onChanged(renderSettings);
  window.satella.profiles.onAutoApplied(({ name, exe, ledState, macros: m }) => {
    STATE = ledState;
    MACROS = m;
    currentMacroId = null;
    syncToolbars();
    renderMacroList();
    renderMacroEditor();
    toast(exe
      ? `Profil « ${name} » appliqué pour ${exe}.`
      : `Profil par défaut « ${name} » appliqué.`);
  });
  window.satella.memory.onAuto((res) => {
    if (res && res.ok && res.freed > 0) {
      toast(`Nettoyage automatique : ${(res.freed / GO).toFixed(2)} Go libérés.`);
      if ($('#page-optimizer').classList.contains('active')) renderMemory(res.after);
    }
  });

  window.satella.ready();
}

init();
