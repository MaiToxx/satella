const test = require('node:test');
const assert = require('node:assert/strict');
const { inTimeWindow, toMinutes } = require('../src/system/schedule');

const at = (h, m) => new Date(2026, 9, 3, h, m);

test('plage horaire dans la journée', () => {
  assert.equal(inTimeWindow('09:00', '17:30', at(9, 0)), true);
  assert.equal(inTimeWindow('09:00', '17:30', at(17, 29)), true);
  assert.equal(inTimeWindow('09:00', '17:30', at(17, 30)), false);
  assert.equal(inTimeWindow('09:00', '17:30', at(8, 59)), false);
});

test('plage à cheval sur minuit', () => {
  assert.equal(inTimeWindow('23:00', '07:00', at(23, 30)), true);
  assert.equal(inTimeWindow('23:00', '07:00', at(0, 0)), true);
  assert.equal(inTimeWindow('23:00', '07:00', at(6, 59)), true);
  assert.equal(inTimeWindow('23:00', '07:00', at(7, 0)), false);
  assert.equal(inTimeWindow('23:00', '07:00', at(12, 0)), false);
});

test('valeurs invalides ou plage vide : jamais active', () => {
  assert.equal(inTimeWindow('25:00', '07:00', at(1, 0)), false);
  assert.equal(inTimeWindow('', '07:00', at(1, 0)), false);
  assert.equal(inTimeWindow('08:00', '08:00', at(8, 0)), false);
  assert.equal(toMinutes('7:05'), 425);
  assert.equal(toMinutes('12:60'), null);
});
