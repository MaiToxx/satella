const test = require('node:test');
const assert = require('node:assert/strict');
const { LedEngine } = require('../src/led/engine');

function engine() {
  const e = new LedEngine();
  e.stop(); // pas de minuterie pendant les tests
  return e;
}

test('le calque s’affiche par-dessus un effet, pas sur « éteint »', () => {
  const e = engine();
  e.setDeviceState('keyboard', { effect: 'rainbow', brightness: 100 });
  e.setOverlay('keyboard', { w: '#ffffff' });
  let kb = e.computeKeyboard();
  assert.deepEqual(kb.w, [255, 255, 255]);
  e.setDeviceState('keyboard', { brightness: 50 });
  kb = e.computeKeyboard();
  assert.deepEqual(kb.w, [128, 128, 128]);
  e.setDeviceState('keyboard', { effect: 'off' });
  kb = e.computeKeyboard();
  assert.deepEqual(kb.w, [0, 0, 0]);
  e.removeOverlay('keyboard', ['w']);
  assert.deepEqual(e.state.keyboard.overlay, {});
});

test('charger un ancien état sans calque efface le calque courant', () => {
  const e = engine();
  e.setOverlay('keyboard', { a: '#ff0000' });
  e.loadState({ keyboard: { effect: 'static', baseColor: '#00ff00', colors: {} } });
  assert.deepEqual(e.state.keyboard.overlay, {});
  assert.equal(e.state.keyboard.color2, '#ff00d4'); // valeur par défaut, pas l'ancienne
});

test('jauge système : F1-F12 suivent le processeur, la rangée des chiffres la mémoire', () => {
  const e = engine();
  e.setDeviceState('keyboard', { effect: 'sysmon', baseColor: '#0000ff' });
  e.setSystemStats({ cpu: 0.5, ram: 1 });
  const kb = e.computeKeyboard();
  const lum = (rgb) => rgb[0] + rgb[1] + rgb[2];
  assert.ok(lum(kb.f1) > 200, 'F1 allumée');
  assert.ok(lum(kb.f12) < 60, 'F12 éteinte à 50 %');
  assert.ok(lum(kb.equal) > 200, 'mémoire pleine');
  assert.deepEqual(kb.q, [0, 0, 64]); // autres touches : couleur de base atténuée
});

test('visualiseur audio : colonnes remplies depuis le bas', () => {
  const e = engine();
  e.setDeviceState('keyboard', { effect: 'audio', baseColor: '#ff0000', color2: '#0000ff' });
  const bands = new Array(16).fill(0);
  bands[0] = 1;  // basses à fond (colonne de gauche)
  e.setAudioBands(bands);
  const kb = e.computeKeyboard();
  assert.ok(kb.esc[0] + kb.esc[2] > 200, 'Échap (haut gauche) allumée');
  assert.ok(kb.lctrl[0] + kb.lctrl[2] > 200, 'Ctrl gauche allumée');
  assert.ok(kb.npenter[0] + kb.npenter[2] < 30, 'pavé (droite) éteint');
});

test('le flash recouvre puis disparaît', async () => {
  const e = engine();
  e.setDeviceState('keyboard', { effect: 'static', baseColor: '#000000' });
  e.flash([0, 255, 0], 80);
  const during = e.computeKeyboard();
  assert.ok(during.a[1] > 150);
  await new Promise((r) => setTimeout(r, 120));
  const after = e.computeKeyboard();
  assert.deepEqual(after.a, [0, 0, 0]);
});

test('aucune image calculée quand personne ne regarde', () => {
  const e = engine();
  e.setDeviceState('keyboard', { effect: 'wave' });
  let frames = 0;
  e.on('frame', () => frames++);
  e.wantFrames = () => false;
  e.tick();
  e.tick();
  assert.equal(frames, 0);
  e.wantFrames = () => true;
  e.tick();
  assert.equal(frames, 1);
});
