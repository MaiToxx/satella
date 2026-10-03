const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'satella-store-'));

test('lecture, écriture et cache isolé', () => {
  const s = new Store(tmp());
  assert.deepEqual(s.read('macros', []), []);
  s.write('macros', [{ id: 'a' }]);
  const copy = s.read('macros', []);
  copy.push({ id: 'b' });
  assert.equal(s.read('macros', []).length, 1, 'modifier une lecture ne touche pas au cache');
  assert.deepEqual(new Store(s.dir).read('macros', []), [{ id: 'a' }]);
});

test('un fichier corrompu est mis de côté et la copie .bak prend le relais', () => {
  const dir = tmp();
  const logs = [];
  const s = new Store(dir, { log: (m) => logs.push(m) });
  s.write('profiles', [{ name: 'v1' }]);
  s.write('profiles', [{ name: 'v2' }]); // v1 part en .bak
  fs.writeFileSync(path.join(dir, 'profiles.json'), '{ cassé');
  const fresh = new Store(dir, { log: (m) => logs.push(m) });
  assert.deepEqual(fresh.read('profiles', []), [{ name: 'v1' }]);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('profiles.corrupt-')), 'fichier mis de côté');
  assert.ok(logs.length >= 1);
});

test('écriture différée regroupée, vidée à la fermeture', async () => {
  const dir = tmp();
  const s = new Store(dir);
  s.writeLater('led-state', { n: 1 }, 50);
  s.writeLater('led-state', { n: 2 }, 50);
  assert.deepEqual(s.read('led-state', null), { n: 2 }, 'lecture immédiate depuis le cache');
  assert.equal(fs.existsSync(path.join(dir, 'led-state.json')), false);
  s.flush();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'led-state.json'), 'utf8')), { n: 2 });
});
