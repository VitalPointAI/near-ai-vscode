// An epoch key reaches the engine only after mayRelease on fresh credentials (Phase 71 plan 13 Task 2; D-18, D-19, DCAC-04; research 4.3). With your
// organization's credentials@1 in force, the key ring opens each cell's sealed label in memory and asks the release check at settle, at every read
// and on the reading path; a refused key is dropped and the cell keeps the sentence. Without credentials@1 every key is released as before.
// Fictional Example Organization people; keys made at run time.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { CACHE_STATE_TEXT } from '../domain/credentials/cacheState';
import { buildGrant, newEpochKey, readGrant, sealLabel, wrapEpochKey } from '../domain/replica/cellKeys';
import { ORIGIN_ROSTER } from '../domain/replica/roster';
import { addGrant, createCellsState } from '../domain/replica/rosterCells';
import type { CellsState } from '../domain/replica/rosterCells';
import { writerIdOf } from '../domain/replica/entry';
import { Wallet, WALLET_SECRET_KEY } from '../gate/wallet';
import type { TrustSource, WalletView } from '../gate/wallet';
import { DeviceKeyRing, EPOCH_KEY_SECRET_PREFIX, loadOrCreateEncryptionKey } from '../staff/replica/keyring';
import type { DeviceEncryptionKey } from '../staff/replica/keyring';
import { KEY_RELEASE_TEXT, UNREADABLE_LABEL, keyReleaseFor } from '../staff/replica/keyRelease';
import type { ReleasePolicy, ReleaseView } from '../staff/replica/keyRelease';
import { identityDir, loadOrCreateDeviceIdentity } from '../team/identity';
import { REVOCATIONS, SUSPENSIONS, issue, list, makeWorld } from './helpers/credentialWorld';
import type { World } from './helpers/credentialWorld';
import { fixedSigner, streamId } from './helpers/replicaWorld';
import { MemorySecrets } from './helpers/teamHarness';

const NOW = Date.UTC(2026, 10, 20, 6);
const TTL_MS = 900 * 1000;
const PROJECT = streamId('release/project');
const SECRET_CELL = streamId('release/secret');
const TOP_SECRET_CELL = streamId('release/top-secret');
const CONFIDENTIAL_CELL = streamId('release/confidential');
const label = (level: string): Record<string, unknown> => ({ scale: 'ca-classified', level, compartments: [], releasability: [], handling: [] });

type Device = { writer: string; encryption: DeviceEncryptionKey };

async function device(secrets: MemorySecrets): Promise<Device> {
  const dir = identityDir(mkdtempSync(path.join(tmpdir(), 'near-ai-release-')));
  const { identity } = await loadOrCreateDeviceIdentity(secrets, { identityDir: dir, now: () => new Date(NOW) });
  const encryption = await loadOrCreateEncryptionKey(secrets, { identityDir: dir, identity });
  return { writer: writerIdOf(identity.publicKey), encryption };
}

/** Founding grants for the base cell (unmarked) and labelled cells, wrapped to `to`, committed and placed as the roster fold leaves them. */
function cellsFor(to: Device, cells: ReadonlyArray<{ cell: string; level?: string; key: Buffer; sealedWith?: Buffer }>): { state: CellsState; grants: unknown[] } {
  const lead = fixedSigner('RELEASE-LEAD');
  const state = createCellsState(PROJECT);
  const grants: unknown[] = [];
  cells.forEach((item, index) => {
    const labelSealed = item.level === undefined ? '' : sealLabel(item.sealedWith ?? item.key, item.cell, 1, label(item.level));
    const signed = buildGrant(lead.signer, {
      cell: item.cell, epoch: 1, roster: ORIGIN_ROSTER, labelSealed,
      wraps: [{ writer: to.writer, wrap: wrapEpochKey({ cell: item.cell, epoch: 1, writer: to.writer, recipient: to.encryption.publicKey, epochKey: item.key }) }]
    });
    const read = readGrant(signed);
    assert.ok(read.ok);
    state.cells.set(item.cell, { cell: item.cell, from: index + 1, epochs: [{ epoch: 1, grant: read.hash, roster: ORIGIN_ROSTER, from: index + 1 }], grants: [] });
    assert.equal(addGrant(state, { grant: read.grant, hash: read.hash, position: 0, signerIsRosterWriter: true, admitted: () => true }).status, 'applied');
    grants.push(signed);
  });
  return { state, grants };
}

interface Person { w: World; wallet: Wallet; clock: { now: number }; policy: ReleasePolicy; ended: boolean; view: () => ReleaseView }

/** Sam holds a fresh Secret clearance from the officer; the wallet's view is what the release check reads. */
async function samWithSecret(): Promise<Person> {
  const w = await makeWorld();
  const role = await issue(w.root.signer, w.root.did, 'IssuerRoleCredential', { id: w.officer.did, credentialType: 'ClearanceCredential', scale: 'ca-classified', upTo: 'Secret' });
  const secret = await issue(w.officer.signer, w.officer.did, 'ClearanceCredential', { id: w.member.did, scale: 'ca-classified', atLeast: 'Secret' });
  const lists = new Map([[REVOCATIONS, await list(w.revocationKey, REVOCATIONS, 'revocation')], [SUSPENSIONS, await list(w.suspensionKey, SUSPENSIONS, 'suspension')]]);
  const clock = { now: NOW };
  // Each load stands for a refresh that fetched the lists just then.
  const trust: TrustSource = {
    policy: () => w.policy,
    didState: (did) => w.didState.states[did],
    list: (id) => { const found = lists.get(id); return found === undefined ? undefined : { credential: found.credential, fetchedAt: clock.now }; },
    roles: (did) => (did === w.officer.did ? [role.credential] : [])
  };
  const secrets = new MemorySecrets();
  await secrets.store(WALLET_SECRET_KEY, JSON.stringify([secret.credential]));
  const wallet = new Wallet(secrets, trust, () => clock.now, w.member.did);
  await wallet.load();
  const person: Person = {
    w, wallet, clock, policy: { section: w.section, scales: w.policy.scales }, ended: false,
    view: () => ({ ...(wallet.verifiedView() as WalletView), ended: person.ended })
  };
  return person;
}

async function ringFor(p: Person | undefined, secrets = new MemorySecrets()): Promise<{ ring: DeviceKeyRing; me: Device; secrets: MemorySecrets }> {
  const me = await device(secrets);
  const check = p === undefined ? undefined : keyReleaseFor(() => p.policy, p.view, () => p.clock.now);
  const ring = await DeviceKeyRing.load(secrets, PROJECT, { writer: me.writer, privateKey: me.encryption.privateKey }, check);
  return { ring, me, secrets };
}

test('with credentials@1 and a fresh Secret clearance, a Secret cell\'s key is released and a Top Secret cell\'s key is dropped with who to ask', async () => {
  const sam = await samWithSecret();
  const { ring, me } = await ringFor(sam);
  const keys = { base: newEpochKey(), secret: newEpochKey(), top: newEpochKey() };
  const { state } = cellsFor(me, [{ cell: PROJECT, key: keys.base }, { cell: SECRET_CELL, level: 'Secret', key: keys.secret }, { cell: TOP_SECRET_CELL, level: 'Top Secret', key: keys.top }]);
  assert.equal(await ring.settle(state), 2, 'the base cell and the Secret cell are released');
  assert.deepEqual(ring.epochKey(PROJECT, 1), keys.base, 'the unmarked base cell');
  assert.deepEqual(ring.epochKey(SECRET_CELL, 1), keys.secret);
  assert.equal(ring.epochKey(TOP_SECRET_CELL, 1), undefined);
  assert.equal(ring.holds(TOP_SECRET_CELL, 1), false, 'the Top Secret key is not held in memory');
  const withheld = ring.withheldCells().get(TOP_SECRET_CELL);
  assert.deepEqual(withheld, { ok: false, reason: 'not-cleared', sentence: KEY_RELEASE_TEXT.notCleared });
  assert.match(KEY_RELEASE_TEXT.notCleared, /^You are not cleared for this work\. Ask your organization's security officer/);
});

test('with a stale view no key above the lowest level is released and the cell shows the stale sentence with Retry; Retry after a refresh releases it', async () => {
  const sam = await samWithSecret();
  const { ring, me } = await ringFor(sam);
  const keys = { base: newEpochKey(), secret: newEpochKey(), confidential: newEpochKey() };
  const { state } = cellsFor(me, [{ cell: PROJECT, key: keys.base }, { cell: SECRET_CELL, level: 'Secret', key: keys.secret }, { cell: CONFIDENTIAL_CELL, level: 'Confidential', key: keys.confidential }]);
  sam.clock.now = NOW + TTL_MS + 1000;
  await ring.settle(state);
  assert.equal(ring.epochKey(SECRET_CELL, 1), undefined, 'the Secret cell waits for a fresh check');
  assert.deepEqual(ring.epochKey(CONFIDENTIAL_CELL, 1), keys.confidential, 'the lowest level is not held back by a stale view');
  assert.deepEqual(ring.epochKey(PROJECT, 1), keys.base);
  assert.deepEqual(ring.withheldCells().get(SECRET_CELL), { ok: false, reason: 'stale', sentence: CACHE_STATE_TEXT.stale.text, action: 'retry' });

  await sam.wallet.load();
  assert.ok(await ring.recheck() >= 1, 'Retry after a refresh settles the key again');
  assert.deepEqual(ring.epochKey(SECRET_CELL, 1), keys.secret);
  assert.equal(ring.withheldCells().has(SECRET_CELL), false);
});

test('a key already released is dropped at the next read once the view turns stale, and is not kept in the cache', async () => {
  const sam = await samWithSecret();
  const { ring, me, secrets } = await ringFor(sam);
  const key = newEpochKey();
  const { state } = cellsFor(me, [{ cell: PROJECT, key: newEpochKey() }, { cell: SECRET_CELL, level: 'Secret', key }]);
  await ring.settle(state);
  assert.deepEqual(ring.epochKey(SECRET_CELL, 1), key);
  const versionBefore = ring.version;
  sam.clock.now = NOW + TTL_MS;
  assert.equal(ring.epochKey(SECRET_CELL, 1), undefined, 'asked again at the read, and refused');
  assert.equal(ring.holds(SECRET_CELL, 1), false, 'dropped from memory');
  assert.ok(ring.version > versionBefore, 'the host sees the ring changed');
  assert.equal(ring.keyRing()(SECRET_CELL, 1), undefined, 'the fold\'s key ring answers nothing either');
  // The next write-through keeps no copy of the dropped key.
  await ring.addOwn(TOP_SECRET_CELL, 1, newEpochKey(), 'a'.repeat(64));
  const cached = JSON.parse((await secrets.get(EPOCH_KEY_SECRET_PREFIX + PROJECT)) as string) as { keys: Array<[string, number, string]> };
  assert.equal(cached.keys.some(([cell]) => cell === SECRET_CELL), false);
});

test('without credentials@1 every key is released exactly as before, and a ring with no check behaves as today', async () => {
  const sam = await samWithSecret();
  const noRules = keyReleaseFor(() => undefined, sam.view, () => NOW + 10 * TTL_MS);
  assert.deepEqual(noRules(TOP_SECRET_CELL, label('Top Secret')), { ok: true });
  assert.deepEqual(noRules(TOP_SECRET_CELL, UNREADABLE_LABEL), { ok: true });
  for (const check of [undefined, noRules]) {
    const secrets = new MemorySecrets();
    const me = await device(secrets);
    const ring = await DeviceKeyRing.load(secrets, PROJECT, { writer: me.writer, privateKey: me.encryption.privateKey }, check);
    const keys = { base: newEpochKey(), top: newEpochKey() };
    const { state } = cellsFor(me, [{ cell: PROJECT, key: keys.base }, { cell: TOP_SECRET_CELL, level: 'Top Secret', key: keys.top }]);
    assert.equal(await ring.settle(state), 2);
    assert.deepEqual(ring.epochKey(TOP_SECRET_CELL, 1), keys.top);
    assert.equal(ring.withheldCells().size, 0);
  }
});

test('after the session ends or the person\'s entity is disabled no further key is released, even an epoch already granted', async () => {
  const sam = await samWithSecret();
  const { ring, me } = await ringFor(sam);
  const keys = { base: newEpochKey(), secret: newEpochKey() };
  const { state } = cellsFor(me, [{ cell: PROJECT, key: keys.base }, { cell: SECRET_CELL, level: 'Secret', key: keys.secret }]);
  await ring.settle(state);
  assert.deepEqual(ring.epochKey(SECRET_CELL, 1), keys.secret);
  sam.ended = true;
  assert.equal(ring.epochKey(SECRET_CELL, 1), undefined);
  assert.equal(ring.epochKey(PROJECT, 1), undefined, 'the base cell too');
  assert.equal(await ring.settle(state), 0, 'settling again releases nothing');
  assert.equal(ring.size, 0);
  assert.deepEqual(ring.withheldCells().get(PROJECT), { ok: false, reason: 'session-ended', sentence: KEY_RELEASE_TEXT.ended });
});

test('the reading path asks the check too, and a label that does not open keeps the cell closed', async () => {
  const sam = await samWithSecret();
  const { ring, me } = await ringFor(sam);
  const keys = { top: newEpochKey(), secret: newEpochKey(), forged: newEpochKey() };
  const { grants } = cellsFor(me, [{ cell: TOP_SECRET_CELL, level: 'Top Secret', key: keys.top }]);
  assert.deepEqual(ring.readingCandidates(TOP_SECRET_CELL, grants), [], 'no reading key for a cell the person is not cleared for');
  const secret = cellsFor(me, [{ cell: SECRET_CELL, level: 'Secret', key: keys.secret }]);
  assert.equal(ring.readingCandidates(SECRET_CELL, secret.grants).length, 1, 'a reading key for a cell the person is cleared for');

  const unreadable = cellsFor(me, [{ cell: CONFIDENTIAL_CELL, level: 'Secret', key: newEpochKey(), sealedWith: keys.forged }]);
  await ring.settle(unreadable.state);
  assert.equal(ring.epochKey(CONFIDENTIAL_CELL, 1), undefined);
  assert.deepEqual(ring.withheldCells().get(CONFIDENTIAL_CELL), { ok: false, reason: 'label-unreadable', sentence: KEY_RELEASE_TEXT.unreadable });
});

test('a key from the cache is handed out only after settle opens its label, and until then the reading path offers it, checked', async () => {
  const sam = await samWithSecret();
  const secrets = new MemorySecrets();
  const me = await device(secrets);
  const keys = { base: newEpochKey(), secret: newEpochKey() };
  const { state, grants } = cellsFor(me, [{ cell: PROJECT, key: keys.base }, { cell: SECRET_CELL, level: 'Secret', key: keys.secret }]);
  // A ring without a check fills the cache, as an earlier session would have.
  const earlier = await DeviceKeyRing.load(secrets, PROJECT, { writer: me.writer, privateKey: me.encryption.privateKey });
  assert.equal(await earlier.settle(state), 2);
  const ring = await DeviceKeyRing.load(secrets, PROJECT, { writer: me.writer, privateKey: me.encryption.privateKey }, keyReleaseFor(() => sam.policy, sam.view, () => sam.clock.now));
  assert.equal(ring.size, 2, 'the cache was read');
  assert.equal(ring.epochKey(PROJECT, 1), undefined, 'not handed out before its label is opened');
  assert.equal(ring.holds(PROJECT, 1), false, 'so the host reads the roster with a reading key meanwhile');
  assert.deepEqual(ring.readingCandidates(PROJECT, grants).map((candidate) => candidate.key), [keys.base]);
  assert.equal(await ring.settle(state), 2, 'both cached keys are released once their labels are opened');
  assert.deepEqual(ring.epochKey(SECRET_CELL, 1), keys.secret);
});

test('keyReleaseFor reads a label as text or as a legacy set, every label of a set must pass, and an edge counts the level\'s offline age', async () => {
  const sam = await samWithSecret();
  const connected = keyReleaseFor(() => sam.policy, sam.view, () => sam.clock.now);
  assert.deepEqual(connected(SECRET_CELL, 'ca-classified/Secret'), { ok: true });
  assert.equal((connected(SECRET_CELL, 'ca-classified/Top Secret') as { reason?: string }).reason, 'not-cleared');
  assert.deepEqual(connected(SECRET_CELL, { legacy: 1, labels: [label('Confidential'), label('Secret')] }), { ok: true });
  assert.equal((connected(SECRET_CELL, { legacy: 1, labels: [label('Secret'), label('Top Secret')] }) as { reason?: string }).reason, 'not-cleared');
  assert.equal((connected(SECRET_CELL, { scale: 'nowhere', level: 'x' }) as { reason?: string }).reason, 'label-unreadable');

  // At an edge a stale view still counts within Secret's 24 hours of offline age, and not after.
  const edge = keyReleaseFor(() => sam.policy, sam.view, () => sam.clock.now, 'edge');
  sam.clock.now = NOW + 2 * 3600 * 1000;
  assert.deepEqual(edge(SECRET_CELL, label('Secret')), { ok: true });
  assert.equal((connected(SECRET_CELL, label('Secret')) as { reason?: string }).reason, 'stale');
  sam.clock.now = Date.UTC(2026, 10, 20) + 25 * 3600 * 1000;
  const late = edge(SECRET_CELL, label('Secret'));
  assert.equal((late as { reason?: string }).reason, 'freshness');
  assert.equal((late as { action?: string }).action, 'connect');
});
