// RecentMap: the bounded memory behind what a Team Mode session has already reported.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_RECENT_LIMIT, RecentMap } from '../domain/team/recentMap';

test('a RecentMap keeps only its most recent entries and counts what it let go', () => {
  const recent = new RecentMap<number>(3);
  for (let index = 0; index < 5; index += 1) recent.set(`k${index}`, index);
  assert.equal(recent.size, 3);
  assert.equal(recent.dropped, 2);
  assert.deepEqual(['k0', 'k1', 'k2', 'k3', 'k4'].map((key) => recent.has(key)), [false, false, true, true, true]);
});

test('a lookup or a set of a known key makes it recent again, and setting it never counts as a drop', () => {
  const recent = new RecentMap<string>(2);
  recent.set('a', '1');
  recent.set('b', '2');
  assert.equal(recent.get('a'), '1', 'a lookup refreshes a');
  recent.set('c', '3');
  assert.equal(recent.has('b'), false, 'b was the oldest');
  assert.equal(recent.has('a'), true);
  recent.set('a', '1b');
  assert.equal(recent.dropped, 1);
  assert.equal(recent.get('a'), '1b');
  assert.equal(recent.delete('a'), true);
  assert.equal(recent.size, 1);
});

test('the default bound is 500 and a bad limit is refused', () => {
  assert.equal(DEFAULT_RECENT_LIMIT, 500);
  const recent = new RecentMap<true>();
  for (let index = 0; index < 600; index += 1) recent.set(String(index), true);
  assert.equal(recent.size, 500);
  assert.equal(recent.dropped, 100);
  assert.equal(recent.has('99'), false);
  assert.equal(recent.has('100'), true);
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.throws(() => new RecentMap<true>(bad));
});
