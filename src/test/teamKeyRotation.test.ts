// Rotating and revoking the person's own key as signed history records (D-09, D-21, TMR-05). All key material is generated at run time.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { signPayload, verifyPayload } from '../domain/team/signedPayload';
import type { SecretStorageLike } from '../services/auth';
import type { PayloadVerdict } from '../domain/team/signedPayload';
import {
  DEVICE_KEY_SECRET, PENDING_DEVICE_KEY_SECRET, PREVIOUS_DEVICE_KEY_SECRET, commitDeviceRotation, forgetPreviousDeviceIdentity, identityDir,
  loadDeviceIdentity, loadOrCreateDeviceIdentity, loadPreviousDeviceIdentity, prepareDeviceRotation, revokeDeviceKey
} from '../team/identity';
import type { DeviceIdentity } from '../team/identity';
import { KEY_HISTORY_FILE, KEY_HISTORY_HEAD_SECRET, localKeyStatus, readKeyHistory } from '../team/keyHistory';
import { identityKeyNeedles, scanFiles } from './helpers/teamCanary';
import type { Needle } from './helpers/teamCanary';
import { createVscodeStub, installVscodeStub } from './helpers/vscodeStub';
import { MemorySecrets } from './helpers/teamHarness';

const T0 = new Date('2026-03-01T10:00:00.000Z');
const T1 = new Date('2026-03-02T10:00:00.000Z');
const T2 = new Date('2026-03-03T10:00:00.000Z');
const T3 = new Date('2026-03-04T10:00:00.000Z');

async function withFolder<T>(work: (folder: string, secrets: MemorySecrets) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-rotation-'));
  try {
    return await work(identityDir(dir), new MemorySecrets());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function bundleBy(identity: DeviceIdentity, at: Date): ReturnType<typeof signPayload> {
  return signPayload(identity, 'policy-bundle', { rules: [{ name: 'review-before-merge', required: true }] }, { now: () => at });
}

async function verdictOf(folder: string, secrets: MemorySecrets, bundle: unknown): Promise<PayloadVerdict> {
  return verifyPayload(bundle, { purpose: 'policy-bundle', status: await localKeyStatus(folder, secrets) });
}

test('tracer: a rotated key honours earlier payloads, refuses later ones from the old key and trusts the new key', async () => {
  await withFolder(async (folder, secrets) => {
    const { identity: first, created } = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder, now: () => T0 });
    assert.equal(created, true);
    const bundleA = bundleBy(first, T0);

    const prepared = await prepareDeviceRotation(secrets, { identityDir: folder, now: () => T0 });
    assert.equal(prepared.current.fingerprint, first.fingerprint);
    assert.notEqual(prepared.next.fingerprint, first.fingerprint);
    assert.equal((await loadDeviceIdentity(secrets))?.fingerprint, first.fingerprint, 'preparing changes nothing the person signs with');
    assert.equal(secrets.values.has(PENDING_DEVICE_KEY_SECRET), true);

    const committed = await commitDeviceRotation(secrets, { identityDir: folder, now: () => T1 });
    assert.equal(committed.previous.fingerprint, first.fingerprint);
    assert.equal(committed.current.fingerprint, prepared.next.fingerprint);
    assert.equal((await loadDeviceIdentity(secrets))?.fingerprint, prepared.next.fingerprint);
    assert.equal((await loadPreviousDeviceIdentity(secrets))?.fingerprint, first.fingerprint);
    assert.equal(secrets.values.has(PENDING_DEVICE_KEY_SECRET), false, 'the pending entry is gone after the commit');

    assert.equal((await verdictOf(folder, secrets, bundleA)).ok, true, 'a payload signed before the rotation still verifies');
    const afterByOld = await verdictOf(folder, secrets, bundleBy(first, T2));
    assert.equal(afterByOld.ok, false);
    if (!afterByOld.ok) {
      assert.equal(afterByOld.reason, 'key-rotated');
      assert.match(afterByOld.message, /revoking/i, 'the text points to revocation, not to rotation, as the way to stop a copy');
    }
    assert.equal((await verdictOf(folder, secrets, bundleBy(committed.current, T2))).ok, true, 'the new key verifies');
  });
});

interface HistoryShape { records: Array<{ payload: { kind: string; key: { fingerprint: string }; next?: { fingerprint: string } }; signer: { fingerprint: string } }> }

async function historyOf(folder: string): Promise<HistoryShape> {
  return JSON.parse(await readFile(path.join(folder, KEY_HISTORY_FILE), 'utf8')) as HistoryShape;
}

function kinds(history: HistoryShape): string[] {
  return history.records.map((record) => record.payload.kind);
}

function refOf(identity: DeviceIdentity): { fingerprint: string; publicKey: string } {
  return { fingerprint: identity.fingerprint, publicKey: identity.publicKey };
}

// A secret store that fails the first `times` calls of one operation on one name, then behaves like the store under it. Used to stop a rotation or a
// revocation between two steps without any test-only branch in the product code.
function failing(base: MemorySecrets, operation: 'store' | 'delete', name: string, times = 1): SecretStorageLike & { failures: number } {
  const wrapper = {
    failures: 0,
    get: (key: string): Promise<string | undefined> => base.get(key),
    store: async (key: string, value: string): Promise<void> => {
      if (operation === 'store' && key === name && wrapper.failures < times) { wrapper.failures += 1; throw new Error('the store stopped here'); }
      await base.store(key, value);
    },
    delete: async (key: string): Promise<void> => {
      if (operation === 'delete' && key === name && wrapper.failures < times) { wrapper.failures += 1; throw new Error('the delete stopped here'); }
      await base.delete(key);
    }
  };
  return wrapper;
}

// A person with a key, one completed rotation, and the old key kept as the previous key.
async function rotated(folder: string, secrets: MemorySecrets): Promise<{ first: DeviceIdentity; second: DeviceIdentity; bundleBefore: ReturnType<typeof signPayload> }> {
  const { identity: first } = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder, now: () => T0 });
  const bundleBefore = bundleBy(first, T0);
  await prepareDeviceRotation(secrets, { identityDir: folder, now: () => T0 });
  const { current: second } = await commitDeviceRotation(secrets, { identityDir: folder, now: () => T1 });
  return { first, second, bundleBefore };
}

test('preparing a rotation changes nothing the person signs with and refuses when it cannot be done safely', async () => {
  await withFolder(async (folder, secrets) => {
    await assert.rejects(() => prepareDeviceRotation(secrets, { identityDir: folder }), /no identity key to rotate/);
    assert.equal(secrets.values.size, 0, 'a refusal creates nothing');

    const { identity } = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder, now: () => T0 });
    const stored = secrets.values.get(DEVICE_KEY_SECRET);
    const historyBefore = await readFile(path.join(folder, KEY_HISTORY_FILE), 'utf8');
    await prepareDeviceRotation(secrets, { identityDir: folder, now: () => T0 });
    assert.equal(secrets.values.get(DEVICE_KEY_SECRET), stored);
    assert.equal(await readFile(path.join(folder, KEY_HISTORY_FILE), 'utf8'), historyBefore, 'no record is written until the commit');

    const pendingStored = secrets.values.get(PENDING_DEVICE_KEY_SECRET);
    await assert.rejects(() => prepareDeviceRotation(secrets, { identityDir: folder }), /already prepared/);
    assert.equal(secrets.values.get(PENDING_DEVICE_KEY_SECRET), pendingStored, 'the prepared key is not replaced');

    await commitDeviceRotation(secrets, { identityDir: folder, now: () => T1 });
    await assert.rejects(() => prepareDeviceRotation(secrets, { identityDir: folder }), /still kept/);
    assert.equal((await loadPreviousDeviceIdentity(secrets))?.fingerprint, identity.fingerprint, 'the earlier key is not dropped');
    await forgetPreviousDeviceIdentity(secrets);
    assert.equal(secrets.values.has(PREVIOUS_DEVICE_KEY_SECRET), false);
    await prepareDeviceRotation(secrets, { identityDir: folder, now: () => T2 });
    assert.equal(secrets.values.has(PENDING_DEVICE_KEY_SECRET), true, 'rotating again works once the previous key is forgotten');
  });
});

test('committing needs a prepared key', async () => {
  await withFolder(async (folder, secrets) => {
    await loadOrCreateDeviceIdentity(secrets, { identityDir: folder, now: () => T0 });
    await assert.rejects(() => commitDeviceRotation(secrets, { identityDir: folder }), /No key rotation is prepared/);
    assert.deepEqual(kinds(await historyOf(folder)), ['created']);
  });
});

test('a commit writes one rotated record signed by the old key, and the chain replays ok', async () => {
  await withFolder(async (folder, secrets) => {
    const { first, second } = await rotated(folder, secrets);
    const history = await historyOf(folder);
    assert.deepEqual(kinds(history), ['created', 'rotated']);
    assert.equal(history.records[1]?.signer.fingerprint, first.fingerprint, 'the old key signs its own handover');
    assert.equal(history.records[1]?.payload.key.fingerprint, first.fingerprint);
    assert.equal(history.records[1]?.payload.next?.fingerprint, second.fingerprint);
    const replay = await readKeyHistory(folder, secrets);
    assert.equal(replay.ok && replay.active?.fingerprint, second.fingerprint);
    assert.equal(replay.ok && replay.head?.seq, 2);
  });
});

test('revoking the previous key records it, deletes it, and refuses its payloads whatever time they claim', async () => {
  await withFolder(async (folder, secrets) => {
    const { first, second, bundleBefore } = await rotated(folder, secrets);
    assert.equal((await verdictOf(folder, secrets, bundleBefore)).ok, true);
    await revokeDeviceKey(secrets, { identityDir: folder, key: refOf(first), now: () => T3 });

    assert.equal(secrets.values.has(PREVIOUS_DEVICE_KEY_SECRET), false, 'the private half is gone');
    const history = await historyOf(folder);
    assert.deepEqual(kinds(history), ['created', 'rotated', 'revoked']);
    assert.equal(history.records[2]?.signer.fingerprint, second.fingerprint, 'the current key signs the withdrawal of the old one');
    for (const at of [T0, T2, T3]) {
      const verdict = await verdictOf(folder, secrets, bundleBy(first, at));
      assert.equal(verdict.ok, false);
      if (!verdict.ok) assert.equal(verdict.reason, 'key-revoked', `refused at a claimed time of ${at.toISOString()}`);
    }
    assert.equal((await verdictOf(folder, secrets, bundleBefore)).ok, false, 'even the payload signed before the rotation is refused now');
    assert.equal((await verdictOf(folder, secrets, bundleBy(second, T3))).ok, true, 'the current key is unaffected');
    assert.equal((await loadDeviceIdentity(secrets))?.fingerprint, second.fingerprint);
    assert.equal((await readKeyHistory(folder, secrets)).ok, true);
  });
});

test('revoking the current key deletes it, and the next first need creates a fresh key with its own created record', async () => {
  await withFolder(async (folder, secrets) => {
    const { second } = await rotated(folder, secrets);
    await revokeDeviceKey(secrets, { identityDir: folder, key: refOf(second), now: () => T3 });
    assert.equal(secrets.values.has(DEVICE_KEY_SECRET), false);
    assert.equal((await verdictOf(folder, secrets, bundleBy(second, T3))).ok, false);
    const status = (await readKeyHistory(folder, secrets));
    assert.equal(status.ok && status.active, undefined, 'no key is active until the next first need');

    const next = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder, now: () => new Date('2026-03-05T10:00:00.000Z') });
    assert.equal(next.created, true);
    assert.notEqual(next.identity.fingerprint, second.fingerprint);
    assert.deepEqual(kinds(await historyOf(folder)), ['created', 'rotated', 'revoked', 'created']);
    assert.equal((await readdir(folder)).some((name) => name.startsWith('key-history.archived-')), false, 'the chain continues, nothing is archived');
    const refused = await verdictOf(folder, secrets, bundleBy(second, T3));
    assert.equal(!refused.ok && refused.reason, 'key-revoked');
    assert.equal((await verdictOf(folder, secrets, bundleBy(next.identity, new Date('2026-03-05T11:00:00.000Z')))).ok, true);
  });
});

test('revoking the current key also drops a rotation that was only prepared', async () => {
  await withFolder(async (folder, secrets) => {
    const { identity } = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder, now: () => T0 });
    await prepareDeviceRotation(secrets, { identityDir: folder, now: () => T0 });
    await revokeDeviceKey(secrets, { identityDir: folder, key: refOf(identity), now: () => T1 });
    assert.deepEqual([...secrets.values.keys()].sort(), [KEY_HISTORY_HEAD_SECRET], 'only the saved end of the history remains');
    const next = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder, now: () => T2 });
    assert.equal(next.created, true);
    await prepareDeviceRotation(secrets, { identityDir: folder, now: () => T2 });
  });
});

test('revoking a key the history does not know, or one already revoked, is refused and changes nothing', async () => {
  await withFolder(async (folder, secrets) => {
    const { first, second } = await rotated(folder, secrets);
    const stranger = await loadOrCreateDeviceIdentity(new MemorySecrets(), { identityDir: path.join(folder, 'other') });
    const snapshot = async (): Promise<string> => JSON.stringify([await readFile(path.join(folder, KEY_HISTORY_FILE), 'utf8'), [...secrets.values.entries()].sort()]);
    const before = await snapshot();
    await assert.rejects(() => revokeDeviceKey(secrets, { identityDir: folder, key: refOf(stranger.identity) }), /does not know that key/);
    assert.equal(await snapshot(), before);

    await revokeDeviceKey(secrets, { identityDir: folder, key: refOf(first), now: () => T3 });
    const afterFirst = await snapshot();
    await assert.rejects(() => revokeDeviceKey(secrets, { identityDir: folder, key: refOf(first) }), /already revoked/);
    assert.equal(await snapshot(), afterFirst);
    assert.equal((await loadDeviceIdentity(secrets))?.fingerprint, second.fingerprint);
  });
});

test('a failure before the record is written leaves the current key active and the pending key in place, and a repeated commit completes', async () => {
  await withFolder(async (folder, secrets) => {
    const { identity: first } = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder, now: () => T0 });
    const { next } = await prepareDeviceRotation(secrets, { identityDir: folder, now: () => T0 });
    const stored = { device: secrets.values.get(DEVICE_KEY_SECRET), pending: secrets.values.get(PENDING_DEVICE_KEY_SECRET) };
    const blocked = failing(secrets, 'store', KEY_HISTORY_HEAD_SECRET);
    await assert.rejects(() => commitDeviceRotation(blocked, { identityDir: folder, now: () => T1 }), /could not be stored/);
    assert.equal(blocked.failures, 1);
    assert.deepEqual(kinds(await historyOf(folder)), ['created'], 'no record was left behind');
    assert.equal(secrets.values.get(DEVICE_KEY_SECRET), stored.device);
    assert.equal(secrets.values.get(PENDING_DEVICE_KEY_SECRET), stored.pending);
    const replay = await readKeyHistory(folder, secrets);
    assert.equal(replay.ok && replay.active?.fingerprint, first.fingerprint);

    const done = await commitDeviceRotation(secrets, { identityDir: folder, now: () => T1 });
    assert.equal(done.current.fingerprint, next.fingerprint);
    assert.equal(done.previous.fingerprint, first.fingerprint);
    assert.deepEqual(kinds(await historyOf(folder)), ['created', 'rotated']);
  });
});

test('a failure after the record but before the key moves is finished by the next commit without a second record', async () => {
  for (const stopAt of [PREVIOUS_DEVICE_KEY_SECRET, DEVICE_KEY_SECRET]) {
    await withFolder(async (folder, secrets) => {
      const { identity: first } = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder, now: () => T0 });
      const { next } = await prepareDeviceRotation(secrets, { identityDir: folder, now: () => T0 });
      const blocked = failing(secrets, 'store', stopAt);
      await assert.rejects(() => commitDeviceRotation(blocked, { identityDir: folder, now: () => T1 }), /stopped here/);
      assert.deepEqual(kinds(await historyOf(folder)), ['created', 'rotated'], `the record is written (stopped at ${stopAt})`);

      const done = await commitDeviceRotation(secrets, { identityDir: folder, now: () => T2 });
      assert.deepEqual(kinds(await historyOf(folder)), ['created', 'rotated'], 'no second record');
      assert.equal(done.current.fingerprint, next.fingerprint);
      assert.equal(done.previous.fingerprint, first.fingerprint);
      assert.equal(secrets.values.has(PENDING_DEVICE_KEY_SECRET), false);
      assert.equal((await loadDeviceIdentity(secrets))?.fingerprint, next.fingerprint);
      assert.equal((await readKeyHistory(folder, secrets)).ok, true);
    });
  }
});

test('a failure while deleting the pending entry is finished by the next commit', async () => {
  await withFolder(async (folder, secrets) => {
    const { identity: first } = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder, now: () => T0 });
    const { next } = await prepareDeviceRotation(secrets, { identityDir: folder, now: () => T0 });
    const blocked = failing(secrets, 'delete', PENDING_DEVICE_KEY_SECRET);
    await assert.rejects(() => commitDeviceRotation(blocked, { identityDir: folder, now: () => T1 }), /stopped here/);
    assert.equal(secrets.values.get(DEVICE_KEY_SECRET), secrets.values.get(PENDING_DEVICE_KEY_SECRET), 'the swap is done, only the pending copy is left');
    const done = await commitDeviceRotation(secrets, { identityDir: folder, now: () => T2 });
    assert.equal(done.current.fingerprint, next.fingerprint);
    assert.equal(done.previous.fingerprint, first.fingerprint);
    assert.equal(secrets.values.has(PENDING_DEVICE_KEY_SECRET), false);
    assert.deepEqual(kinds(await historyOf(folder)), ['created', 'rotated']);
  });
});

test('first need in a half-finished rotation finishes the swap instead of archiving the history', async () => {
  await withFolder(async (folder, secrets) => {
    const { identity: first } = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder, now: () => T0 });
    const { next } = await prepareDeviceRotation(secrets, { identityDir: folder, now: () => T0 });
    const blocked = failing(secrets, 'store', PREVIOUS_DEVICE_KEY_SECRET);
    await assert.rejects(() => commitDeviceRotation(blocked, { identityDir: folder, now: () => T1 }), /stopped here/);
    assert.equal((await loadDeviceIdentity(secrets))?.fingerprint, first.fingerprint, 'the swap has not happened yet');

    const result = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder, now: () => T2 });
    assert.equal(result.created, false);
    assert.equal(result.identity.fingerprint, next.fingerprint, 'the new key is the one in use');
    assert.equal((await loadPreviousDeviceIdentity(secrets))?.fingerprint, first.fingerprint, 'the old key is kept as the previous key');
    assert.equal(secrets.values.has(PENDING_DEVICE_KEY_SECRET), false);
    assert.deepEqual((await readdir(folder)).filter((name) => name.startsWith('key-history.archived-')), [], 'nothing was archived');
    assert.deepEqual(kinds(await historyOf(folder)), ['created', 'rotated']);
  });
});

test('a revoked key left stored by a crash is deleted at the next first need and never made active again', async () => {
  await withFolder(async (folder, secrets) => {
    const { identity } = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder, now: () => T0 });
    const blocked = failing(secrets, 'delete', DEVICE_KEY_SECRET);
    await assert.rejects(() => revokeDeviceKey(blocked, { identityDir: folder, key: refOf(identity), now: () => T1 }), /stopped here/);
    assert.deepEqual(kinds(await historyOf(folder)), ['created', 'revoked'], 'the record was written');
    assert.equal(secrets.values.has(DEVICE_KEY_SECRET), true, 'the delete failed, so the revoked key is still stored for the moment');

    const next = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder, now: () => T2 });
    assert.equal(next.created, true, 'a fresh key, not the revoked one');
    assert.notEqual(next.identity.fingerprint, identity.fingerprint);
    assert.deepEqual(kinds(await historyOf(folder)), ['created', 'revoked', 'created']);
    assert.deepEqual((await readdir(folder)).filter((name) => name.startsWith('key-history.archived-')), []);
    const refused = await verdictOf(folder, secrets, bundleBy(identity, T0));
    assert.equal(!refused.ok && refused.reason, 'key-revoked', 'the revoked key stays refused');
  });
});

test('no rendering of any of the three private keys reaches the history file or the identity folder, and the scanners see the new names', async () => {
  await withFolder(async (folder, secrets) => {
    const { identity: first } = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder, now: () => T0 });
    const { next } = await prepareDeviceRotation(secrets, { identityDir: folder, now: () => T0 });
    const midway = identityKeyNeedles(secrets.values);
    await commitDeviceRotation(secrets, { identityDir: folder, now: () => T1 });
    const needles: Needle[] = [...midway, ...identityKeyNeedles(secrets.values)];
    for (const label of ['device key', 'pending key', 'previous key']) {
      assert.ok(needles.some((needle) => needle.label.startsWith(`identity ${label} form`)), `the ${label} is among the needles`);
    }
    assert.ok(first.fingerprint !== next.fingerprint);
    assert.deepEqual(await scanFiles([folder], needles), [], 'the identity folder, history file included, holds none of them');

    // Control: the same scanner finds a planted copy of the previous key, so the empty result above means something.
    const planted = path.join(path.dirname(folder), 'planted.txt');
    await writeFile(planted, `copied ${secrets.values.get(PREVIOUS_DEVICE_KEY_SECRET)} here`, 'utf8');
    assert.ok((await scanFiles([planted], needles)).some((hit) => hit.includes('previous key form')), 'a copy of the previous key is found');
  });
});

test('the identity helpers write no setting and contribute no rotate or revoke command', async () => {
  const stub = createVscodeStub();
  const restore = installVscodeStub(stub);
  try {
    await withFolder(async (folder, secrets) => {
      const seen: Needle[] = [];
      const first = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder, now: () => T0 });
      signPayload(first.identity, 'policy-bundle', { rules: [] }, { now: () => T0 });
      seen.push(...identityKeyNeedles(secrets.values, 'created'));
      const { next } = await prepareDeviceRotation(secrets, { identityDir: folder, now: () => T0 });
      seen.push(...identityKeyNeedles(secrets.values, 'prepared'));
      const { previous, current } = await commitDeviceRotation(secrets, { identityDir: folder, now: () => T1 });
      assert.equal(current.fingerprint, next.fingerprint);
      seen.push(...identityKeyNeedles(secrets.values, 'committed'));
      await revokeDeviceKey(secrets, { identityDir: folder, key: refOf(previous), now: () => T2 });
      await revokeDeviceKey(secrets, { identityDir: folder, key: refOf(current), now: () => T3 });
      const fresh = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder, now: () => T3 });
      assert.equal(fresh.created, true);
      seen.push(...identityKeyNeedles(secrets.values, 'fresh'));
      assert.deepEqual(stub.configUpdates, [], 'no setting was written');
      const needles = seen;
      for (const label of ['device key', 'pending key', 'previous key']) assert.ok(needles.some((needle) => needle.label.includes(label)), `the ${label} is among the needles`);
      assert.deepEqual(await scanFiles([folder], needles), [], 'none of the three keys is in the history file or the identity folder');
    });
  } finally {
    restore();
  }
  const pkg = JSON.parse(await readFile(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string }> } };
  assert.equal(pkg.contributes.commands.some((entry) => /rotat|revok/i.test(entry.command)), false);
});
