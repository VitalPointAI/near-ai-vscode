// The bundle store's trust rule (PR #70 second review, D-13, D-15, D-39 as amended): the store signs a policy by itself only on a TRUE first install, a
// policy it did not write is never adopted, and a renewal needs this install's own key and the last-valid hash. Real files in temp folders and in-memory
// secret stores; the attacker is a second device key that can write files but cannot reach the secret store.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { BUNDLE_FAILURES, bundleHash, defaultBundlePayload } from '../domain/gate/bundle';
import type { BundleFailureReason, PolicyBundle } from '../domain/gate/bundle';
import { buildDecisionRecord } from '../domain/gate/record';
import { signPayload } from '../domain/team/signedPayload';
import { POLICY_BUNDLE_FILE, ensurePolicyBundle, gateDir, loadPolicyBundle, resetPolicyToDefaults } from '../gate/bundleStore';
import type { BundleResult } from '../gate/bundleStore';
import { LAST_VALID_SECRET, readLastValid, writeLastValid } from '../gate/clockMarker';
import { DECISIONS_DIR, DecisionLog, projectLogKey } from '../gate/decisionLog';
import { GateHost } from '../gate/host';
import { DECISION_LOGS_FOLDER } from '../gate/installEvidence';
import { DEVICE_KEY_SECRET, createDeviceIdentity, identityDir, loadDeviceIdentity, loadOrCreateDeviceIdentity } from '../team/identity';
import type { DeviceIdentity } from '../team/identity';
import { KEY_HISTORY_HEAD_SECRET } from '../team/keyHistory';
import { MemorySecrets } from './helpers/teamHarness';

const T0 = Date.parse('2026-06-01T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (ms: number) => (): Date => new Date(ms);

async function withStorage<T>(work: (storage: string) => Promise<T>): Promise<T> {
  const folder = await mkdtemp(path.join(tmpdir(), 'near-ai-gate-trust-'));
  try {
    return await work(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

const fileOf = (storage: string): string => path.join(gateDir(storage), POLICY_BUNDLE_FILE);
const readText = (storage: string): Promise<string> => readFile(fileOf(storage), 'utf8');

function payloadFor(identity: DeviceIdentity, when: number, edit?: (p: PolicyBundle) => PolicyBundle): PolicyBundle {
  const base = defaultBundlePayload({ issuer: { fingerprint: identity.fingerprint, publicKey: identity.publicKey }, now: when });
  return edit === undefined ? base : edit(base);
}

// A policy the person has customised: one more clearance than the shipped default.
const customised = (p: PolicyBundle): PolicyBundle => ({ ...p, clearances: [{ scale: 'org', level: 'Internal', compartments: [], releasability: [] }] });

async function put(storage: string, identity: DeviceIdentity, payload: PolicyBundle, when: number): Promise<string> {
  const text = `${JSON.stringify(signPayload(identity, 'policy-bundle', payload, { now: at(when) }), null, 2)}\n`;
  await writeFile(fileOf(storage), text, 'utf8');
  return text;
}

function closed(result: BundleResult | Awaited<ReturnType<typeof loadPolicyBundle>>, reason: BundleFailureReason): void {
  const state = 'state' in result && typeof result.state === 'object' ? result.state : result;
  assert.equal((state as { state: string }).state, 'failed-closed');
  assert.equal((state as { reason: string }).reason, reason);
  assert.equal((state as { sentence: string }).sentence, BUNDLE_FAILURES[reason]);
  if ('event' in result) assert.equal(result.event, undefined);
}

// An install whose person narrowed the policy: the file is a customised policy this install signed, and the marker holds its hash (what the product's own
// policy editing will leave behind).
async function narrowedInstall(storage: string): Promise<{ secrets: MemorySecrets; identity: DeviceIdentity; text: string; hash: string }> {
  const secrets = new MemorySecrets();
  const first = await ensurePolicyBundle(storage, secrets, { now: at(T0) });
  assert.equal(first.state.state, 'valid');
  const identity = (await loadDeviceIdentity(secrets)) as DeviceIdentity;
  const payload = payloadFor(identity, T0, customised);
  const text = await put(storage, identity, payload, T0);
  await writeLastValid(secrets, { at: T0, hash: bundleHash(payload) });
  const loaded = await loadPolicyBundle(storage, secrets, { now: at(T0) });
  assert.equal(loaded.state, 'valid');
  return { secrets, identity, text, hash: bundleHash(payload) };
}

async function markerOf(secrets: MemorySecrets): Promise<{ hash?: string; pending?: string }> {
  const marker = await readLastValid(secrets);
  return marker.present ? marker : {};
}

const attacker = (): Promise<DeviceIdentity> => createDeviceIdentity(new MemorySecrets());

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// An unknown signer is never adopted, whatever the file says

test('a narrowed policy replaced on disk with the DEFAULT payload signed by an attacker key is refused as unknown-key and the file bytes are unchanged', async () => {
  await withStorage(async (storage) => {
    const { secrets, hash } = await narrowedInstall(storage);
    const evil = await attacker();
    const planted = await put(storage, evil, payloadFor(evil, T0 + DAY), T0 + DAY);
    const markerBefore = secrets.values.get(LAST_VALID_SECRET);
    const result = await ensurePolicyBundle(storage, secrets, { now: at(T0 + 2 * DAY) });
    closed(result, 'unknown-key');
    assert.equal(await readText(storage), planted, 'nothing was re-signed over the planted file');
    assert.equal(secrets.values.get(LAST_VALID_SECRET), markerBefore, 'the marker still names the narrowed policy');
    assert.equal((await markerOf(secrets)).hash, hash);
    closed(await loadPolicyBundle(storage, secrets, { now: at(T0 + 2 * DAY) }), 'unknown-key');
    // And again on the next start: still refused, still untouched.
    closed(await ensurePolicyBundle(storage, secrets, { now: at(T0 + 3 * DAY) }), 'unknown-key');
    assert.equal(await readText(storage), planted);
  });
});

test('a narrowed policy replaced with ANY other payload signed by an attacker key is refused as unknown-key', async () => {
  await withStorage(async (storage) => {
    const { secrets } = await narrowedInstall(storage);
    const evil = await attacker();
    const widened = payloadFor(evil, T0 + DAY, (p) => ({ ...p, ceiling: { ...p.ceiling, unattendedMcp: ['everything'] } }));
    const planted = await put(storage, evil, widened, T0 + DAY);
    closed(await ensurePolicyBundle(storage, secrets, { now: at(T0 + 2 * DAY) }), 'unknown-key');
    assert.equal(await readText(storage), planted);
  });
});

test('an unknown-key default bundle is refused even when the marker holds the default policy\'s own hash', async () => {
  await withStorage(async (storage) => {
    const secrets = new MemorySecrets();
    const first = await ensurePolicyBundle(storage, secrets, { now: at(T0) });
    assert.equal(first.state.state, 'valid');
    const evil = await attacker();
    const planted = await put(storage, evil, payloadFor(evil, T0), T0);
    closed(await ensurePolicyBundle(storage, secrets, { now: at(T0 + DAY) }), 'unknown-key');
    assert.equal(await readText(storage), planted);
  });
});

test('Reset restores trust after an unknown-key bundle: a fresh policy, the planted file kept beside it, and the event policy.reset', async () => {
  await withStorage(async (storage) => {
    const { secrets } = await narrowedInstall(storage);
    const evil = await attacker();
    const planted = await put(storage, evil, payloadFor(evil, T0 + DAY), T0 + DAY);
    closed(await ensurePolicyBundle(storage, secrets, { now: at(T0 + 2 * DAY) }), 'unknown-key');
    const result = await resetPolicyToDefaults(storage, secrets, { now: at(T0 + 3 * DAY) });
    assert.equal(result.event, 'policy.reset');
    assert.equal(result.state.state, 'valid');
    const kept = (await readdir(gateDir(storage))).filter((name) => name.startsWith(`${POLICY_BUNDLE_FILE}.replaced-`));
    assert.equal(kept.length, 1);
    assert.equal(await readFile(path.join(gateDir(storage), kept[0] as string), 'utf8'), planted);
    const after = await ensurePolicyBundle(storage, secrets, { now: at(T0 + 4 * DAY) });
    assert.equal(after.state.state, 'valid');
    assert.equal(after.event, undefined);
  });
});

test('a host that finds an unknown-key policy fails closed, and its Reset is recorded as policy.reset in the project log', async () => {
  await withStorage(async (storage) => {
    const { secrets } = await narrowedInstall(storage);
    const evil = await attacker();
    await put(storage, evil, payloadFor(evil, T0 + DAY), T0 + DAY);
    const project = path.join(storage, 'project');
    const host = new GateHost({ globalStorageDir: storage, secrets, productVersion: '0.0.0-test', projectRoot: project, now: at(T0 + 2 * DAY) });
    const state = await host.start();
    assert.equal(state.state, 'failed-closed');
    if (state.state === 'failed-closed') assert.equal(state.reason, 'unknown-key');
    const result = await host.reset();
    assert.equal(result.event, 'policy.reset');
    await host.flush();
    const log = await readFile(path.join(gateDir(storage), DECISIONS_DIR, `${projectLogKey(project)}.jsonl`), 'utf8');
    assert.ok(log.includes('"policy.reset"'), 'the reset is on the record');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// A valid file that is not the last one this install accepted

test('an older valid policy signed by this install\'s own key, put back on disk, is refused as replaced and left alone', async () => {
  await withStorage(async (storage) => {
    const { secrets, identity } = await narrowedInstall(storage);
    const older = await put(storage, identity, payloadFor(identity, T0 - DAY), T0 - DAY);
    const result = await ensurePolicyBundle(storage, secrets, { now: at(T0 + DAY) });
    closed(result, 'replaced');
    assert.equal(await readText(storage), older);
    closed(await loadPolicyBundle(storage, secrets, { now: at(T0 + DAY) }), 'replaced');
  });
});

test('renewal refuses a bundle whose hash differs from the last-valid hash, even inside the last 30 days and signed by the install\'s own key', async () => {
  await withStorage(async (storage) => {
    const { secrets, identity, hash } = await narrowedInstall(storage);
    const now = T0 + 340 * DAY;
    const other = await put(storage, identity, payloadFor(identity, T0, (p) => ({ ...p, clearances: [] })), T0);
    const result = await ensurePolicyBundle(storage, secrets, { now: at(now) });
    closed(result, 'replaced');
    assert.equal(await readText(storage), other, 'not re-signed with new dates');
    assert.equal((await markerOf(secrets)).hash, hash, 'the marker was not moved to the other hash');
  });
});

test('renewal still happens for the policy this install last accepted, and the marker follows', async () => {
  await withStorage(async (storage) => {
    const { secrets, hash } = await narrowedInstall(storage);
    const result = await ensurePolicyBundle(storage, secrets, { now: at(T0 + 340 * DAY) });
    assert.equal(result.event, 'policy.renewed');
    assert.equal(result.state.state, 'valid');
    if (result.state.state !== 'valid') return;
    assert.notEqual(result.state.hash, hash);
    assert.deepEqual(result.state.bundle.clearances, customised(result.state.bundle).clearances, 'the narrowed content was carried over');
    const marker = await markerOf(secrets);
    assert.equal(marker.hash, result.state.hash);
    assert.equal(marker.pending, undefined, 'the pending hash is gone once the marker is stored');
  });
});

test('a crash between the new file and the marker (the marker still names the old hash and the pending one) is accepted at the next start', async () => {
  await withStorage(async (storage) => {
    const { secrets, identity, hash } = await narrowedInstall(storage);
    const renewed = payloadFor(identity, T0 + 340 * DAY, customised);
    await put(storage, identity, renewed, T0 + 340 * DAY);
    secrets.values.set(LAST_VALID_SECRET, JSON.stringify({ at: T0, hash, pending: bundleHash(renewed) }));
    const result = await ensurePolicyBundle(storage, secrets, { now: at(T0 + 341 * DAY) });
    assert.equal(result.state.state, 'valid');
    const marker = await markerOf(secrets);
    assert.equal(marker.hash, bundleHash(renewed));
    assert.equal(marker.pending, undefined);
  });
});

test('a marker with no readable hash does not block a valid policy this install signed, and is repaired with its hash; renewal waits for the next start', async () => {
  await withStorage(async (storage) => {
    const { secrets, hash } = await narrowedInstall(storage);
    secrets.values.set(LAST_VALID_SECRET, 'damaged');
    const result = await ensurePolicyBundle(storage, secrets, { now: at(T0 + 340 * DAY) });
    assert.equal(result.state.state, 'valid');
    assert.equal(result.event, undefined, 'no renewal without a last-valid hash to compare');
    assert.equal((await markerOf(secrets)).hash, hash);
    assert.equal((await ensurePolicyBundle(storage, secrets, { now: at(T0 + 341 * DAY) })).event, 'policy.renewed');
  });
});

test('a valid policy with no marker at all (the marker could not be stored the first time) is remembered, not refused', async () => {
  await withStorage(async (storage) => {
    const { secrets } = await narrowedInstall(storage);
    secrets.values.delete(LAST_VALID_SECRET);
    const result = await ensurePolicyBundle(storage, secrets, { now: at(T0 + DAY) });
    assert.equal(result.state.state, 'valid');
    assert.equal((await readLastValid(secrets)).present, true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// A first install, and what proves it is not one

test('a true first install still signs its own policy, also when Team Mode already made a key and a key history here', async () => {
  await withStorage(async (storage) => {
    const plain = await ensurePolicyBundle(storage, new MemorySecrets(), { now: at(T0) });
    assert.equal(plain.event, 'policy.created');
    await rm(storage, { recursive: true, force: true });
    await mkdir(storage, { recursive: true });
    const secrets = new MemorySecrets();
    await loadOrCreateDeviceIdentity(secrets, { identityDir: identityDir(storage), now: at(T0) });
    const withTeam = await ensurePolicyBundle(storage, secrets, { now: at(T0 + DAY) });
    assert.equal(withTeam.event, 'policy.created');
    assert.equal(withTeam.state.state, 'valid');
  });
});

test('a first install whose start failed before it had a policy (a decision log with no bundle hash) still signs its own policy next time', async () => {
  await withStorage(async (storage) => {
    const log = new DecisionLog({ globalStorageDir: storage, projectKey: projectLogKey('/x/p'), onWriteFailure: (message) => { throw new Error(message); } });
    await log.append(recordWith(''));
    await log.flush();
    const result = await ensurePolicyBundle(storage, new MemorySecrets(), { now: at(T0) });
    assert.equal(result.event, 'policy.created');
  });
});

test('the policy file deleted while the marker exists fails closed and is not re-created, even when it was a narrowed policy', async () => {
  await withStorage(async (storage) => {
    const { secrets } = await narrowedInstall(storage);
    await rm(fileOf(storage));
    closed(await ensurePolicyBundle(storage, secrets, { now: at(T0 + DAY) }), 'missing');
    await assert.rejects(stat(fileOf(storage)), { code: 'ENOENT' });
  });
});

function recordWith(bundleHashText: string) {
  return buildDecisionRecord({
    recordId: 'rec-1', sequence: 1, time: T0, productVersion: '0.0.0-test', actor: { kind: 'person', deviceFingerprint: 'device-unknown', sessionId: 'policy' },
    callId: 'call-1', capability: { verb: 'plan' }, resource: { name: 'policy bundle', type: 'policy' }, outcome: 'allowed', rule: 'policy.created', bundleHash: bundleHashText
  });
}

// The secret store is wiped (a cleared browser on code-server, a new keyring) and the person's policy file is gone: the marker cannot be told, so the disk
// is asked. Whatever it says about an earlier install, the store fails closed instead of signing a policy of its own.
async function wipedInstall(storage: string): Promise<{ secrets: MemorySecrets; hash: string }> {
  const secrets = new MemorySecrets();
  const first = await ensurePolicyBundle(storage, secrets, { now: at(T0) });
  assert.equal(first.state.state, 'valid');
  await rm(fileOf(storage));
  return { secrets: new MemorySecrets(), hash: first.state.state === 'valid' ? first.state.hash : '' };
}

test('secret store wiped and the policy file deleted, but the key history is still on disk: failed closed, nothing created, no new key made', async () => {
  await withStorage(async (storage) => {
    const { secrets } = await wipedInstall(storage);
    closed(await ensurePolicyBundle(storage, secrets, { now: at(T0 + DAY) }), 'missing');
    await assert.rejects(stat(fileOf(storage)), { code: 'ENOENT' });
    assert.equal(secrets.values.size, 0, 'the wiped secret store was not given a new key or marker');
  });
});

test('secret store wiped, the file and the key history gone, but a decision log names an earlier valid policy: failed closed', async () => {
  await withStorage(async (storage) => {
    const { secrets, hash } = await wipedInstall(storage);
    await rm(path.join(storage, 'identity'), { recursive: true, force: true });
    const log = new DecisionLog({ globalStorageDir: storage, projectKey: projectLogKey('/x/p'), onWriteFailure: (message) => { throw new Error(message); } });
    await log.append(recordWith(hash));
    await log.flush();
    closed(await ensurePolicyBundle(storage, secrets, { now: at(T0 + DAY) }), 'missing');
    await assert.rejects(stat(fileOf(storage)), { code: 'ENOENT' });
    assert.equal(secrets.values.size, 0);
  });
});

test('secret store wiped and only a kept-aside copy of an old policy file left: failed closed', async () => {
  await withStorage(async (storage) => {
    const { secrets } = await wipedInstall(storage);
    await rm(path.join(storage, 'identity'), { recursive: true, force: true });
    await writeFile(`${fileOf(storage)}.replaced-1`, '{}', 'utf8');
    closed(await ensurePolicyBundle(storage, secrets, { now: at(T0 + DAY) }), 'missing');
    assert.equal(secrets.values.size, 0);
  });
});

test('secret store wiped with the policy file still there: unknown-key, and Reset is the way back', async () => {
  await withStorage(async (storage) => {
    const secrets = new MemorySecrets();
    const first = await ensurePolicyBundle(storage, secrets, { now: at(T0) });
    assert.equal(first.state.state, 'valid');
    const text = await readText(storage);
    const wiped = new MemorySecrets();
    closed(await ensurePolicyBundle(storage, wiped, { now: at(T0 + DAY) }), 'unknown-key');
    assert.equal(await readText(storage), text);
    assert.equal(wiped.values.size, 0);
    const reset = await resetPolicyToDefaults(storage, wiped, { now: at(T0 + 2 * DAY) });
    assert.equal(reset.event, 'policy.reset');
    assert.equal(reset.state.state, 'valid');
    assert.equal(wiped.values.has(DEVICE_KEY_SECRET), true);
    assert.equal(wiped.values.has(KEY_HISTORY_HEAD_SECRET), true);
  });
});

test('the decision log folder name the install-evidence check reads is the folder the decision log writes', () => {
  assert.equal(DECISION_LOGS_FOLDER, DECISIONS_DIR);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// A write that fails after the marker named it (PR #70 third review): the pending hash is withdrawn and the old file is back

/** While the marker holds a pending hash, the key history reads as damaged, so the new file does not verify when it is read back. The new file's text is kept. */
class ReadBackBreaker extends MemorySecrets {
  public brokenReads = 0;
  /** Set to false to let the next write read back as written. */
  public armed = true;
  public lastWritten: string | undefined;
  public constructor(private readonly policyFile: string) { super(); }

  public override async get(key: string): Promise<string | undefined> {
    if (this.armed && key === KEY_HISTORY_HEAD_SECRET && (this.values.get(LAST_VALID_SECRET) ?? '').includes('"pending"')) {
      this.brokenReads += 1;
      this.lastWritten = await readFile(this.policyFile, 'utf8').catch(() => this.lastWritten);
      return 'damaged';
    }
    return super.get(key);
  }
}

async function narrowedWithBreaker(storage: string): Promise<{ secrets: ReadBackBreaker; text: string; hash: string }> {
  const plain = await narrowedInstall(storage);
  const secrets = new ReadBackBreaker(fileOf(storage));
  for (const [key, value] of plain.secrets.values) secrets.values.set(key, value);
  return { secrets, text: plain.text, hash: plain.hash };
}

test('a reset whose read-back fails leaves the old policy, withdraws the pending hash, and the next start is valid with the old policy', async () => {
  await withStorage(async (storage) => {
    const { secrets, text, hash } = await narrowedWithBreaker(storage);
    await assert.rejects(resetPolicyToDefaults(storage, secrets, { now: at(T0 + DAY) }), /did not read back as written/);
    assert.ok(secrets.brokenReads > 0, 'the read-back was the step that failed');
    assert.equal(await readText(storage), text, 'the old policy file is back');
    const marker = await markerOf(secrets);
    assert.equal(marker.hash, hash);
    assert.equal(marker.pending, undefined, 'no hash is left pending for a policy that was never kept');
    const next = await ensurePolicyBundle(storage, secrets, { now: at(T0 + 2 * DAY) });
    assert.equal(next.state.state, 'valid');
    assert.equal(next.state.state === 'valid' ? next.state.hash : '', hash);
    assert.equal(next.event, undefined);
  });
});

test('the file a failed reset wrote is not accepted when it is put back later: it is refused as replaced', async () => {
  await withStorage(async (storage) => {
    const { secrets, text } = await narrowedWithBreaker(storage);
    await assert.rejects(resetPolicyToDefaults(storage, secrets, { now: at(T0 + DAY) }));
    const neverKept = secrets.lastWritten;
    assert.ok(neverKept !== undefined && neverKept !== text, 'the failed reset had written a different, default policy');
    // Someone with disk access plants it: this install signed it, but never kept it, so it must not widen the narrowed policy.
    await writeFile(fileOf(storage), neverKept, 'utf8');
    closed(await ensurePolicyBundle(storage, secrets, { now: at(T0 + 2 * DAY) }), 'replaced');
  });
});

test('a renewal whose read-back fails puts the old file back, withdraws the pending hash, and the next start is valid and not replaced', async () => {
  await withStorage(async (storage) => {
    const { secrets, text, hash } = await narrowedWithBreaker(storage);
    const during = await ensurePolicyBundle(storage, secrets, { now: at(T0 + 340 * DAY) });
    assert.ok(secrets.brokenReads > 0, 'the renewal was tried and its read-back failed');
    assert.equal(during.state.state, 'valid', 'a renewal that did not happen is not a reason to fail closed');
    assert.equal(during.event, undefined);
    assert.equal(await readText(storage), text, 'the file the renewal replaced is back');
    const marker = await markerOf(secrets);
    assert.equal(marker.hash, hash);
    assert.equal(marker.pending, undefined);
    secrets.armed = false;
    const next = await ensurePolicyBundle(storage, secrets, { now: at(T0 + 341 * DAY) });
    assert.equal(next.state.state, 'valid');
    assert.equal(next.event, 'policy.renewed', 'and the renewal that failed is tried again');
  });
});

/** A secret store that keeps the marker with its pending hash but answers the first read-back with something else, so naming the hash fails after it was stored. */
class AnnounceMisread extends MemorySecrets {
  private lie = false;
  public override async store(key: string, value: string): Promise<void> {
    await super.store(key, value);
    if (key === LAST_VALID_SECRET && value.includes('"pending"')) this.lie = true;
  }

  public override async get(key: string): Promise<string | undefined> {
    if (key === LAST_VALID_SECRET && this.lie) { this.lie = false; return 'not what was stored'; }
    return super.get(key);
  }
}

test('a marker update that stored the pending hash but did not read back leaves no pending hash and writes nothing', async () => {
  await withStorage(async (storage) => {
    const plain = await narrowedInstall(storage);
    const secrets = new AnnounceMisread();
    for (const [key, value] of plain.secrets.values) secrets.values.set(key, value);
    await assert.rejects(resetPolicyToDefaults(storage, secrets, { now: at(T0 + DAY) }), /Nothing was written/);
    assert.equal(await readText(storage), plain.text);
    const marker = await markerOf(secrets);
    assert.equal(marker.hash, plain.hash);
    assert.equal(marker.pending, undefined);
  });
});
