const test = require('node:test');
const assert = require('node:assert/strict');
const { countKeyDay } = require('../src/system/keystats');

test('statistiques : frappes comptées par jour local', () => {
  const days = {};
  countKeyDay(days, new Date(2026, 9, 4, 9, 0));
  countKeyDay(days, new Date(2026, 9, 4, 23, 59));
  countKeyDay(days, new Date(2026, 9, 5, 0, 1));
  assert.deepEqual(days, { '2026-10-04': 2, '2026-10-05': 1 });
});

test('statistiques : les jours de plus de 120 jours sont oubliés', () => {
  const days = { '2026-01-01': 50, '2026-06-10': 7 };
  countKeyDay(days, new Date(2026, 9, 4));
  assert.deepEqual(days, { '2026-06-10': 7, '2026-10-04': 1 });
});

test('statistiques : répartition par heure de la journée', () => {
  const { countKeyHour } = require('../src/system/keystats');
  let hours = countKeyHour(undefined, new Date(2026, 9, 4, 9, 15));
  hours = countKeyHour(hours, new Date(2026, 9, 4, 9, 59));
  hours = countKeyHour(hours, new Date(2026, 9, 4, 23, 0));
  assert.equal(hours.length, 24);
  assert.equal(hours[9], 2);
  assert.equal(hours[23], 1);
  assert.equal(hours.reduce((a, b) => a + b, 0), 3);
});
