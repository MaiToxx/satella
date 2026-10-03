const test = require('node:test');
const assert = require('node:assert/strict');
const locks = require('../src/system/locks');

test('témoins : seules les touches verrouillées sont allumées', () => {
  const white = [255, 255, 255];
  assert.deepEqual(locks.indicatorMap({ capslock: true, numlock: false }, white), { capslock: white });
  assert.deepEqual(locks.indicatorMap({ capslock: true, numlock: true }, white), { capslock: white, numlock: white });
  assert.deepEqual(locks.indicatorMap(null, white), {});
});

test('témoins : lecture sans planter hors Windows', () => {
  if (!locks.available()) assert.equal(locks.read(), null);
  else assert.equal(typeof locks.read().capslock, 'boolean');
});
