const test = require('node:test');
const assert = require('node:assert');
const { dailyTotals } = require('../src/report');

test('totals per day', () => {
  const events = [
    { at: '2026-03-01T12:00:00Z', amount: 5 },
    { at: '2026-03-01T15:00:00Z', amount: 2.5 },
    { at: '2026-03-02T12:00:00Z', amount: 1 }
  ];
  assert.deepEqual(dailyTotals(events), [
    { day: '2026-03-01', count: 2, amount: 7.5 },
    { day: '2026-03-02', count: 1, amount: 1 }
  ]);
});
