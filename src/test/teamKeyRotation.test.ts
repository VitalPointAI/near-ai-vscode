// Rotating and revoking the person's own key as signed history records (D-09, D-21, TMR-05). All key material is generated at run time.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { signPayload, verifyPayload } from '../domain/team/signedPayload';
import type { PayloadVerdict } from '../domain/team/signedPayload';
import {
  DEVICE_KEY_SECRET, PENDING_DEVICE_KEY_SECRET, PREVIOUS_DEVICE_KEY_SECRET, commitDeviceRotation, identityDir, loadDeviceIdentity,
  loadOrCreateDeviceIdentity, loadPreviousDeviceIdentity, prepareDeviceRotation
} from '../team/identity';
import type { DeviceIdentity } from '../team/identity';
import { localKeyStatus } from '../team/keyHistory';
import { MemorySecrets } from './helpers/teamHarness';

const T0 = new Date('2026-03-01T10:00:00.000Z');
const T1 = new Date('2026-03-02T10:00:00.000Z');
const T2 = new Date('2026-03-03T10:00:00.000Z');

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
