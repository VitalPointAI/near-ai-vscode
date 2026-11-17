// The host's time never goes backwards (PR #70 third review): a policy that has expired stays expired when the clock is set back while the window is open,
// and the latest time the host has seen starts from the clock marker in secret storage. Real files in temp folders and an in-memory secret store.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BUNDLE_FAILURES, SELF_SIGNED_LIFETIME_DAYS } from '../domain/gate/bundle';
import type { BundleState } from '../domain/gate/bundle';
import { readLastValid } from '../gate/clockMarker';
import { GateHost } from '../gate/host';
import { MemorySecrets } from './helpers/teamHarness';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-06-01T12:00:00.000Z');

async function withHost<T>(work: (made: { host: GateHost; secrets: MemorySecrets; setNow: (ms: number) => void; storage: string }) => Promise<T>, seed?: (secrets: MemorySecrets) => Promise<void>): Promise<T> {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-hostclock-'));
  try {
    let nowMs = T0;
    const secrets = new MemorySecrets();
    await seed?.(secrets);
    const host = new GateHost({ globalStorageDir: storage, secrets, productVersion: '0.0.0-test', now: () => new Date(nowMs) });
    try {
      return await work({ host, secrets, setNow: (ms) => { nowMs = ms; }, storage });
    } finally {
      await host.flush();
    }
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
}

function reasonOf(state: BundleState): string | undefined {
  return state.state === 'failed-closed' ? state.reason : undefined;
}

test('a policy that has expired stays expired when the clock is set back, for the host, a run\'s runtime and the host\'s own time', async () => {
  await withHost(async ({ host, setNow }) => {
    assert.equal((await host.start()).state, 'valid');
    const runtime = await host.runtimeFor({ actor: { kind: 'agent', sessionId: 's' }, presence: 'person', context: 'interactive' });
    const expired = T0 + (SELF_SIGNED_LIFETIME_DAYS + 1) * DAY;
    setNow(expired);
    assert.equal(reasonOf(host.bundleState()), 'expired');
    // The window is still open and the clock is moved back to a time when the policy was valid.
    setNow(T0 + 10 * DAY);
    const state = host.bundleState();
    assert.equal(reasonOf(state), 'expired', 'the host does not read an expired policy as valid again');
    assert.equal(state.state === 'failed-closed' ? state.sentence : '', BUNDLE_FAILURES.expired);
    assert.equal(reasonOf(runtime.bundleState()), 'expired', 'a run that began earlier is refused too');
    assert.equal(host.now(), expired, 'the time every check reads is the latest time seen');
    assert.equal(runtime.clock?.(), expired);
  });
});

test('the latest time seen never decreases, and a clock that gives no number leaves it where it was', async () => {
  await withHost(async ({ host, setNow }) => {
    await host.start();
    const seen: number[] = [];
    for (const ms of [T0 + 5 * DAY, T0 + 2 * DAY, T0 + 9 * DAY, T0 + 9 * DAY - 1, Number.NaN, T0 + 1]) {
      setNow(ms);
      seen.push(host.now());
    }
    assert.deepEqual(seen, [T0 + 5 * DAY, T0 + 5 * DAY, T0 + 9 * DAY, T0 + 9 * DAY, T0 + 9 * DAY, T0 + 9 * DAY]);
    for (let index = 1; index < seen.length; index += 1) assert.ok((seen[index] as number) >= (seen[index - 1] as number));
  });
});

test('the latest time seen starts from the marker: a window opened with the clock set back still reads the time the install last saw', async () => {
  const laterAt = T0 + 40 * DAY;
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-hostclock-'));
  try {
    const secrets = new MemorySecrets();
    // One window starts when the clock reads a later time, so the marker holds it.
    const first = new GateHost({ globalStorageDir: storage, secrets, productVersion: '0.0.0-test', now: () => new Date(laterAt) });
    assert.equal((await first.start()).state, 'valid');
    const marker = await readLastValid(secrets);
    assert.equal(marker.present && marker.at, laterAt);

    // The next window opens with the clock reading an earlier time.
    let nowMs = T0;
    const second = new GateHost({ globalStorageDir: storage, secrets, productVersion: '0.0.0-test', now: () => new Date(nowMs) });
    assert.equal((await second.start()).state, 'valid');
    assert.equal(second.now(), laterAt, 'seeded from the marker, not from the clock');
    nowMs = T0 - DAY;
    assert.equal(second.now(), laterAt);
    nowMs = laterAt + DAY;
    assert.equal(second.now(), laterAt + DAY, 'and it moves forward with the clock');
    await Promise.all([first.flush(), second.flush()]);
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});

test('a start that cannot read the marker still starts the high-water mark from the clock', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-hostclock-'));
  try {
    const secrets = new MemorySecrets();
    secrets.get = async () => { throw new Error('keyring refused'); };
    const host = new GateHost({ globalStorageDir: storage, secrets, productVersion: '0.0.0-test', now: () => new Date(T0) });
    assert.equal((await host.start()).state, 'failed-closed');
    assert.equal(host.now(), T0);
    await host.flush();
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});
