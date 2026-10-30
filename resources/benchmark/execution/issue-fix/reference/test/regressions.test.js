const test = require('node:test');
const assert = require('node:assert');
const { dailyTotals } = require('../src/report');

test('UTC day after midnight', () => {
  assert.equal(dailyTotals([{ at: '2026-03-02T00:30:00Z', amount: 1 }])[0].day, '2026-03-02');
});

test('cents are exact', () => {
  assert.equal(dailyTotals([{ at: '2026-03-01T12:00:00Z', amount: 0.1 }, { at: '2026-03-01T12:00:00Z', amount: 0.2 }])[0].amount, 0.3);
});

test('bad timestamps are skipped', () => {
  assert.deepEqual(dailyTotals([{ at: 'nope', amount: 1 }]), []);
});
