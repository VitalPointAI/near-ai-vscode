// Policy bundle store tests (OFFL-01, OFFL-02, OFFL-03, D-13, D-14, D-15, D-39): real files in temp folders and in-memory secret stores, never the
// real global storage or SecretStorage. Keys are generated at run time.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { verifyBundleEnvelope } from '../domain/gate/bundle';
import { buildDecisionRecord, validateDecisionRecord } from '../domain/gate/record';
import { verifyPayload } from '../domain/team/signedPayload';
import { BUNDLE_LOCK_FILE, GATE_DIR_NAME, POLICY_BUNDLE_FILE, ensurePolicyBundle, gateDir, loadPolicyBundle } from '../gate/bundleStore';
import { LAST_VALID_SECRET, readLastValid } from '../gate/clockMarker';
import { DecisionLog, projectLogKey } from '../gate/decisionLog';
import { DEVICE_KEY_SECRET, identityDir, loadDeviceIdentity } from '../team/identity';
import { localKeyStatus, readKeyHistory } from '../team/keyHistory';
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
    const log = new DecisionLog({ globalStorageDir: storage, projectKey: projectLogKey(path.join(storage, 'a-project')) });
    await log.append(record);
    const lines = (await readFile(path.join(gateDir(storage), 'decisions', `${projectLogKey(path.join(storage, 'a-project'))}.jsonl`), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(validateDecisionRecord(JSON.parse(lines[0] as string)).ok, true);
  });
});
