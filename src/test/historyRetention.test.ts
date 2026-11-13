import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { clampLiveConversations, LIVE_CONVERSATIONS_DEFAULT, LIVE_CONVERSATIONS_MAX, LIVE_CONVERSATIONS_MIN, rankThreads } from '../domain/state/retention';

// Phase 27, plan 07 (SYNC-01, D-08): which threads stay live is derived from data, so every editor places and lists them the same way.

const threads = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `conv-t-${String(index + 1).padStart(3, '0')}`, lastUsedAt: new Date(Date.UTC(2026, 10, 1, 0, index + 1)).toISOString() }));

test('five of eight threads are live: the five most recently used, in rank order', () => {
  const ranked = rankThreads(threads(8), 5, []);
  assert.deepEqual(ranked.live, ['conv-t-008', 'conv-t-007', 'conv-t-006', 'conv-t-005', 'conv-t-004']);
  assert.deepEqual(ranked.archive, ['conv-t-003', 'conv-t-002', 'conv-t-001']);
});

test('an open or running old thread is live in addition to the count, and an id that is not a thread is ignored', () => {
  const ranked = rankThreads(threads(8), 5, ['conv-t-001', 'conv-t-999']);
  assert.equal(ranked.live.length, 6);
  assert.ok(ranked.live.includes('conv-t-001'));
  assert.deepEqual(ranked.archive, ['conv-t-003', 'conv-t-002']);
});

test('threads used at the same moment rank by id ascending, whatever order they arrive in', () => {
  const at = '2026-11-01T00:00:00.000Z';
  const same = ['conv-c', 'conv-a', 'conv-e', 'conv-b', 'conv-d'].map((id) => ({ id: `${id}-same`, lastUsedAt: at }));
  const forward = rankThreads(same, 3, []);
  const backward = rankThreads([...same].reverse(), 3, []);
  assert.deepEqual(forward, backward);
  assert.deepEqual(forward.live, ['conv-a-same', 'conv-b-same', 'conv-c-same']);
  assert.deepEqual(forward.archive, ['conv-d-same', 'conv-e-same']);
});

test('lowering the count from 5 to 2 moves three threads to the archive and raising it back to 5 restores them', () => {
  const all = threads(8);
  const five = rankThreads(all, 5, []);
  const two = rankThreads(all, 2, []);
  assert.deepEqual(two.live, five.live.slice(0, 2));
  assert.deepEqual(two.archive.filter((id) => five.live.includes(id)), five.live.slice(2));
  assert.deepEqual(rankThreads(all, 5, []), five);
});

test('more than fifty threads are all placed: the rule only splits them, it never drops one', () => {
  const ranked = rankThreads(threads(120), 50, []);
  assert.equal(ranked.live.length, 50);
  assert.equal(ranked.archive.length, 70);
  assert.equal(new Set([...ranked.live, ...ranked.archive]).size, 120);
});

test('the live count is a whole number from 1 to 50, and the default for anything that is not a number', () => {
  assert.equal(clampLiveConversations(0), 1);
  assert.equal(clampLiveConversations(-7), 1);
  assert.equal(clampLiveConversations(500), 50);
  assert.equal(clampLiveConversations(2.9), 2);
  assert.equal(clampLiveConversations('x'), 5);
  assert.equal(clampLiveConversations(undefined), 5);
  assert.equal(clampLiveConversations(Number.NaN), 5);
  assert.equal(clampLiveConversations(Infinity), 5);
  assert.equal(clampLiveConversations(12), 12);
});

test('the default, minimum and maximum equal what package.json declares for nearAi.history.liveConversations', () => {
  const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const declared = pkg.contributes.configuration.properties['nearAi.history.liveConversations'];
  assert.deepEqual([LIVE_CONVERSATIONS_DEFAULT, LIVE_CONVERSATIONS_MIN, LIVE_CONVERSATIONS_MAX], [declared.default, declared.minimum, declared.maximum]);
});

test('settings reads the live count through the clamp, from nearAi.history.liveConversations', () => {
  const source = readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'settings.ts'), 'utf8');
  const reader = source.slice(source.indexOf('export function readHistoryLimits'));
  assert.ok(source.includes('export function readHistoryLimits'), 'readHistoryLimits exists');
  assert.match(reader, /history\.liveConversations/);
  assert.match(reader, /clampLiveConversations\(/);
});
