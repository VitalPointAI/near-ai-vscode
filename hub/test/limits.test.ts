import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BLOB_MAX_BYTES, HEADER_MAX_BYTES, INLINE_BODY_MAX_BYTES, SEALED_OVERHEAD } from '@ext/domain/replica/entry';
import { checkBatch } from '../src/append/checks';
import { RosterCache } from '../src/append/rosterCache';
import { enrolProject, issueHubFile } from '../src/enrol';
import { LIMITS, RateLimits, TokenBucket } from '../src/limits';
import { openHubStore } from '../src/store/hubStore';
import { NOW_MS, WORLD_NOW, createHubWorld, makeHubIdentity } from './helpers/hubWorld';

// Phase 32, plan 19 (D-37, D-38, D-39; 32-RESEARCH.md Pitfall 7): the hub's limits. Buckets take the time from the caller, so these tests move time
// by hand and nothing sleeps. A flood is turned away before any signature is checked.

const T0 = 1_800_000_000_000;
const SECOND = 1000;
const MINUTE = 60 * SECOND;

test('LIMITS holds the D-37, D-38 and D-39 sizes and rates', () => {
  assert.equal(LIMITS.headerBytes, 4096);
  assert.equal(LIMITS.headerBytes, HEADER_MAX_BYTES);
  assert.equal(LIMITS.inlineBodyBytes, 16 * 1024 + SEALED_OVERHEAD);
  assert.equal(LIMITS.inlineBodyBytes, INLINE_BODY_MAX_BYTES + SEALED_OVERHEAD);
  assert.equal(LIMITS.blobBytes, 8 * 1024 * 1024);
  assert.equal(LIMITS.blobBytes, BLOB_MAX_BYTES);
  assert.equal(LIMITS.appendEntries, 200);
  assert.equal(LIMITS.appendGrants, 64);
  assert.equal(LIMITS.appendBodyBytes, 4 * 1024 * 1024);
  assert.equal(LIMITS.catchUpEntries, 1000);
  assert.equal(LIMITS.catchUpBytes, 4 * 1024 * 1024);
  assert.equal(LIMITS.smallBodyBytes, 64 * 1024);
  assert.equal(LIMITS.enrolBodyBytes, 4 * 1024 * 1024);
  assert.equal(LIMITS.pendingBlobBytesPerUploader, 256 * 1024 * 1024);
  assert.equal(LIMITS.eventStreamsPerDevice, 4);
  assert.equal(LIMITS.eventStreamsPerAddress, 300);
  assert.equal(LIMITS.sessionCallsPerSession, 2);
  assert.equal(LIMITS.presenceBytes, 2 * 1024);
  assert.deepEqual([LIMITS.writerPerSecond, LIMITS.writerBurst, LIMITS.sessionPerMinute, LIMITS.joinPerMinute, LIMITS.enrolPerMinute], [50, 200, 120, 10, 10]);
  assert.equal(Object.isFrozen(LIMITS), true);
});

test('a writer bucket passes a burst of 200, refuses the 201st with Retry-After 1, and gives 50 more after one second', () => {
  const bucket = new TokenBucket(LIMITS.writerBurst, LIMITS.writerPerSecond, T0);
  for (let index = 0; index < 200; index += 1) assert.deepEqual(bucket.take(T0), { ok: true }, `take ${index + 1}`);
  assert.deepEqual(bucket.take(T0), { ok: false, retryAfterSeconds: 1 });
  for (let index = 0; index < 50; index += 1) assert.deepEqual(bucket.take(T0 + SECOND), { ok: true }, `take ${index + 1} after a second`);
  assert.equal(bucket.take(T0 + SECOND).ok, false);
  // Taking many at once is all or nothing, and the wait covers the whole count; more than the capacity needs a full bucket.
  assert.deepEqual(bucket.take(T0 + SECOND, 100), { ok: false, retryAfterSeconds: 2 });
  assert.deepEqual(bucket.take(T0 + SECOND, 264), { ok: false, retryAfterSeconds: 4 });
  assert.deepEqual(bucket.take(T0 + 5 * SECOND, 264), { ok: true });
  assert.equal(bucket.take(T0 + 5 * SECOND).ok, false);
  // A clock that goes back refills nothing.
  assert.equal(bucket.take(T0).ok, false);
});

test('join and enrol: 10 calls a minute per address pass, the 11th waits at most a minute; other addresses are not touched', () => {
  for (const call of ['join', 'enrol'] as const) {
    const limits = new RateLimits();
    for (let index = 0; index < 10; index += 1) assert.equal(limits.takeAddress(call, '203.0.113.7', T0 + index).ok, true);
    const refused = limits.takeAddress(call, '203.0.113.7', T0 + 10);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.ok(refused.retryAfterSeconds >= 1 && refused.retryAfterSeconds <= 60, `${call} waits ${refused.retryAfterSeconds}`);
    assert.equal(limits.takeAddress(call, '198.51.100.20', T0 + 10).ok, true);
    // After the wait the address may call again.
    assert.equal(limits.takeAddress(call, '203.0.113.7', T0 + 10 + (refused.ok ? 0 : refused.retryAfterSeconds) * SECOND).ok, true);
  }
});

test('session: 240 calls (120 sessions of two calls) a minute per address pass and the 241st is refused, because a whole site may sit behind one address', () => {
  const limits = new RateLimits();
  for (let index = 0; index < 240; index += 1) assert.equal(limits.takeAddress('session', '203.0.113.7', T0).ok, true, `call ${index + 1}`);
  const refused = limits.takeAddress('session', '203.0.113.7', T0);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.retryAfterSeconds, 1);
  assert.equal(limits.takeAddress('session', '203.0.113.7', T0 + MINUTE).ok, true);
});

test('a site behind one address opens 120 sessions a minute: both calls of a session (challenge and answer) fit in the bucket', () => {
  const limits = new RateLimits();
  for (let session = 0; session < 120; session += 1) {
    assert.equal(limits.takeAddress('session', '203.0.113.7', T0).ok, true, `challenge of session ${session + 1}`);
    assert.equal(limits.takeAddress('session', '203.0.113.7', T0).ok, true, `answer of session ${session + 1}`);
  }
  const refused = limits.takeAddress('session', '203.0.113.7', T0);
  assert.equal(refused.ok, false, 'the 121st session in a minute was not refused');
  assert.equal(limits.takeAddress('session', '198.51.100.20', T0).ok, true);
});

test('bucket maps never pass their cap: a flood of addresses and writers keeps at most maxTracked buckets', () => {
  const limits = new RateLimits({ maxTracked: 50 });
  for (let index = 0; index < 5000; index += 1) {
    limits.takeAddress('join', `address-${index}`, T0 + index);
    limits.takeAddress('session', `address-${index}`, T0 + index);
    limits.takeWriter(`writer-${index}`, 200, T0 + index);
  }
  const tracked = limits.tracked();
  assert.ok(tracked.join <= 50 && tracked.session <= 50 && tracked.writers <= 50, JSON.stringify(tracked));
  assert.equal(tracked.enrol, 0);
});

test('past the cap the least recently used idle bucket goes first, so a busy device keeps its debt', () => {
  const limits = new RateLimits({ maxTracked: 2 });
  assert.equal(limits.takeWriter('busy', 200, T0).ok, true);
  assert.equal(limits.takeWriter('idle', 1, T0).ok, true);
  // A second later the idle bucket is full again; the busy one has 50 of 200. A new writer drops the idle bucket, not the older busy one.
  assert.equal(limits.takeWriter('new', 1, T0 + SECOND).ok, true);
  assert.equal(limits.tracked().writers, 2);
  assert.equal(limits.takeWriter('busy', 51, T0 + SECOND).ok, false);
});

test('a batch over the pushing device\'s bucket is refused rate-limited as a whole before any signature is checked', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-hub-limits-'));
  const store = await openHubStore(dir);
  try {
    const identity = makeHubIdentity();
    const world = createHubWorld();
    world.admitHub(identity);
    const issued = issueHubFile(store, identity, { days: 7, now: new Date(WORLD_NOW) });
    if (!issued.ok) throw new Error(issued.message);
    const enrolled = await enrolProject({ store, identity, now: new Date(WORLD_NOW) }, world.enrolRequest(issued.file.payload));
    assert.equal(enrolled.ok, true);
    const cache = new RosterCache(store, identity);
    const limits = new RateLimits({ writerBurst: 3, writerPerSecond: 1 });
    let calls = 0;
    const verify = (): boolean => { calls += 1; return true; };
    const entries = Array.from({ length: 4 }, (_, index) => world.write(world.lead, { kind: 'note.add', data: { text: `Fictional note ${index}` } }).entry);
    // Within the bucket the device's batch is checked, and each entry's signature is.
    const within = await checkBatch({ project: world.project, device: world.lead.writer, entries: entries.slice(0, 3) }, { store, cache, limits, now: NOW_MS, verify });
    assert.equal(within.ok, true);
    assert.equal(calls, 3);
    // The bucket is empty: the next batch is refused as a whole and no signature is checked.
    calls = 0;
    const before = store.headOf(world.project, world.project, world.lead.writer);
    const refused = await checkBatch({ project: world.project, device: world.lead.writer, entries: entries.slice(3) }, { store, cache, limits, now: NOW_MS, verify });
    assert.deepEqual(refused.ok ? 'ok' : [refused.reason, refused.retryAfterSeconds], ['rate-limited', 1]);
    assert.equal(calls, 0);
    assert.deepEqual(store.headOf(world.project, world.project, world.lead.writer), before);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
