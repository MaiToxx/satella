const test = require('node:test');
const assert = require('node:assert/strict');
const { DirectBackend, isStreamed } = require('../src/led/direct');

// Clavier EVision simulé : accuse réception de chaque paquet
function fakeKeyboard({ failAfter = Infinity } = {}) {
  const packets = [];
  let last = null;
  return {
    packets,
    write(buf) {
      if (packets.length >= failAfter) throw new Error('débranché');
      packets.push([...buf]);
      last = [...buf];
    },
    readTimeout() {
      if (!last) return [];
      const resp = last.slice();
      resp[7] = 0;
      if (resp[3] === 0x03) { resp[8] = 0xaa; resp[9] = 0x55; resp[13] = 128; resp[4] = 7; }
      last = null;
      return resp;
    },
    close() {},
    on() {},
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('quels états passent par le flux temps réel', () => {
  assert.equal(isStreamed({ effect: 'fire' }), true);
  assert.equal(isStreamed({ effect: 'audio' }), true);
  assert.equal(isStreamed({ effect: 'wave', overlay: {} }), false);
  assert.equal(isStreamed({ effect: 'wave', overlay: { w: '#fff' } }), true);
  assert.equal(isStreamed({ effect: 'static', overlay: { w: '#fff' } }), false);
});

test('paquets EVision : somme de contrôle sur les octets 3 à 63', () => {
  const d = new DirectBackend();
  d.kb = fakeKeyboard();
  d.kbQuery(0x06, 0x41, 2, [0x14, 0x04]);
  const p = d.kb.packets.at(-1);
  let sum = 0;
  for (let i = 3; i < 64; i++) sum = (sum + p[i]) & 0xffff;
  assert.equal(p[1] | (p[2] << 8), sum);
  assert.equal(p[0], 0x04);
});

test('statique + calque : le calque rejoint les couleurs par touche', async () => {
  const d = new DirectBackend();
  d.kb = fakeKeyboard();
  d.kbMapSize = 128;
  d.applyKeyboard({ effect: 'static', baseColor: '#000000', speed: 50, brightness: 100,
    direction: 'lr', colors: {}, overlay: { esc: '#ff0000' } });
  await wait(300);
  // Écriture du jeu de couleurs personnalisé (commande 0x0b), emplacement 0 = Échap
  const custom = d.kb.packets.filter((p) => p[3] === 0x0b);
  assert.ok(custom.length > 0, 'jeu de couleurs écrit');
  assert.deepEqual(custom[0].slice(8, 11), [255, 0, 0]);
});

test('un état identique n’est pas réécrit, sauf après une perte du clavier', async () => {
  const d = new DirectBackend();
  const state = { effect: 'breathing', baseColor: '#00ff00', speed: 50, brightness: 100, direction: 'lr', colors: {} };
  d.kb = fakeKeyboard();
  d.applyKeyboard(state);
  await wait(300);
  const n = d.kb.packets.length;
  assert.ok(n > 0);
  d.applyKeyboard(state);
  await wait(300);
  assert.equal(d.kb.packets.length, n, 'pas de réécriture');
  d.dropKeyboard();
  d.kb = fakeKeyboard();
  d.applyKeyboard(state);
  await wait(300);
  assert.ok(d.kb.packets.length > 0, 'réécrit après reconnexion');
});

test('une écriture ratée est retentée à la reconnexion', async () => {
  const d = new DirectBackend();
  const logs = [];
  d.on('log', (m) => logs.push(m));
  const state = { effect: 'breathing', baseColor: '#0000ff', speed: 50, brightness: 100, direction: 'lr', colors: {} };
  d.kb = fakeKeyboard({ failAfter: 1 });
  d.applyKeyboard(state);
  await wait(300);
  assert.equal(d.kb, null, 'clavier abandonné après l’échec');
  assert.ok(logs.some((l) => l.includes('Erreur écriture clavier')));
  d.kb = fakeKeyboard();
  d.applyKeyboard(state);
  await wait(300);
  assert.ok(d.kb.packets.length > 0);
});
