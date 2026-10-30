// Runs with TZ=America/Toronto, where midnight UTC is still the previous local day.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { dailyTotals } = require('../src/report');
const { dayKey } = require('../src/days');

test('a sale just after midnight UTC counts on that UTC day', () => {
  assert.deepEqual(dailyTotals([{ at: '2026-03-02T00:30:00Z', amount: 4 }]), [{ day: '2026-03-02', count: 1, amount: 4 }]);
});

test('a sale just before midnight UTC stays on its day', () => {
  assert.deepEqual(dailyTotals([{ at: '2026-03-01T23:30:00Z', amount: 4 }]).map((row) => row.day), ['2026-03-01']);
});

test('dayKey gives the UTC calendar day', () => {
  assert.equal(dayKey('2026-07-01T02:00:00Z'), '2026-07-01');
});

test('totals are exact to the cent', () => {
  const [row] = dailyTotals([{ at: '2026-03-01T12:00:00Z', amount: 0.1 }, { at: '2026-03-01T13:00:00Z', amount: 0.2 }]);
  assert.equal(row.amount, 0.3);
});

test('many small amounts still total exactly', () => {
  const events = Array.from({ length: 3 }, () => ({ at: '2026-03-01T12:00:00Z', amount: 19.99 }));
  assert.equal(dailyTotals(events)[0].amount, 59.97);
});

test('records without a valid timestamp are left out', () => {
  const rows = dailyTotals([{ at: 'not a date', amount: 1 }, { amount: 2 }, { at: '2026-03-01T12:00:00Z', amount: 3 }]);
  assert.deepEqual(rows, [{ day: '2026-03-01', count: 1, amount: 3 }]);
});

test('days stay in order across a month boundary', () => {
  const rows = dailyTotals([{ at: '2026-04-01T00:10:00Z', amount: 1 }, { at: '2026-03-31T23:50:00Z', amount: 1 }]);
  assert.deepEqual(rows.map((row) => row.day), ['2026-03-31', '2026-04-01']);
});

test('regression tests were added', () => {
  const dir = path.join(__dirname, '..', 'test');
  const count = fs.readdirSync(dir).filter((name) => name.endsWith('.js')).map((name) => (fs.readFileSync(path.join(dir, name), 'utf8').match(/\btest\(/g) || []).length).reduce((sum, value) => sum + value, 0);
  assert.ok(count >= 3, 'found ' + count + ' tests; the original file has 1');
});
