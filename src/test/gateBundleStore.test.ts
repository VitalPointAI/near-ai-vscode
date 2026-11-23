// Policy bundle store tests (OFFL-01, OFFL-02, OFFL-03, D-13, D-14, D-15, D-39): real files in temp folders and in-memory secret stores, never the
// real global storage or SecretStorage. Keys are generated at run time.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { BUNDLE_FAILURES, bundleHash, defaultBundlePayload, inBundleOrder, parseBundle, verifyBundleEnvelope } from '../domain/gate/bundle';
import { POLICY_SECTIONS, featureForSection } from '../domain/gate/features';
import { bundleViewOf, documentFromBundle, parsePolicyDocument } from '../domain/gate/policyDocument';
import { tierForLabel } from '../domain/gate/routing';
import { ORGANIZATION_RULES_FOLDER } from '../gate/installEvidence';
import { ORGANIZATION_DIR_NAME, ORGANIZATION_LAYER_FILE } from '../gate/organizationStore';
import type { BundleFailureReason, PolicyBundle } from '../domain/gate/bundle';
import { buildDecisionRecord, validateDecisionRecord } from '../domain/gate/record';
import { signPayload, verifyPayload } from '../domain/team/signedPayload';
import type { PayloadPurpose } from '../domain/team/signedPayload';
import { BUNDLE_LOCK_FILE, BundleStoreError, GATE_DIR_NAME, POLICY_BUNDLE_FILE, applyPolicyDraft, ensurePolicyBundle, gateDir, loadPolicyBundle, resetPolicyToDefaults } from '../gate/bundleStore';
import type { BundleResult } from '../gate/bundleStore';
import { LAST_VALID_SECRET, readLastValid, writeLastValid } from '../gate/clockMarker';
import { DecisionLog, projectLogKey } from '../gate/decisionLog';
import { DEVICE_KEY_SECRET, commitDeviceRotation, identityDir, loadDeviceIdentity, prepareDeviceRotation, revokeDeviceKey } from '../team/identity';
import type { DeviceIdentity } from '../team/identity';
import { KEY_HISTORY_HEAD_SECRET, localKeyStatus, readKeyHistory } from '../team/keyHistory';
import { FileSecrets } from './helpers/keyHistoryChild';
import type { GateBundleChildReply, GateBundleChildStart } from './helpers/gateBundleChild';
import { MemorySecrets } from './helpers/teamHarness';

const T0 = Date.parse('2026-06-01T12:00:00.000Z');
const at = (ms: number) => (): Date => new Date(ms);

async function withStorage<T>(work: (storage: string) => Promise<T>): Promise<T> {
  const folder = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-bundle-'));
  try {
    return await work(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test('tracer: a fresh install creates the identity, signs, writes, reads back and verifies its first bundle, and a record of it validates', async () => {
  await withStorage(async (storage) => {
    const secrets = new MemorySecrets();
    const result = await ensurePolicyBundle(storage, secrets, { now: at(T0) });
    assert.equal(result.event, 'policy.created');
    assert.equal(result.state.state, 'valid');
    if (result.state.state !== 'valid') return;

    // The identity was made once and the issuer is its fingerprint.
    const identity = await loadDeviceIdentity(secrets);
    assert.ok(identity);
    assert.equal(result.state.bundle.issuer.fingerprint, identity.fingerprint);
    assert.equal(result.state.signer.fingerprint, identity.fingerprint);
    const history = await readKeyHistory(identityDir(storage), secrets);
    assert.equal(history.ok, true);
    if (history.ok) assert.equal(history.head?.seq, 1);

    // The file is on disk, verifies under the purpose policy-bundle and says nothing about the network.
    const file = path.join(gateDir(storage), POLICY_BUNDLE_FILE);
    const envelope: unknown = JSON.parse(await readFile(file, 'utf8'));
    const verdict = verifyPayload(envelope, { purpose: 'policy-bundle', status: await localKeyStatus(identityDir(storage), secrets) });
    assert.equal(verdict.ok, true);
    assert.equal(verifyBundleEnvelope(envelope, { status: await localKeyStatus(identityDir(storage), secrets), now: T0 }).state, 'valid');
    assert.equal((await stat(path.join(storage, GATE_DIR_NAME))).isDirectory(), true);

    // The marker is present with the bundle's hash and the time of the check.
    const marker = await readLastValid(secrets);
    assert.deepEqual(marker, { present: true, at: T0, hash: result.state.hash });
    assert.equal(secrets.values.has(LAST_VALID_SECRET), true);
    assert.equal(secrets.values.has(DEVICE_KEY_SECRET), true);

    // A second call changes nothing and reports no event; the lock file is not left behind.
    const again = await ensurePolicyBundle(storage, secrets, { now: at(T0 + 1000) });
    assert.equal(again.event, undefined);
    assert.equal(again.state.state, 'valid');
    if (again.state.state === 'valid') assert.equal(again.state.hash, result.state.hash);
    assert.equal((await readdir(gateDir(storage))).includes(BUNDLE_LOCK_FILE), false);
    const loaded = await loadPolicyBundle(storage, secrets, { now: at(T0 + 2000) });
    assert.equal(loaded.state, 'valid');

    // A policy.load record built from the state validates and lands in the project's log.
    const record = buildDecisionRecord({
      recordId: 'rec-1', sequence: 1, time: T0, productVersion: '0.0.0-test', actor: { kind: 'person', deviceFingerprint: identity.fingerprint, sessionId: 'session-1' },
      callId: 'call-1', capability: { verb: 'read', paths: [POLICY_BUNDLE_FILE] }, resource: { name: POLICY_BUNDLE_FILE, type: 'policy' }, outcome: 'allowed',
      rule: 'policy.load', bundleHash: result.state.hash
    });
    assert.equal(validateDecisionRecord(record).ok, true);
    const log = new DecisionLog({ globalStorageDir: storage, projectKey: projectLogKey(path.join(storage, 'a-project')), onWriteFailure: (message) => { throw new Error(message); } });
    await log.append(record);
    const lines = (await readFile(path.join(gateDir(storage), 'decisions', `${projectLogKey(path.join(storage, 'a-project'))}.jsonl`), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(validateDecisionRecord(JSON.parse(lines[0] as string)).ok, true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Helpers

const DAY = 24 * 60 * 60 * 1000;
const RESET_SENTENCE = 'Open SovAI: Policy and choose Reset my rules to sign a fresh one; it resets your own rules only.';

function bundleFileOf(storage: string): string {
  return path.join(gateDir(storage), POLICY_BUNDLE_FILE);
}

async function readEnvelope(storage: string): Promise<{ text: string; json: { payload: PolicyBundle } & Record<string, unknown> }> {
  const text = await readFile(bundleFileOf(storage), 'utf8');
  return { text, json: JSON.parse(text) as { payload: PolicyBundle } & Record<string, unknown> };
}

async function writeEnvelope(storage: string, envelope: unknown): Promise<string> {
  const text = `${JSON.stringify(envelope, null, 2)}\n`;
  await writeFile(bundleFileOf(storage), text, 'utf8');
  return text;
}

function signBundle(identity: DeviceIdentity, payload: PolicyBundle, when: number, purpose: PayloadPurpose = 'policy-bundle'): unknown {
  return signPayload(identity, purpose, payload, { now: at(when) });
}

function defaultFor(identity: DeviceIdentity, when: number): PolicyBundle {
  return defaultBundlePayload({ issuer: { fingerprint: identity.fingerprint, publicKey: identity.publicKey }, now: when });
}

// A fresh install that has made its first bundle at T0.
async function freshInstall(storage: string, secrets: MemorySecrets = new MemorySecrets()): Promise<{ secrets: MemorySecrets; identity: DeviceIdentity; first: BundleResult }> {
  const first = await ensurePolicyBundle(storage, secrets, { now: at(T0) });
  assert.equal(first.state.state, 'valid');
  const identity = await loadDeviceIdentity(secrets);
  assert.ok(identity);
  return { secrets, identity, first };
}

function assertFailedClosed(result: BundleResult, reason: BundleFailureReason): void {
  assert.equal(result.state.state, 'failed-closed');
  if (result.state.state !== 'failed-closed') return;
  assert.equal(result.state.reason, reason);
  assert.equal(result.state.sentence, BUNDLE_FAILURES[reason]);
  assert.equal(result.event, undefined);
}

// A secret store that refuses to store some names, or accepts a store and keeps nothing (a keyring that is not there).
class FailingSecrets extends MemorySecrets {
  public constructor(private readonly refuses: (key: string) => boolean, private readonly mode: 'throw' | 'drop' = 'throw') {
    super();
  }

  public override async store(key: string, value: string): Promise<void> {
    if (!this.refuses(key)) return super.store(key, value);
    if (this.mode === 'throw') throw new Error('The secret store is not available.');
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Fresh install

test('a fresh install stores the reserved fields in its bundle (OFFL-03) and needs no network or setup', async () => {
  await withStorage(async (storage) => {
    await freshInstall(storage);
    const { json } = await readEnvelope(storage);
    assert.deepEqual(json.payload.anchorRoots, []);
    assert.deepEqual(json.payload.statusLists, []);
    assert.deepEqual(json.payload.maxOfflineAge, {});
    assert.equal(json.payload.bundleVersion, 1);
    assert.equal(json.purpose, 'policy-bundle');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Fail closed on every cause, and never re-sign silently (OFFL-02, D-13, Pitfall 7)

test('marker present and the file deleted: failed-closed missing, and no new file is written', async () => {
  await withStorage(async (storage) => {
    const { secrets } = await freshInstall(storage);
    await rm(bundleFileOf(storage));
    const result = await ensurePolicyBundle(storage, secrets, { now: at(T0 + DAY) });
    assertFailedClosed(result, 'missing');
    await assert.rejects(stat(bundleFileOf(storage)), { code: 'ENOENT' });
  });
});

test('a marker that does not parse still counts as an install that had a bundle, so a deleted file fails closed', async () => {
  await withStorage(async (storage) => {
    const { secrets } = await freshInstall(storage);
    secrets.values.set(LAST_VALID_SECRET, 'not json at all');
    assert.deepEqual(await readLastValid(secrets), { present: true });
    await rm(bundleFileOf(storage));
    assertFailedClosed(await ensurePolicyBundle(storage, secrets, { now: at(T0 + DAY) }), 'missing');
    await assert.rejects(stat(bundleFileOf(storage)), { code: 'ENOENT' });
  });
});

test('one changed byte: failed-closed bad-signature with the exact sentence, and the file bytes are unchanged (no silent re-sign)', async () => {
  await withStorage(async (storage) => {
    const { secrets } = await freshInstall(storage);
    const before = await readFile(bundleFileOf(storage), 'utf8');
    const changed = before.replace('"Restricted"', '"Restricteb"');
    assert.notEqual(changed, before);
    await writeFile(bundleFileOf(storage), changed, 'utf8');
    const result = await ensurePolicyBundle(storage, secrets, { now: at(T0 + DAY) });
    assertFailedClosed(result, 'bad-signature');
    if (result.state.state === 'failed-closed') {
      assert.equal(result.state.sentence, 'Your policy file was changed outside NEAR AI. Open SovAI: Policy and choose Reset my rules to sign a fresh one; it resets your own rules only.');
    }
    assert.equal(await readFile(bundleFileOf(storage), 'utf8'), changed);
  });
});

test('a bundle signed under another purpose fails closed as wrong-purpose and is left alone', async () => {
  await withStorage(async (storage) => {
    const { secrets, identity } = await freshInstall(storage);
    const text = await writeEnvelope(storage, signBundle(identity, defaultFor(identity, T0), T0, 'grant'));
    assertFailedClosed(await ensurePolicyBundle(storage, secrets, { now: at(T0 + DAY) }), 'wrong-purpose');
    assert.equal(await readFile(bundleFileOf(storage), 'utf8'), text);
  });
});

test('an unsigned bundle (the signature removed) fails closed as malformed and is left alone', async () => {
  await withStorage(async (storage) => {
    const { secrets } = await freshInstall(storage);
    const { json } = await readEnvelope(storage);
    delete json.sig;
    const text = await writeEnvelope(storage, json);
    assertFailedClosed(await ensurePolicyBundle(storage, secrets, { now: at(T0 + DAY) }), 'malformed');
    assert.equal(await readFile(bundleFileOf(storage), 'utf8'), text);
  });
});

test('a file that is not JSON fails closed as unparseable and is left alone', async () => {
  await withStorage(async (storage) => {
    const { secrets } = await freshInstall(storage);
    await writeFile(bundleFileOf(storage), '{ this is not json', 'utf8');
    assertFailedClosed(await ensurePolicyBundle(storage, secrets, { now: at(T0 + DAY) }), 'unparseable');
    assert.equal(await readFile(bundleFileOf(storage), 'utf8'), '{ this is not json');
  });
});

test('an unparseable file on an install with no marker fails closed too, and is never replaced', async () => {
  await withStorage(async (storage) => {
    await mkdir(gateDir(storage), { recursive: true });
    await writeFile(bundleFileOf(storage), 'garbage', 'utf8');
    const secrets = new MemorySecrets();
    assertFailedClosed(await ensurePolicyBundle(storage, secrets, { now: at(T0) }), 'unparseable');
    assert.equal(await readFile(bundleFileOf(storage), 'utf8'), 'garbage');
    assert.equal(secrets.values.has(DEVICE_KEY_SECRET), false);
  });
});

test('a file larger than the allowed size fails closed as too-large without being read into a bundle', async () => {
  await withStorage(async (storage) => {
    const { secrets } = await freshInstall(storage);
    await writeFile(bundleFileOf(storage), 'x'.repeat(600 * 1024), 'utf8');
    assertFailedClosed(await ensurePolicyBundle(storage, secrets, { now: at(T0 + DAY) }), 'too-large');
  });
});

test('a bundle signed by a revoked key fails closed as key-revoked and is left alone', async () => {
  await withStorage(async (storage) => {
    const { secrets, identity } = await freshInstall(storage);
    await revokeDeviceKey(secrets, { identityDir: identityDir(storage), key: { fingerprint: identity.fingerprint, publicKey: identity.publicKey }, now: at(T0 + DAY) });
    const before = await readFile(bundleFileOf(storage), 'utf8');
    assertFailedClosed(await ensurePolicyBundle(storage, secrets, { now: at(T0 + 2 * DAY) }), 'key-revoked');
    assert.equal(await readFile(bundleFileOf(storage), 'utf8'), before);
  });
});

test('a bundle signed by the old key at or after a rotation fails closed as key-rotated, and one signed before it is still valid', async () => {
  await withStorage(async (storage) => {
    const { secrets } = await freshInstall(storage);
    const options = { identityDir: identityDir(storage), now: at(T0 + 3_600_000) };
    await prepareDeviceRotation(secrets, options);
    const { previous } = await commitDeviceRotation(secrets, options);
    // The bundle made before the rotation still verifies.
    assert.equal((await ensurePolicyBundle(storage, secrets, { now: at(T0 + 2 * 3_600_000) })).state.state, 'valid');
    const text = await writeEnvelope(storage, signBundle(previous, defaultFor(previous, T0 + 2 * 3_600_000), T0 + 2 * 3_600_000));
    assertFailedClosed(await ensurePolicyBundle(storage, secrets, { now: at(T0 + 3 * 3_600_000) }), 'key-rotated');
    assert.equal(await readFile(bundleFileOf(storage), 'utf8'), text);
  });
});

test('an expired bundle fails closed as expired and is not renewed', async () => {
  await withStorage(async (storage) => {
    const { secrets } = await freshInstall(storage);
    const before = await readFile(bundleFileOf(storage), 'utf8');
    assertFailedClosed(await ensurePolicyBundle(storage, secrets, { now: at(T0 + 366 * DAY) }), 'expired');
    assert.equal(await readFile(bundleFileOf(storage), 'utf8'), before);
  });
});

test('a bundle signed in the future fails closed as clock-behind with the clock sentence', async () => {
  await withStorage(async (storage) => {
    const { secrets, identity } = await freshInstall(storage);
    const text = await writeEnvelope(storage, signBundle(identity, defaultFor(identity, T0 + DAY), T0 + DAY));
    const result = await ensurePolicyBundle(storage, secrets, { now: at(T0) });
    assertFailedClosed(result, 'clock-behind');
    assert.equal(await readFile(bundleFileOf(storage), 'utf8'), text);
  });
});

test('setting the clock back does not revive an expired bundle: expiry uses the later of the clock and the marker (D-15)', async () => {
  await withStorage(async (storage) => {
    const { secrets, first } = await freshInstall(storage);
    assert.equal(first.state.state, 'valid');
    if (first.state.state !== 'valid') return;
    // This install saw a time after the bundle's expiry; now the wall clock says ten days after the first bundle.
    await writeLastValid(secrets, { at: T0 + 400 * DAY, hash: first.state.hash });
    assertFailedClosed(await ensurePolicyBundle(storage, secrets, { now: at(T0 + 10 * DAY) }), 'expired');
  });
});

test('the marker never moves its time backwards', async () => {
  const secrets = new MemorySecrets();
  const hash = 'a'.repeat(64);
  await writeLastValid(secrets, { at: 5000, hash });
  const kept = await writeLastValid(secrets, { at: 1000, hash });
  assert.equal(kept.at, 5000);
  assert.deepEqual(await readLastValid(secrets), { present: true, at: 5000, hash });
  const moved = await writeLastValid(secrets, { at: 9000, hash });
  assert.equal(moved.at, 9000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Renewal (D-14)

test('a bundle with 29 days left is re-signed with fresh dates and the event policy.renewed; the marker follows', async () => {
  await withStorage(async (storage) => {
    const { secrets, first } = await freshInstall(storage);
    const now = T0 + 336 * DAY;
    const result = await ensurePolicyBundle(storage, secrets, { now: at(now) });
    assert.equal(result.event, 'policy.renewed');
    assert.equal(result.state.state, 'valid');
    if (result.state.state !== 'valid' || first.state.state !== 'valid') return;
    assert.equal(result.state.bundle.issuedAt, new Date(now).toISOString());
    assert.equal(result.state.bundle.expiresAt, new Date(now + 365 * DAY).toISOString());
    assert.equal(result.state.bundle.issuer.fingerprint, first.state.bundle.issuer.fingerprint);
    assert.notEqual(result.state.hash, first.state.hash);
    assert.equal(result.state.renewDue, false);
    assert.deepEqual(await readLastValid(secrets), { present: true, at: now, hash: result.state.hash });
    const onDisk = await loadPolicyBundle(storage, secrets, { now: at(now) });
    assert.equal(onDisk.state, 'valid');
  });
});

test('a bundle with 31 days left is left unchanged', async () => {
  await withStorage(async (storage) => {
    const { secrets } = await freshInstall(storage);
    const before = await readFile(bundleFileOf(storage), 'utf8');
    const result = await ensurePolicyBundle(storage, secrets, { now: at(T0 + 334 * DAY) });
    assert.equal(result.event, undefined);
    assert.equal(result.state.state, 'valid');
    assert.equal(await readFile(bundleFileOf(storage), 'utf8'), before);
  });
});

test('a bundle that does not verify is never renewed, even inside the last 30 days', async () => {
  await withStorage(async (storage) => {
    const { secrets } = await freshInstall(storage);
    const changed = (await readFile(bundleFileOf(storage), 'utf8')).replace('"Restricted"', '"Restricteb"');
    await writeFile(bundleFileOf(storage), changed, 'utf8');
    assertFailedClosed(await ensurePolicyBundle(storage, secrets, { now: at(T0 + 340 * DAY) }), 'bad-signature');
    assert.equal(await readFile(bundleFileOf(storage), 'utf8'), changed);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// A lost device key (D-39, amended by the PR #70 second review: an unknown signer is never adopted; src/test/gateBundleTrust.test.ts has the rest)

test('a lost device key with the shipped default bundle: failed-closed unknown-key, the file is unchanged, nothing is re-signed, and Reset is the way back', async () => {
  await withStorage(async (storage) => {
    const { identity, first } = await freshInstall(storage);
    // A cleared browser on code-server: the secret store is empty again, the global storage folder is still there.
    const lost = new MemorySecrets();
    const before = await readFile(bundleFileOf(storage), 'utf8');
    const result = await ensurePolicyBundle(storage, lost, { now: at(T0 + DAY) });
    assertFailedClosed(result, 'unknown-key');
    assert.equal(await readFile(bundleFileOf(storage), 'utf8'), before);
    assert.equal(lost.values.size, 0);
    const reset = await resetPolicyToDefaults(storage, lost, { now: at(T0 + 2 * DAY) });
    assert.equal(reset.event, 'policy.reset');
    assert.equal(reset.state.state, 'valid');
    if (reset.state.state !== 'valid' || first.state.state !== 'valid') return;
    const fresh = await loadDeviceIdentity(lost);
    assert.ok(fresh);
    assert.notEqual(fresh.fingerprint, identity.fingerprint);
    assert.equal(reset.state.bundle.issuer.fingerprint, fresh.fingerprint);
    // The same content apart from signer and dates.
    assert.deepEqual({ ...reset.state.bundle, issuer: null, issuedAt: '', expiresAt: '' }, { ...first.state.bundle, issuer: null, issuedAt: '', expiresAt: '' });
    assert.equal((await ensurePolicyBundle(storage, lost, { now: at(T0 + 3 * DAY) })).event, undefined);
  });
});

test('a lost device key with the marker kept (only the key and its saved end are gone) also fails closed as unknown-key, even for a default bundle', async () => {
  await withStorage(async (storage) => {
    const { secrets } = await freshInstall(storage);
    secrets.values.delete(DEVICE_KEY_SECRET);
    secrets.values.delete(KEY_HISTORY_HEAD_SECRET);
    const before = await readFile(bundleFileOf(storage), 'utf8');
    assertFailedClosed(await ensurePolicyBundle(storage, secrets, { now: at(T0 + DAY) }), 'unknown-key');
    assert.equal(await readFile(bundleFileOf(storage), 'utf8'), before);
    assert.equal(secrets.values.has(DEVICE_KEY_SECRET), false);
  });
});

test('a lost device key with a customised bundle: failed-closed unknown-key, the file is unchanged and the person is told to reset', async () => {
  await withStorage(async (storage) => {
    const { identity } = await freshInstall(storage);
    const custom: PolicyBundle = { ...defaultFor(identity, T0), clearances: [{ scale: 'org', level: 'Internal', compartments: [], releasability: [] }] };
    const text = await writeEnvelope(storage, signBundle(identity, custom, T0));
    const lost = new MemorySecrets();
    const result = await ensurePolicyBundle(storage, lost, { now: at(T0 + DAY) });
    assertFailedClosed(result, 'unknown-key');
    if (result.state.state === 'failed-closed') assert.ok(result.state.sentence.includes(RESET_SENTENCE));
    assert.equal(await readFile(bundleFileOf(storage), 'utf8'), text);
    assert.equal(lost.values.has(DEVICE_KEY_SECRET), false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// A secret store that cannot hold the key or the marker (A2)

test('a secret store whose store call throws on a fresh install: failed-closed identity-unavailable and no bundle file', async () => {
  await withStorage(async (storage) => {
    const secrets = new FailingSecrets(() => true);
    const result = await ensurePolicyBundle(storage, secrets, { now: at(T0) });
    assertFailedClosed(result, 'identity-unavailable');
    if (result.state.state === 'failed-closed') {
      assert.equal(result.state.sentence, 'NEAR AI could not save its signing key on this computer, so only reading and planning are allowed until it can.');
    }
    await assert.rejects(stat(bundleFileOf(storage)), { code: 'ENOENT' });
  });
});

test('a secret store that accepts a store and keeps nothing (read-back fails) is also identity-unavailable', async () => {
  await withStorage(async (storage) => {
    const secrets = new FailingSecrets(() => true, 'drop');
    assertFailedClosed(await ensurePolicyBundle(storage, secrets, { now: at(T0) }), 'identity-unavailable');
    await assert.rejects(stat(bundleFileOf(storage)), { code: 'ENOENT' });
  });
});

test('a marker that cannot be stored is identity-unavailable: the bundle is not trusted when the install cannot remember it', async () => {
  await withStorage(async (storage) => {
    const secrets = new FailingSecrets((key) => key === LAST_VALID_SECRET);
    assertFailedClosed(await ensurePolicyBundle(storage, secrets, { now: at(T0) }), 'identity-unavailable');
  });
});

test('a secret store that cannot be read is identity-unavailable and creates nothing', async () => {
  await withStorage(async (storage) => {
    const secrets = new MemorySecrets();
    secrets.get = async (): Promise<string | undefined> => { throw new Error('The secret store is not available.'); };
    assertFailedClosed(await ensurePolicyBundle(storage, secrets, { now: at(T0) }), 'identity-unavailable');
    assert.equal((await loadPolicyBundle(storage, secrets, { now: at(T0) })).state, 'failed-closed');
    await assert.rejects(stat(bundleFileOf(storage)), { code: 'ENOENT' });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Reset Policy to Defaults (D-13)

test('resetPolicyToDefaults on a tampered file signs a fresh default, keeps the old file beside it and returns policy.reset', async () => {
  await withStorage(async (storage) => {
    const { secrets, first } = await freshInstall(storage);
    const changed = (await readFile(bundleFileOf(storage), 'utf8')).replace('"Restricted"', '"Restricteb"');
    await writeFile(bundleFileOf(storage), changed, 'utf8');
    assertFailedClosed(await ensurePolicyBundle(storage, secrets, { now: at(T0 + DAY) }), 'bad-signature');

    const result = await resetPolicyToDefaults(storage, secrets, { now: at(T0 + 2 * DAY) });
    assert.equal(result.event, 'policy.reset');
    assert.equal(result.state.state, 'valid');
    if (result.state.state !== 'valid' || first.state.state !== 'valid') return;
    assert.equal(result.state.bundle.issuedAt, new Date(T0 + 2 * DAY).toISOString());
    const aside = path.join(gateDir(storage), `${POLICY_BUNDLE_FILE}.replaced-${T0 + 2 * DAY}`);
    assert.equal(await readFile(aside, 'utf8'), changed);
    assert.equal((await ensurePolicyBundle(storage, secrets, { now: at(T0 + 3 * DAY) })).state.state, 'valid');
    assert.equal((await readLastValid(secrets)).present, true);
  });
});

test('resetPolicyToDefaults twice in the same millisecond keeps both old files under different names', async () => {
  await withStorage(async (storage) => {
    const { secrets } = await freshInstall(storage);
    await resetPolicyToDefaults(storage, secrets, { now: at(T0 + DAY) });
    await resetPolicyToDefaults(storage, secrets, { now: at(T0 + DAY) });
    const kept = (await readdir(gateDir(storage))).filter((name) => name.startsWith(`${POLICY_BUNDLE_FILE}.replaced-`));
    assert.equal(kept.length, 2);
  });
});

test('resetPolicyToDefaults on a missing file signs a fresh default (nothing to keep)', async () => {
  await withStorage(async (storage) => {
    const { secrets } = await freshInstall(storage);
    await rm(bundleFileOf(storage));
    const result = await resetPolicyToDefaults(storage, secrets, { now: at(T0 + DAY) });
    assert.equal(result.event, 'policy.reset');
    assert.equal(result.state.state, 'valid');
    assert.equal((await readdir(gateDir(storage))).some((name) => name.includes('.replaced-')), false);
  });
});

test('resetPolicyToDefaults throws a plain BundleStoreError and leaves the old file when the secret store cannot hold a key', async () => {
  await withStorage(async (storage) => {
    const first = await freshInstall(storage);
    const changed = (await readFile(bundleFileOf(storage), 'utf8')).replace('"Restricted"', '"Restricteb"');
    await writeFile(bundleFileOf(storage), changed, 'utf8');
    // A key was lost and the new store cannot take one.
    const broken = new FailingSecrets(() => true);
    await assert.rejects(resetPolicyToDefaults(storage, broken, { now: at(T0 + DAY) }), (error: unknown) => {
      assert.ok(error instanceof BundleStoreError);
      assert.ok(error.message.startsWith('Nothing was changed:'));
      return true;
    });
    assert.equal(await readFile(bundleFileOf(storage), 'utf8'), changed);
    assert.equal(first.secrets.values.has(DEVICE_KEY_SECRET), true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Two windows (OFFL-01, Pitfall 8)

interface Racer { child: ChildProcess; ready: Promise<void>; done: Promise<GateBundleChildReply & { type: 'done' }> }

function startRacer(start: GateBundleChildStart): Racer {
  const child = fork(path.join(__dirname, 'helpers', 'gateBundleChild.js'), [], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const ready = new Promise<void>((resolve, reject) => {
    child.on('message', (message: GateBundleChildReply) => { if (message.type === 'ready') resolve(); });
    child.on('error', reject);
    child.on('exit', (code) => { reject(new Error(`the window exited with ${String(code)} before it was ready: ${stderr}`)); });
  });
  const done = new Promise<GateBundleChildReply & { type: 'done' }>((resolve, reject) => {
    child.on('message', (message: GateBundleChildReply) => { if (message.type === 'done') resolve(message); });
    child.on('exit', (code) => { reject(new Error(`the window exited with ${String(code)} without an answer: ${stderr}`)); });
  });
  ready.catch(() => undefined);
  done.catch(() => undefined);
  child.send(start);
  return { child, ready, done };
}

test('two windows starting on a fresh install at the same time end with one identity, one bundle and the same hash in both', async () => {
  await withStorage(async (storage) => {
    const secretsFile = path.join(storage, 'secrets.json');
    const racers = [0, 1].map(() => startRacer({ type: 'start', globalStorageDir: storage, secretsFile, now: T0 }));
    let results: (GateBundleChildReply & { type: 'done' })[];
    try {
      await Promise.all(racers.map((racer) => racer.ready));
      for (const racer of racers) racer.child.send({ type: 'go' });
      results = await Promise.all(racers.map((racer) => racer.done));
    } finally {
      for (const racer of racers) racer.child.kill();
    }
    for (const result of results) {
      assert.equal(result.ok, true, result.message);
      assert.equal(result.state, 'valid');
    }
    assert.equal(results[0]?.hash, results[1]?.hash);
    assert.match(results[0]?.hash ?? '', /^[0-9a-f]{64}$/);
    // Exactly one creation event between them: the other window found the bundle the first made.
    assert.deepEqual(results.map((result) => result.event).sort(), ['', 'policy.created']);

    // One identity key in the shared store and one `created` record in the key history.
    const secrets = new FileSecrets(secretsFile);
    const identity = await loadDeviceIdentity(secrets);
    assert.ok(identity);
    const history = await readKeyHistory(identityDir(storage), secrets);
    assert.equal(history.ok, true);
    if (history.ok) {
      assert.equal(history.head?.seq, 1);
      assert.equal(history.active?.fingerprint, identity.fingerprint);
    }
    const { json } = await readEnvelope(storage);
    assert.equal(json.payload.issuer.fingerprint, identity.fingerprint);
    assert.equal((await readdir(gateDir(storage))).includes(BUNDLE_LOCK_FILE), false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Phase 41 (41-09): v2 Apply, renewal of the stored payload, the v2 reader and the organization folder as evidence

const PB_CLEARANCE = { scale: 'ca-protected', level: 'Protected B', compartments: [], releasability: [] };

function withoutDates(payload: Record<string, unknown>): Record<string, unknown> {
  const { issuedAt: _issuedAt, expiresAt: _expiresAt, ...rest } = payload;
  return rest;
}

async function storedPayload(storage: string): Promise<Record<string, unknown>> {
  return (await readEnvelope(storage)).json.payload as unknown as Record<string, unknown>;
}

// Applies a v2 personal layer at T0 + 1 day: the starting rules with one added clearance.
async function appliedV2(storage: string): Promise<{ secrets: MemorySecrets; identity: DeviceIdentity; newHash: string; draft: Record<string, unknown> }> {
  const { secrets, identity, first } = await freshInstall(storage);
  assert.equal(first.state.state, 'valid');
  const stored = await storedPayload(storage);
  const draft = { ...stored, clearances: [...(stored['clearances'] as unknown[]), PB_CLEARANCE] };
  const result = await applyPolicyDraft(storage, secrets, JSON.stringify(draft), { baseHash: first.state.state === 'valid' ? first.state.hash : '' }, { now: at(T0 + DAY) });
  assert.equal(result.event, 'policy.edit');
  return { secrets, identity, newHash: result.newHash, draft };
}

test('FND-02: Apply writes a v2 personal layer with the draft\'s effect', async () => {
  await withStorage(async (storage) => {
    const { secrets, newHash, draft } = await appliedV2(storage);
    const written = await storedPayload(storage);
    assert.equal(written['bundleVersion'], 2);
    assert.equal(written['layer'], 'personal');
    assert.equal(written['parent'], undefined, 'no organization layer, no parent');
    const requires = written['requires'] as string[];
    for (const feature of ['layers@1', 'labels@1', 'agents@1']) assert.ok(requires.includes(feature), feature);
    for (const section of POLICY_SECTIONS) {
      const feature = featureForSection(section);
      if (feature !== undefined && Object.prototype.hasOwnProperty.call(written, section)) assert.ok(requires.includes(feature), `${section} names ${feature}`);
    }
    assert.deepEqual([...requires].sort(), requires, 'sorted');
    const document = parsePolicyDocument(written);
    assert.equal(document.ok, true, document.ok ? '' : document.message);
    const owned = parseBundle({ ...(inBundleOrder(draft) as Record<string, unknown>), issuer: written['issuer'], issuedAt: written['issuedAt'], expiresAt: written['expiresAt'] });
    assert.equal(owned.ok, true, owned.ok ? '' : owned.message);
    if (document.ok && owned.ok) assert.deepEqual(bundleViewOf(document.value), bundleViewOf(documentFromBundle(owned.value)), 'the same effect as the draft');
    const next = await ensurePolicyBundle(storage, secrets, { now: at(T0 + 2 * DAY) });
    assert.equal(next.state.state, 'valid');
    if (next.state.state === 'valid') {
      assert.equal(next.state.hash, newHash);
      assert.ok(next.state.bundle.clearances.some((clearance) => clearance.level === 'Protected B'));
    }
  });
});

test('FND-02: a v1 draft is refused with today\'s messages and paths, and a v2 draft with an unknown section key is refused with the update wording', async () => {
  await withStorage(async (storage) => {
    const { secrets, first } = await freshInstall(storage);
    const baseHash = first.state.state === 'valid' ? first.state.hash : '';
    const stored = await storedPayload(storage);
    const bytes = (await readEnvelope(storage)).text;
    const cases: Array<[string, unknown, RegExp]> = [
      ['an unknown field', { ...stored, surprise: true }, /^Nothing was changed: the draft is not a policy this version can use\. .*has a field the vocabulary does not have/],
      ['a level not in its scale', { ...stored, clearances: [{ ...PB_CLEARANCE, level: 'Protected Z' }] }, /not allowed in this place\. \(at clearances\[0\]\.level\)/]
    ];
    for (const [name, draft, reason] of cases) {
      await assert.rejects(applyPolicyDraft(storage, secrets, JSON.stringify(draft), { baseHash }, { now: at(T0 + DAY) }), (error: unknown) => {
        assert.ok(error instanceof BundleStoreError, name);
        assert.match(error.message, reason, name);
        return true;
      });
      assert.equal((await readEnvelope(storage)).text, bytes, `${name}: unchanged`);
    }
    // A v2 draft: the v2 reading of the stored policy with a section this version does not know.
    const v2 = JSON.parse(JSON.stringify(documentFromBundle(parseBundle(stored).ok ? (parseBundle(stored) as { value: PolicyBundle }).value : (stored as unknown as PolicyBundle)))) as Record<string, unknown>;
    await assert.rejects(applyPolicyDraft(storage, secrets, JSON.stringify({ ...v2, futureSection: { v: 1 } }), { baseHash }, { now: at(T0 + DAY) }), (error: unknown) => {
      assert.ok(error instanceof BundleStoreError);
      assert.match(error.message, /^Nothing was changed: /);
      assert.match(error.message, /futureSection/);
      assert.match(error.message, /update the extension/);
      return true;
    });
    assert.equal((await readEnvelope(storage)).text, bytes);
    // The same v2 draft without the unknown section is applied (allowed side).
    const applied = await applyPolicyDraft(storage, secrets, JSON.stringify(v2), { baseHash }, { now: at(T0 + DAY) });
    assert.equal(applied.state.state, 'valid');
    assert.equal((await storedPayload(storage))['bundleVersion'], 2);
  });
});

test('renewal keeps a v2 personal layer v2 with all its sections', async () => {
  await withStorage(async (storage) => {
    const { secrets } = await appliedV2(storage);
    const before = await storedPayload(storage);
    const renewed = await ensurePolicyBundle(storage, secrets, { now: at(T0 + DAY + 336 * DAY) });
    assert.equal(renewed.event, 'policy.renewed');
    const after = await storedPayload(storage);
    assert.equal(after['bundleVersion'], 2);
    assert.deepEqual(withoutDates(after), withoutDates(before));
    assert.equal(after['issuedAt'], new Date(T0 + DAY + 336 * DAY).toISOString());
  });
});

test('D-62: renewing starting rules stored before Phase 41 adds the reserved compartments; renewing an edited policy keeps its routing exactly', async () => {
  for (const edited of [false, true]) {
    await withStorage(async (storage) => {
      const { secrets, identity } = await freshInstall(storage);
      const payload = JSON.parse(JSON.stringify(defaultFor(identity, T0))) as PolicyBundle & { routing: { compartments: Record<string, string>; levels: Record<string, string> } };
      payload.routing.compartments = {};
      if (edited) payload.routing.levels['org/Public'] = 'attested-cloud';
      await writeEnvelope(storage, signBundle(identity, payload, T0));
      await writeLastValid(secrets, { at: T0, hash: bundleHash(payload) });
      const renewed = await ensurePolicyBundle(storage, secrets, { now: at(T0 + 340 * DAY) });
      assert.equal(renewed.event, 'policy.renewed', edited ? 'edited' : 'unedited');
      assert.equal(renewed.state.state, 'valid');
      const after = (await readEnvelope(storage)).json.payload;
      assert.equal(after.bundleVersion, 1, 'v1 stays v1');
      if (renewed.state.state !== 'valid') return;
      const itar = { scale: 'org', level: 'Public', compartments: ['ITAR'], releasability: [], handling: [] };
      if (edited) {
        assert.deepEqual(after.routing, payload.routing, 'an edited policy keeps its routing exactly');
      } else {
        assert.deepEqual(after.routing.compartments, { CGP: 'local-only', EAR: 'local-only', ITAR: 'local-only' });
        assert.equal(tierForLabel(itar, renewed.state.bundle.routing), 'local-only', 'an ITAR label stays on this computer');
      }
    });
  }
});

test('D-13: earlierInstallEvidence counts the organization folder', async () => {
  assert.equal(ORGANIZATION_RULES_FOLDER, ORGANIZATION_DIR_NAME, 'the copy of the name equals the organization store\'s');
  await withStorage(async (storage) => {
    await mkdir(path.join(gateDir(storage), ORGANIZATION_DIR_NAME), { recursive: true });
    await writeFile(path.join(gateDir(storage), ORGANIZATION_DIR_NAME, ORGANIZATION_LAYER_FILE), '{}\n');
    const secrets = new MemorySecrets();
    const result = await ensurePolicyBundle(storage, secrets, { now: at(T0) });
    assertFailedClosed(result, 'missing');
    if (result.state.state === 'failed-closed') assert.match(result.state.detail ?? '', /organization/);
    await assert.rejects(stat(bundleFileOf(storage)), /ENOENT/, 'no default bundle is signed');
    assert.equal(await loadDeviceIdentity(secrets), undefined, 'and no key is made');
  });
  await withStorage(async (storage) => {
    // An empty organization folder says nothing about an earlier install (allowed side).
    await mkdir(path.join(gateDir(storage), ORGANIZATION_DIR_NAME), { recursive: true });
    const result = await ensurePolicyBundle(storage, new MemorySecrets(), { now: at(T0) });
    assert.equal(result.event, 'policy.created');
  });
});

test('FND-02: a v2 personal file verifies through verifyPolicyLayer and a v1 file through today\'s path with the same sentences', async () => {
  await withStorage(async (storage) => {
    const { secrets } = await appliedV2(storage);
    const { json } = await readEnvelope(storage);
    const payload = json.payload as unknown as { labels: { routing: { levels: Record<string, string> } } };
    payload.labels.routing.levels['org/Public'] = 'local-only';
    await writeEnvelope(storage, json);
    assertFailedClosed(await ensurePolicyBundle(storage, secrets, { now: at(T0 + 2 * DAY) }), 'bad-signature');
  });
  await withStorage(async (storage) => {
    // A v2 layer signed by this install that is valid but not the one it last accepted is refused as replaced, like a v1 file.
    const { secrets, identity } = await appliedV2(storage);
    const written = await storedPayload(storage);
    const other = { ...written, labels: { ...(written['labels'] as Record<string, unknown>), defaultLabel: { scale: 'org', level: 'Internal', compartments: [], releasability: [], handling: [] } } };
    await writeEnvelope(storage, signPayload(identity, 'policy-bundle', other, { now: () => new Date(String(written['issuedAt'])) }));
    assertFailedClosed(await ensurePolicyBundle(storage, secrets, { now: at(T0 + 2 * DAY) }), 'replaced');
  });
});
