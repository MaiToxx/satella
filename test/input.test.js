const test = require('node:test');
const assert = require('node:assert/strict');
const { splitText, normalizeAbsolute } = require('../src/macros/input');

test('le texte libre est découpé en texte, Entrée et Tab', () => {
  assert.deepEqual(splitText('Bonjour\nà tous\r\n\tfin'), [
    { text: 'Bonjour' }, { key: 'enter' }, { text: 'à tous' }, { key: 'enter' }, { key: 'tab' }, { text: 'fin' },
  ]);
  assert.deepEqual(splitText(''), []);
  assert.deepEqual(splitText(null), []);
});

test('coordonnées absolues sur le bureau virtuel (écran à gauche du principal)', () => {
  // Deux écrans 1920x1080 : un à gauche (x de -1920 à -1), le principal à droite
  const desk = { x: -1920, y: 0, w: 3840, h: 1080 };
  assert.deepEqual(normalizeAbsolute(-1920, 0, desk), { dx: 0, dy: 0 });
  assert.deepEqual(normalizeAbsolute(1919, 1079, desk), { dx: 65535, dy: 65535 });
  const mid = normalizeAbsolute(0, 540, desk);
  assert.ok(Math.abs(mid.dx - 32776) < 20, String(mid.dx));
  // Hors écran : borné
  assert.deepEqual(normalizeAbsolute(99999, -50, desk), { dx: 65535, dy: 0 });
});
