const test = require('node:test');
const assert = require('node:assert/strict');
const { EFFECT_SETTINGS, fxSettings, isNativeCompatible, sanitizeFx } = require('../src/shared/effects');
const { isStreamed } = require('../src/led/direct');
const { LedEngine } = require('../src/led/engine');

function engine() {
  const e = new LedEngine();
  e.stop();
  return e;
}
const lum = (rgb) => rgb[0] + rgb[1] + rgb[2];

test('réglages d’effet : valeurs par défaut, bornes, source de couleur', () => {
  assert.deepEqual(fxSettings({}, 'fire'), { colors: 'fire', height: 100 });
  assert.deepEqual(fxSettings({ fx: { fire: { colors: 'duo', height: 999 } } }, 'fire'), { colors: 'duo', height: 200 });
  assert.equal(fxSettings({ fx: { fire: { colors: 'inventée' } } }, 'fire').colors, 'fire');
  // Chaque effet du clavier a une entrée, chaque paramètre une valeur par défaut dans ses bornes
  for (const [name, def] of Object.entries(EFFECT_SETTINGS)) {
    for (const p of def.params) assert.ok(p.def >= p.min && p.def <= p.max, `${name}.${p.id}`);
  }
});

test('effet natif personnalisé : calculé par Satella et diffusé', () => {
  const wave = { effect: 'wave', overlay: {} };
  assert.equal(isNativeCompatible(wave), true);
  assert.equal(isStreamed(wave), false);
  const custom = { ...wave, fx: { wave: { colors: 'palette' } } };
  assert.equal(isNativeCompatible(custom), false);
  assert.equal(isStreamed(custom), true);
  assert.equal(isStreamed({ effect: 'breathing', fx: { breathing: { depth: 50 } } }), true);
  assert.equal(isStreamed({ effect: 'breathing', fx: { fire: { height: 50 } } }), false, 'réglages d’un autre effet sans effet');
});

test('réglages importés : seuls les effets, couleurs et nombres valides sont gardés', () => {
  assert.deepEqual(sanitizeFx({
    fire: { colors: 'duo', height: 150.4, evil: 1 },
    rain: { density: '300' },
    inconnu: { x: 1 },
    disco: { density: -5, colors: 'rainbow' },
  }), { fire: { colors: 'duo', height: 150 }, disco: { density: 10, colors: 'rainbow' } });
  assert.deepEqual(sanitizeFx('rien'), {});
});

test('feu « deux couleurs » : flammes aux couleurs choisies', () => {
  const e = engine();
  e.setDeviceState('keyboard', { effect: 'fire', baseColor: '#0000ff', color2: '#00ffff', brightness: 100, fx: { fire: { colors: 'duo' } } });
  const kb = e.computeKeyboard();
  const all = Object.values(kb);
  assert.ok(all.every((c) => c[0] === 0), 'aucune touche rouge');
  assert.ok(all.some((c) => c[2] > 100), 'des flammes bleues');
});

test('disco : la densité règle le nombre de touches allumées', () => {
  const lit = (density) => {
    const e = engine();
    e.setDeviceState('keyboard', { effect: 'disco', fx: { disco: { density } } });
    return Object.values(e.computeKeyboard()).filter((c) => lum(c) > 0).length;
  };
  assert.ok(lit(90) > lit(10) * 3, `${lit(90)} contre ${lit(10)}`);
});

test('réactif avec rayon : les voisines s’allument aussi, en arc-en-ciel', () => {
  const e = engine();
  e.setDeviceState('keyboard', { effect: 'reactive', baseColor: '#ffffff', brightness: 100, fx: { reactive: { spread: 1, colors: 'rainbow' } } });
  e.keyActivity('g');
  const kb = e.computeKeyboard();
  assert.ok(lum(kb.g) > 0 && lum(kb.f) > 0 && lum(kb.h) > 0, 'g et ses voisines');
  assert.equal(lum(kb.esc), 0, 'touche éloignée éteinte');
  assert.notDeepEqual(kb.g, [255, 255, 255], 'couleur de la frappe, pas la couleur unique');
});

test('jauge système et carte de chaleur aux couleurs choisies ; saturation de l’ambiance écran', () => {
  const e = engine();
  e.setDeviceState('keyboard', { effect: 'sysmon', baseColor: '#000000', color2: '#ff00ff', brightness: 100, fx: { sysmon: { colors: 'duo' } } });
  e.setSystemStats({ cpu: 1, ram: 1 });
  assert.deepEqual(e.computeKeyboard().f12, [255, 0, 255], 'haut de jauge = couleur 2');
  e.setDeviceState('keyboard', { effect: 'screen', fx: { screen: { saturation: 0 } } });
  e.setScreenGrid(new Array(20 * 6 * 3).fill(0).map((_, i) => (i % 3 === 0 ? 255 : 0)));
  for (let i = 0; i < 40; i++) e.computeKeyboard();
  const c = e.computeKeyboard().q;
  assert.ok(c[0] === c[1] && c[1] === c[2], `gris sans saturation : ${c}`);
});

test('respiration en palette : la couleur change à chaque souffle', () => {
  const e = engine();
  e.setDeviceState('keyboard', { effect: 'breathing', palette: ['#ff0000', '#00ff00'], brightness: 100, fx: { breathing: { colors: 'palette' } } });
  const period = 1 / ((0.2 + 0.5 * 2.3) * 0.35);
  e.t = period * 0.25; // sommet du 1er souffle
  const a = e.computeKeyboard().q;
  e.t = period * 1.25; // sommet du 2e
  const b = e.computeKeyboard().q;
  assert.ok(a[0] > 200 && a[1] < 30, `1er souffle rouge : ${a}`);
  assert.ok(b[1] > 200 && b[0] < 30, `2e souffle vert : ${b}`);
});
