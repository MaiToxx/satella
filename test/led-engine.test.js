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

test('ambiance écran : chaque touche prend la couleur de sa zone d’écran', () => {
  const { SCREEN_COLS, SCREEN_ROWS } = require('../src/led/engine');
  const e = engine();
  e.setDeviceState('keyboard', { effect: 'screen', speed: 100 });
  const grid = new Array(SCREEN_COLS * SCREEN_ROWS * 3).fill(0);
  grid.splice(0, 3, 255, 0, 0);                                  // coin haut gauche : rouge
  grid.splice(grid.length - 3, 3, 0, 0, 255);                    // coin bas droit : bleu
  e.setScreenGrid(grid);
  e._lastCompute = Date.now() - 100; // transition terminée d'un coup
  const kb = e.computeKeyboard();
  assert.deepEqual(kb.esc, [255, 0, 0]);
  assert.deepEqual(kb.npenter, [0, 0, 255]);
  assert.deepEqual(kb.g, [0, 0, 0]);
});

test('ambiance écran : transition douce et valeurs bornées', () => {
  const e = engine();
  e.setDeviceState('keyboard', { effect: 'screen', speed: 0 });
  e.setScreenGrid(new Array(360).fill(999));
  e._lastCompute = Date.now() - 33;
  const kb = e.computeKeyboard();
  assert.ok(kb.esc[0] > 0 && kb.esc[0] < 255, String(kb.esc[0]));
  e.setScreenGrid(null); // ignoré sans erreur
});

test('carte de chaleur : bleu pour les touches rares, rouge pour les plus utilisées', () => {
  const e = engine();
  e.setDeviceState('keyboard', { effect: 'heatmap', baseColor: '#ffffff', brightness: 100 });
  const counts = { e: 1000, a: 10 };
  e.setHeatmap(counts);
  const kb = e.computeKeyboard();
  assert.ok(kb.e[0] > 200 && kb.e[2] < 30, 'la plus utilisée est rouge : ' + kb.e);
  assert.ok(kb.a[1] > kb.a[0], 'une touche moyenne tire vers le vert/bleu : ' + kb.a);
  assert.deepEqual(kb.q, [15, 15, 15]); // jamais pressée : couleur de base très atténuée
  counts.q = 5; // la référence partagée est lue en direct
  assert.notDeepEqual(e.computeKeyboard().q, [15, 15, 15]);
});

test('atténuation globale (mode nuit) appliquée à l’aperçu et au flux', () => {
  const e = engine();
  e.setDeviceState('keyboard', { effect: 'static', baseColor: '#ffffff', brightness: 100, colors: {} });
  e.setDeviceState('mouse', { effect: 'static', baseColor: '#ffffff', brightness: 100, colors: {} });
  e.setDimFactor(0.5);
  assert.deepEqual(e.computeKeyboard().esc, [128, 128, 128]);
  assert.deepEqual(e.computeMouse().logo, [128, 128, 128]);
  e.setDimFactor(1);
  assert.deepEqual(e.computeKeyboard().esc, [255, 255, 255]);
});

test('minuteur : F1-F12 se vident avec le temps, puis tout le clavier clignote', () => {
  const e = engine();
  e.setDeviceState('keyboard', { effect: 'static', baseColor: '#0000ff', brightness: 100 });
  assert.equal(e.hasLiveLayers(), false);
  e.setTimer({ ms: 60000, t0: Date.now() - 30000 }); // moitié du temps écoulée
  assert.equal(e.hasLiveLayers(), true);
  let kb = e.computeKeyboard();
  const lum = (rgb) => rgb[0] + rgb[1] + rgb[2];
  assert.ok(lum(kb.f1) > 300, 'F1 encore allumée');
  assert.ok(lum(kb.f12) < 60, 'F12 déjà éteinte');
  assert.deepEqual(kb.q, [0, 0, 255], 'le reste du clavier garde son effet');
  // Temps écoulé : clignotement orange de tout le clavier
  e.setTimer({ ms: 1000, t0: Date.now() - 1010 });
  kb = e.computeKeyboard();
  assert.deepEqual(kb.q, [255, 90, 0]);
  e.setTimer(null);
  assert.equal(e.hasLiveLayers(), false);
  assert.deepEqual(e.computeKeyboard().q, [0, 0, 255]);
});

test('minuteur : images calculées même sur un effet statique', () => {
  const e = engine();
  e.setDeviceState('keyboard', { effect: 'static' });
  let frames = 0;
  e.on('frame', () => frames++);
  e.tick();
  assert.equal(frames, 0, 'statique : rien à recalculer');
  e.setTimer({ ms: 60000 });
  frames = 0;
  e.tick();
  assert.equal(frames, 1);
});

test('témoins : touche allumée par-dessus l’effet, sans toucher à l’état enregistré', () => {
  const e = engine();
  e.setDeviceState('keyboard', { effect: 'static', baseColor: '#000000', brightness: 100 });
  let states = 0;
  e.on('state', () => states++);
  e.setIndicators({ capslock: [255, 255, 255] });
  assert.equal(states, 0);
  assert.equal(e.hasLiveLayers(), true);
  assert.deepEqual(e.computeKeyboard().capslock, [255, 255, 255]);
  assert.deepEqual(e.computeKeyboard().a, [0, 0, 0]);
  assert.deepEqual(e.state.keyboard.overlay, {});
  e.setIndicators({});
  assert.equal(e.hasLiveLayers(), false);
  assert.deepEqual(e.computeKeyboard().capslock, [0, 0, 0]);
});
