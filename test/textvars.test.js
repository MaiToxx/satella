const test = require('node:test');
const assert = require('node:assert/strict');
const { expand } = require('../src/shared/textvars');

const now = new Date(2026, 9, 3, 14, 5);

test('variables : date, heure, jour, mois, année ; inconnues laissées telles quelles', () => {
  assert.deepEqual(expand('Le {date} à {heure}, {jour} {mois} {annee} {inconnue}', { now }),
    { text: 'Le 03/10/2026 à 14:05, samedi octobre 2026 {inconnue}', back: 0 });
  assert.deepEqual(expand('sans variable', { now }), { text: 'sans variable', back: 0 });
  assert.equal(expand('{DATE}', { now }).text, '03/10/2026');
});

test('variables : presse-papiers lu seulement si utilisé', () => {
  let reads = 0;
  const clipboard = () => { reads++; return 'copié'; };
  assert.equal(expand('{date}', { now, clipboard }).text, '03/10/2026');
  assert.equal(reads, 0);
  assert.equal(expand('[{presse-papiers}] [{presse-papiers}]', { now, clipboard }).text, '[copié] [copié]');
  assert.equal(reads, 1);
});

test('variables : {curseur} indique combien de fois revenir à gauche', () => {
  assert.deepEqual(expand('<b>{curseur}</b>', { now }), { text: '<b></b>', back: 4 });
  assert.deepEqual(expand('a{curseur}é\r\nb', { now }), { text: 'aé\r\nb', back: 3 });
  assert.deepEqual(expand('{curseur}x{curseur}y', { now }), { text: 'xy', back: 2 }, 'seul le premier compte');
});
