import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { buildGrant, grantHash, sealLabel } from '../domain/replica/cellKeys';
import { CELL_ACCESS_FEATURE } from '../domain/replica/features';
import { bundleHash } from '../domain/gate/bundle';
import { gateDir, POLICY_BUNDLE_FILE } from '../gate/bundleStore';
import { LAST_VALID_SECRET, writeLastValid } from '../gate/clockMarker';
import { ORGANIZATION_ISSUER_SECRET, OrganizationStore } from '../gate/organizationStore';
import { setFolderSyncProbe } from '../staff/staffFiles';
import { ReplicaStore } from '../staff/replica/store';
import { withFrontierPolicySource } from '../staff/replica/frontierPolicy';
import { identityDir } from '../team/identity';
import { appendKeyRecord } from '../team/keyHistory';
import { enrolmentTextFor } from './helpers/enrolmentFixtures';
import { deviceKey, FIXED_NOW, issuerKey, policyDocumentFor, signPersonalLayer } from './helpers/policyFixtures';
import { createRosterWorld } from './helpers/replicaRosterWorld';
import { MemorySecrets } from './helpers/teamHarness';

async function installedPolicy(secrets = new MemorySecrets()) {
  const storage = await mkdtemp(path.join(tmpdir(), 'fp-'));
  const key = deviceKey();
  const history = await appendKeyRecord(identityDir(storage), secrets, key, { kind: 'created', key }, { now: () => new Date(FIXED_NOW) });
  assert.ok(history.ok && history.head !== undefined);
  const organization = new OrganizationStore(storage, secrets);
  await organization.accept(enrolmentTextFor(issuerKey()), { wordsConfirmed: true }, FIXED_NOW);
  const doc = policyDocumentFor({ key, now: FIXED_NOW });
  const personal = signPersonalLayer(doc, key);
  const file = path.join(gateDir(storage), POLICY_BUNDLE_FILE);
  await writeFile(file, JSON.stringify(personal));
  await writeLastValid(secrets, { hash: bundleHash(doc), at: FIXED_NOW + 10 });
  return { storage, secrets, file, personal, key, head: history.head };
}

test('a frontier policy source selects signed, committed layered evidence and the protected clock under the ordered locks', async () => {
  const fixture = await installedPolicy();
  const { storage, secrets, file, personal, head } = fixture;
  const marker = await secrets.get(LAST_VALID_SECRET);
  const pin = await secrets.get(ORGANIZATION_ISSUER_SECRET);
  let wall = FIXED_NOW;
  const joined = await withFrontierPolicySource(storage, secrets, () => new Date(wall), async (capture) => {
    const selected = await capture();
    assert.ok(selected);
    const { source, recheck } = selected;
    assert.deepEqual(source.personalEnvelope, personal);
    assert.equal(source.organizationEnvelope.purpose, 'org-policy-layer');
    assert.equal(source.organizationPin.publicKey, issuerKey().publicKey);
    assert.deepEqual(source.personalHistoryHead, head);
    assert.equal(source.instant, FIXED_NOW + 10);
    assert.equal(source.effective.labels.routing.levels['org/Internal'], 'local-only');
    assert.equal(await recheck(), true);
    wall = Date.parse('2027-11-20T00:00:00.000Z');
    assert.equal(await recheck(), false);
    assert.equal(await capture(), undefined);
    return recheck;
  });
  assert.ok(joined);
  assert.equal(await joined(), false);
  assert.equal(await secrets.get(LAST_VALID_SECRET), marker);
  assert.equal(await secrets.get(ORGANIZATION_ISSUER_SECRET), pin);
  assert.equal(await readFile(file, 'utf8'), JSON.stringify(personal));
});

test('frontier policy refuses authentic but unselected personal rules and an uncommitted organization pin', async () => {
  const { storage, secrets, file, key, personal } = await installedPolicy();
  const useSource = () => withFrontierPolicySource(storage, secrets, () => new Date(FIXED_NOW + 20), async (capture) => await capture() ? 'usable' : undefined);
  const other = policyDocumentFor({ key, now: FIXED_NOW + 1 });
  await writeFile(file, JSON.stringify(signPersonalLayer(other, key)));
  assert.equal(await useSource(), undefined);
  await writeFile(file, JSON.stringify(personal));

  const text = await secrets.get(ORGANIZATION_ISSUER_SECRET);
  assert.ok(text);
  const pin = JSON.parse(text) as Record<string, unknown>;
  await secrets.store(ORGANIZATION_ISSUER_SECRET, JSON.stringify({ ...pin, pending: {
    kind: 'update', publicKey: pin.publicKey, serial: pin.serial, issuedAt: pin.lastIssuedAt, layerHash: pin.layerHash
  } }));
  assert.equal(await useSource(), undefined);
  await secrets.store(ORGANIZATION_ISSUER_SECRET, text);
  assert.equal(await useSource(), 'usable');

  await appendKeyRecord(identityDir(storage), secrets, key, { kind: 'revoked', key }, { now: () => new Date(FIXED_NOW + 15) });
  assert.equal(await useSource(), undefined);
});

async function preparationWorld(secrets = new MemorySecrets()) {
  const { storage, key } = await installedPolicy(secrets);
  const world = createRosterWorld();
  const genesis = world.genesis().entry.hash;
  const clearance = { scale: 'org', level: 'Restricted', compartments: [], releasability: [] };
  const cleared = world.rosterEntry(world.lead, 'member.update', { member: world.lead.member, clearance }, genesis);
  const stream = '2'.repeat(32);
  const label = { ...clearance, level: 'Confidential', handling: [] };
  const unlabelled = world.grant(world.lead, { cell: stream, roster: cleared.hash, to: [world.lead] });
  const labelled = buildGrant(world.lead.signer, { ...unlabelled.payload, labelSealed: sealLabel(world.epochKeyOf(stream, 1), stream, 1, label) });
  world.grants.push(labelled);
  const head = world.rosterEntry(world.lead, 'cell.create', { cell: stream, epoch: 1, grant: grantHash(labelled) }, cleared.hash);
  const root = await mkdtemp(path.join(tmpdir(), 'fp-prep-'));
  let signatures = 0;
  const signer = { ...world.lead.signer, sign: (bytes: Buffer) => { signatures += 1; return world.lead.signer.sign(bytes); } };
  const open = async () => {
    const store = await ReplicaStore.open(root, { secrets, signer: async () => signer,
      keyStatus: async () => () => ({ state: 'active' }), now: () => new Date(FIXED_NOW) });
    assert.ok(store instanceof ReplicaStore);
    return store;
  };
  const store = await open();
  assert.ok('ok' in await store.ingestForeign(world.entries, [], async () => ({ ok: true })));
  assert.ok('ok' in await store.recordRosterHead(head.hash));
  const beforeGrant = await store.appendSnapshot();
  const request = { policyStorage: storage, pin: world.anchor(), stream, keys: world.epochKeyOf, snapshot: beforeGrant };
  const addGrants = async () => {
    assert.ok('ok' in await store.putGrant(world.project, 1, world.grants[0]));
    assert.ok('ok' in await store.putGrant(stream, 1, labelled));
    return { ...request, snapshot: await store.appendSnapshot() };
  };
  return { store, open, world, head, request, addGrants, replicaSignatures: () => signatures, storage, policyKey: key };
}

test('scoped prospective preparation proves the signed fence in memory and returns only a Boolean', async () => {
  const secrets = new MemorySecrets();
  const { store, world, head, request, addGrants } = await preparationWorld(secrets);
  assert.equal(await store['checkFrontierPreparation'](request), false, 'a grant in a test world alone is not a stored founding grant');
  const { snapshot } = await addGrants();
  assert.equal(await store['checkFrontierPreparation'](request), false, 'a changed replica snapshot is refused');
  const before = [...secrets.values.entries()];
  assert.equal(await store['checkFrontierPreparation']({ ...request, snapshot, keys: () => undefined }), false);
  assert.equal(await store['checkFrontierPreparation']({ ...request, snapshot }), true);
  assert.equal(await store.appendSnapshot(), snapshot);
  assert.deepEqual(store.entries(), world.entries);
  assert.deepEqual([...secrets.values.entries()], before);

  // Any application of a requirement is confined to this test's own synthetic world and keys.
  const folded = world.rosterEntry(world.lead, 'roster.require', { features: [CELL_ACCESS_FEATURE] }, head.hash, { at: new Date(FIXED_NOW + 10).toISOString() });
  assert.equal(world.foldRoster().positions.at(-1), folded.hash);
  assert.equal(store.has(folded.hash), false);
});

const CAPTURE_SLOT = 'nearAi.staff.frontierPolicyCapture.';
class AmbiguousCaptureSecrets extends MemorySecrets {
  public fault: 'none' | 'read-unavailable' = 'none';
  private didWrite = false;
  override async store(key: string, value: string): Promise<void> {
    await super.store(key, value);
    if (key.startsWith(CAPTURE_SLOT)) {
      this.didWrite = true;
      if (this.fault !== 'none') throw new Error('fixture write outcome is uncertain');
    }
  }
  override async get(key: string): Promise<string | undefined> {
    if (key.startsWith(CAPTURE_SLOT) && this.didWrite && this.fault === 'read-unavailable') throw new Error('fixture cannot confirm the protected write');
    return super.get(key);
  }
}

test('prospective policy restart does not select a staged file when directory durability was interrupted', async () => {
  const secrets = new AmbiguousCaptureSecrets();
  const { store, open, addGrants, replicaSignatures } = await preparationWorld(secrets);
  const request = await addGrants();
  const directory = path.join(store.dir, 'frontier-policy-captures');
  setFolderSyncProbe((dir) => {
    if (dir === directory) throw new Error('fixture interrupts directory durability');
  });
  try {
    assert.equal(await store['frontierPreparation'](request, 'capture'), 'unavailable');
  } finally {
    setFolderSyncProbe(undefined);
  }
  assert.ok((await readdir(directory)).some((file) => file.endsWith('.json')));
  assert.ok([...secrets.values.keys()].every((key) => !key.startsWith(CAPTURE_SLOT)));
  const reopened = await open();
  const signatures = replicaSignatures();
  assert.equal(await reopened['frontierPreparation'](request, 'reopen'), 'refused');
  assert.equal(replicaSignatures(), signatures);
  assert.equal(await reopened.appendSnapshot(), request.snapshot);
});

test('prospective policy reconciles an uncertain committed write exactly and refuses later trust or byte changes', async () => {
  const secrets = new AmbiguousCaptureSecrets();
  const { store, open, addGrants, replicaSignatures, storage, policyKey } = await preparationWorld(secrets);
  const request = await addGrants();
  secrets.fault = 'read-unavailable';
  assert.equal(await store['frontierPreparation'](request, 'capture'), 'unavailable');
  secrets.fault = 'none';
  const protectedEntry = [...secrets.values.entries()].find(([key]) => key.startsWith(CAPTURE_SLOT));
  assert.ok(protectedEntry);
  const [slot, exact] = protectedEntry;
  const pointer = JSON.parse(exact) as { artifact: string };
  const target = path.join(store.dir, 'frontier-policy-captures', `${pointer.artifact}.json`);
  const bytes = await readFile(target);
  if (process.platform !== 'win32') assert.equal((await stat(target)).mode & 0o777, 0o600);
  const reopened = await open();
  const signatures = replicaSignatures();
  assert.equal(await reopened['frontierPreparation'](request, 'reopen'), 'ready');
  assert.equal(await reopened['frontierPreparation'](request, 'capture'), 'ready');
  assert.equal(replicaSignatures(), signatures);
  assert.deepEqual(await readFile(target), bytes);
  assert.equal(await reopened.appendSnapshot(), request.snapshot);

  await secrets.store(slot, JSON.stringify({ ...pointer, artifact: 'a'.repeat(64) }));
  assert.equal(await reopened['frontierPreparation'](request, 'capture'), 'refused');
  assert.equal(replicaSignatures(), signatures);
  await secrets.store(slot, exact);
  await writeFile(target, Buffer.concat([bytes, Buffer.from('\n')]));
  assert.equal(await reopened['frontierPreparation'](request, 'reopen'), 'refused');
  await writeFile(target, bytes);

  const newerPolicy = policyDocumentFor({ key: policyKey, now: FIXED_NOW + 1 });
  await writeFile(path.join(gateDir(storage), POLICY_BUNDLE_FILE), JSON.stringify(signPersonalLayer(newerPolicy, policyKey)));
  await writeLastValid(secrets, { hash: bundleHash(newerPolicy), at: FIXED_NOW + 10 });
  assert.equal(await reopened['frontierPreparation'](request, 'reopen'), 'ready');

  const next = deviceKey('next-policy-identity');
  await appendKeyRecord(identityDir(storage), secrets, policyKey, { kind: 'rotated', key: policyKey, next }, { now: () => new Date(FIXED_NOW + 5) });
  assert.equal(await reopened['frontierPreparation'](request, 'reopen'), 'refused');
  assert.equal(await reopened.appendSnapshot(), request.snapshot);
});

test('prospective policy does not reopen after an authenticated organization issuer handover in this tranche', async () => {
  const secrets = new MemorySecrets();
  const { store, open, addGrants, storage, replicaSignatures } = await preparationWorld(secrets);
  const request = await addGrants();
  assert.equal(await store['frontierPreparation'](request, 'capture'), 'ready');
  const successor = issuerKey('successor');
  const handover = enrolmentTextFor(successor, { serial: 2, rotation: issuerKey(), now: FIXED_NOW + 1 });
  const changed = await new OrganizationStore(storage, secrets).accept(handover, { wordsConfirmed: true }, FIXED_NOW + 10);
  assert.equal(changed.kind, 'rotate');
  const reopened = await open();
  const signatures = replicaSignatures();
  assert.equal(await reopened['frontierPreparation'](request, 'reopen'), 'refused');
  assert.equal(replicaSignatures(), signatures);
});
