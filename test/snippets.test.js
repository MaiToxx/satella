const test = require('node:test');
const assert = require('node:assert/strict');
const { SnippetEngine } = require('../src/macros/snippets');
const { combineDead } = require('../src/system/keyboard-layout');
const { VK } = require('../src/macros/keys');
const { fakeInput } = require('./helpers');

// Disposition AZERTY simulée : quelques touches suffisent
const AZERTY = {
  [VK['2']]: { text: 'é', shift: '2' },
  [VK.lbracket]: { dead: '^', shift: '¨' },
  [VK.e]: { text: 'e', shift: 'E' },
  [VK.a]: { text: 'a', shift: 'A' },
  [VK.f]: { text: 'f', shift: 'F' },
  [VK.t]: { text: 't', shift: 'T' },
  [VK.semicolon]: { text: '$', shift: '£' },
  [VK.comma]: { text: ';', shift: '.' },
  [VK.m]: { text: ',', shift: '?' },
  [VK.space]: { text: ' ' },
  [VK.enter]: { text: '\r' },
  [VK.left]: { text: '' },
};
function azerty(vk, mods) {
  const k = AZERTY[vk];
  if (!k) return { text: '' };
  if (k.dead) return mods.shift ? { dead: k.shift } : { dead: k.dead };
  return { text: mods.shift && k.shift ? k.shift : k.text };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function engineWith(snippets, translate) {
  const typer = fakeInput();
  const e = new SnippetEngine({ translate, combineDead, typer });
  e.setSnippets(snippets.map((s) => ({ enabled: true, ...s })));
  return { e, typer };
}

test('repli QWERTY sans les API Windows', async () => {
  const { e, typer } = engineWith([{ abbr: ';ok', text: 'd’accord' }], () => null);
  for (const k of ['semicolon', 'o', 'k']) e.feed(k);
  await wait(60);
  assert.equal(typer.log.filter((l) => l === 'tap backspace').length, 3);
  assert.ok(typer.log.includes('lines "d’accord"'));
});

test('AZERTY : accents et touches mortes (« ^ » puis « e » = « ê »)', async () => {
  const { e, typer } = engineWith([{ abbr: ';fête', text: 'FÊTE' }], azerty);
  e.feed('comma');    // « ; » est sur la touche virgule en AZERTY
  e.feed('f');
  e.feed('lbracket'); // ^ (touche morte) : rien de tapé pour l'instant
  assert.equal(e.buffer, ';f');
  e.feed('e');        // -> ê
  e.feed('t');
  e.feed('e');
  await wait(60);
  assert.ok(typer.log.includes('lines "FÊTE"'), typer.log.join('|'));
  // ;fête = 5 caractères = 5 retours arrière
  assert.equal(typer.log.filter((l) => l === 'tap backspace').length, 5);
});

test('é tapé directement correspond', async () => {
  const { e, typer } = engineWith([{ abbr: 'éé', text: 'X' }], azerty);
  e.feed('2');
  e.feed('2');
  await wait(60);
  assert.ok(typer.log.includes('lines "X"'));
});

test('un raccourci Ctrl ou une touche de navigation interrompt la saisie', () => {
  const { e } = engineWith([{ abbr: 'zz', text: 'X' }], azerty);
  e.feed('a');
  e.feed('c', { ctrl: true });
  assert.equal(e.buffer, '');
  e.feed('a');
  e.feed('left');
  assert.equal(e.buffer, '');
  e.feed('a');
  e.feed('enter');
  assert.equal(e.buffer, '');
});

test('AltGr (Ctrl + Alt) n’est pas un raccourci', () => {
  const { e } = engineWith([{ abbr: 'zz', text: 'X' }], (vk) => (vk === VK['0'] ? { text: '@' } : { text: '' }));
  e.feed('0', { ctrl: true, alt: true });
  assert.equal(e.buffer, '@');
});

test('retour arrière, modificateurs seuls et remise à zéro', () => {
  const { e } = engineWith([{ abbr: 'zz', text: 'X' }], azerty);
  e.feed('a');
  e.feed('2');
  e.feed('lshift');
  assert.equal(e.buffer, 'aé');
  e.feed('backspace');
  assert.equal(e.buffer, 'a');
  e.reset();
  assert.equal(e.buffer, '');
});

test('combinaison des touches mortes', () => {
  assert.equal(combineDead('^', 'e'), 'ê');
  assert.equal(combineDead('¨', 'i'), 'ï');
  assert.equal(combineDead('^', ' '), '^');
  assert.equal(combineDead('^', 'z'), '^z');
});

test('les abréviations trop courtes ou désactivées sont ignorées', () => {
  const { e } = engineWith([{ abbr: 'a', text: 'X' }, { abbr: 'bb', text: 'Y', enabled: false }], azerty);
  assert.equal(e.active, false);
});

test('abréviation avec variables : presse-papiers et curseur', async () => {
  const typer = fakeInput();
  const e = new SnippetEngine({ translate: () => null, combineDead, typer, clipboardRead: () => 'lien' });
  e.setSnippets([{ enabled: true, abbr: ';a', text: '<a href="{presse-papiers}">{curseur}</a>' }]);
  e.feed('semicolon');
  e.feed('a');
  await wait(60);
  assert.ok(typer.log.includes('lines "<a href=\\"lien\\"></a>"'), typer.log.join('|'));
  assert.equal(typer.log.filter((l) => l === 'tap left').length, 4);
});
