const test = require('node:test');
const assert = require('node:assert/strict');
const { MacroEngine } = require('../src/macros/engine');
const { fakeInput, fakeShortcuts } = require('./helpers');

const make = (macros, opts = {}) => {
  const injector = fakeInput();
  const engine = new MacroEngine({ globalShortcut: fakeShortcuts(opts.taken), injector });
  const errors = [];
  engine.on('play-error', (e) => errors.push(e.message));
  const conflicts = engine.setMacros(macros);
  return { engine, injector, errors, conflicts };
};

test('arrêter une macro relâche les touches et boutons maintenus', async () => {
  const { engine, injector } = make([{ id: 'a', enabled: true, steps: [
    { type: 'keyDown', key: 'lshift' }, { type: 'mouseDown', button: 'right' },
    { type: 'delay', ms: 2000 }, { type: 'keyUp', key: 'lshift' },
  ] }]);
  const p = engine.play('a');
  setTimeout(() => engine.stop('a'), 120);
  await p;
  assert.deepEqual([...injector.held], []);
  assert.deepEqual([...injector.buttons], []);
});

test('une touche inconnue au milieu d’une combinaison ne bloque pas les modificateurs', async () => {
  const { engine, injector, errors } = make([{ id: 'a', enabled: true, steps: [
    { type: 'keyTap', key: 'inconnue', modifiers: ['lctrl', 'lalt'] },
  ] }]);
  await engine.play('a');
  assert.equal(errors.length, 1);
  assert.deepEqual([...injector.held], []);
});

test('un cycle A -> B -> A est arrêté avec une erreur lisible', async () => {
  const { engine, injector, errors } = make([
    { id: 'A', name: 'Alpha', enabled: true, steps: [{ type: 'keyTap', key: 'a' }, { type: 'runMacro', macroId: 'B' }] },
    { id: 'B', name: 'Bêta', enabled: true, steps: [{ type: 'runMacro', macroId: 'A' }] },
  ]);
  await engine.play('A');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /boucle infinie/);
  assert.equal(injector.log.filter((l) => l === 'down a').length, 1);
});

test('une macro peut en appeler une autre plusieurs fois sans être prise pour un cycle', async () => {
  const { engine, injector, errors } = make([
    { id: 'A', enabled: true, steps: [{ type: 'runMacro', macroId: 'B', gapMs: 0 }, { type: 'runMacro', macroId: 'B', gapMs: 0 }] },
    { id: 'B', enabled: true, steps: [{ type: 'keyTap', key: 'b', gapMs: 0 }] },
  ]);
  await engine.play('A');
  assert.deepEqual(errors, []);
  assert.equal(injector.log.filter((l) => l === 'down b').length, 2);
});

test('« Tester » joue le brouillon fourni, même absent des macros sauvegardées', async () => {
  const { engine, injector } = make([]);
  await engine.play('nouveau', { id: 'nouveau', steps: [{ type: 'keyTap', key: 'z', gapMs: 0 }] });
  assert.ok(injector.log.includes('down z'));
  await assert.rejects(engine.play('absente'), /introuvable/);
});

test('le texte libre passe par la frappe multi-ligne', async () => {
  const { engine, injector } = make([{ id: 'a', enabled: true, steps: [{ type: 'text', value: 'a\nb', gapMs: 0 }] }]);
  await engine.play('a');
  assert.ok(injector.log.includes('lines "a\\nb"'));
});

test('la durée d’appui maintient la touche', async () => {
  const { engine, injector } = make([{ id: 'a', enabled: true, options: { holdMs: 40 },
    steps: [{ type: 'keyTap', key: 'q', gapMs: 0 }] }]);
  const t0 = Date.now();
  await engine.play('a');
  assert.ok(Date.now() - t0 >= 35);
  assert.deepEqual(injector.log.slice(0, 2), ['down q', 'up q']);
});

test('la variation aléatoire reste dans les bornes', () => {
  const { engine } = make([]);
  for (let i = 0; i < 200; i++) {
    const d = engine.duration(100, { speed: 1, jitter: 0.3 });
    assert.ok(d >= 70 && d <= 130, String(d));
  }
  assert.equal(engine.duration(100, { speed: 2, jitter: 0 }), 50);
});

test('les raccourcis refusés sont renvoyés', () => {
  const { conflicts } = make([
    { id: 'a', enabled: true, trigger: { accelerator: 'Ctrl+1' }, steps: [] },
    { id: 'b', enabled: true, trigger: { accelerator: 'Ctrl+1' }, steps: [] },
    { id: 'c', enabled: true, trigger: { accelerator: 'F9' }, steps: [] },
  ], { taken: ['F9'] });
  assert.deepEqual(conflicts.map((c) => c.id), ['b', 'c']);
});

test('l’enregistreur fusionne les frappes et place le curseur avant les clics', () => {
  const { engine } = make([]);
  engine.recording = true;
  engine.recordOpts = { mouse: true, moves: false, clickPositions: true };
  engine.onRecordMouse({ button: 1, x: -300, y: 40 }, 'down');
  engine.onRecordMouse({ button: 1, x: -300, y: 40 }, 'up');
  engine.onRecordWheel({ rotation: 1, direction: 4 });
  const steps = engine.recordBuffer.filter((s) => s.type !== 'delay');
  assert.deepEqual(steps.map((s) => s.type), ['mouseMove', 'mouseDown', 'mouseUp', 'mouseWheel']);
  assert.equal(steps[0].x, -300);
  assert.equal(steps[3].horizontal, true);
  const taps = engine.compressTaps([
    { type: 'keyDown', key: 'a' }, { type: 'delay', ms: 40 }, { type: 'keyUp', key: 'a' },
    { type: 'keyDown', key: 'b' }, { type: 'delay', ms: 600 }, { type: 'keyUp', key: 'b' },
  ]);
  assert.deepEqual(taps.map((s) => s.type), ['keyTap', 'keyDown', 'delay', 'keyUp']);
});

test('étape « Ouvrir » : passe par l’ouvreur, même sans injection de touches', async () => {
  const opened = [];
  const injector = { ...fakeInput(), available: false, loadError: new Error('absente') };
  const engine = new MacroEngine({ globalShortcut: fakeShortcuts(), injector, opener: async (t) => { opened.push(t); } });
  engine.setMacros([
    { id: 'o', enabled: true, steps: [{ type: 'open', target: 'https://example.com', gapMs: 0 }, { type: 'delay', ms: 5 }] },
    { id: 'k', enabled: true, steps: [{ type: 'open', target: 'C:\\x.exe' }, { type: 'loop', count: 1, steps: [{ type: 'keyTap', key: 'a' }] }] },
  ]);
  await engine.play('o');
  assert.deepEqual(opened, ['https://example.com']);
  await assert.rejects(engine.play('k'), /Injection d'entrées indisponible/);
});

test('une erreur d’ouverture arrête la macro avec un message', async () => {
  const { engine, errors } = make([]);
  engine.opener = async () => { throw new Error('introuvable'); };
  await engine.play('x', { id: 'x', steps: [{ type: 'open', target: 'C:\\nope.exe' }, { type: 'keyTap', key: 'a' }] });
  assert.deepEqual(errors, ['introuvable']);
});
