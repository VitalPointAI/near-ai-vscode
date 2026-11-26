import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { buildFrontierMembership, frontierSigningBytes, frontierV2CaptureCommitment, frontierV2Root, frontierV2SigningBytes } from '../domain/replica/acceptedFrontier';
import type { FrontierV2Statement } from '../domain/replica/acceptedFrontier';
import { buildGrant, grantHash, sealLabel } from '../domain/replica/cellKeys';
import { buildEntry, sha256Hex } from '../domain/replica/entry';
import type { SealedEntry } from '../domain/replica/entry';
import { CELL_ACCESS_FEATURE } from '../domain/replica/features';
import { isRosterWriterAt } from '../domain/replica/roster';
import { accessRevisionId, buildAccessCommitment } from '../domain/replica/rotationProof';
import { buildEnrolment, buildOrganizationLayer } from '../domain/gate/enrolment';
import { bundleHash } from '../domain/gate/bundle';
import { gateDir, POLICY_BUNDLE_FILE } from '../gate/bundleStore';
import { LAST_VALID_SECRET, writeLastValid } from '../gate/clockMarker';
import { ENROLMENT_RECORD_FILE, ORGANIZATION_DIR_NAME, ORGANIZATION_ISSUER_SECRET, OrganizationStore } from '../gate/organizationStore';
import { setFolderSyncProbe } from '../staff/staffFiles';
import { ReplicaStore } from '../staff/replica/store';
import { withFrontierPolicySource } from '../staff/replica/frontierPolicy';
import { identityDir } from '../team/identity';
import { appendKeyRecord, KEY_HISTORY_FILE, KEY_HISTORY_HEAD_SECRET } from '../team/keyHistory';
import { EXAMPLE_ORGANIZATION, enrolmentTextFor, organizationSections, rulesTextFor } from './helpers/enrolmentFixtures';
import { DAY_MS, deviceKey, FIXED_NOW, issuerKey, policyDocumentFor, signPersonalLayer } from './helpers/policyFixtures';
import { createRosterWorld, INVITE_EXPIRES } from './helpers/replicaRosterWorld';
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

async function preparationWorld(secrets = new MemorySecrets(), withDeputy = false) {
  const { storage, key } = await installedPolicy(secrets);
  const world = createRosterWorld();
  const genesis = world.genesis().entry.hash;
  const clearance = { scale: 'org', level: 'Restricted', compartments: [], releasability: [] };
  const cleared = world.rosterEntry(world.lead, 'member.update', { member: world.lead.member, clearance }, genesis);
  const stream = '2'.repeat(32);
  const label = { ...clearance, level: 'Confidential', handling: [] };
  const deputy = world.device('frontier-deputy', 'mbr-deputy');
  let predecessor = cleared.hash;
  if (withDeputy) {
    const member = { invite: 'deputy-invite', name: 'Deputy', seat: 'j2-chief', roles: ['member'], clearance };
    const invite = world.rosterEntry(world.lead, 'member.invite',
      { ...member, expiresAt: INVITE_EXPIRES, secretHash: 'a'.repeat(64) }, predecessor);
    const admitted = world.rosterEntry(world.lead, 'member.admit',
      { ...member, member: deputy.member, device: deputy.descriptor(2), agentSeats: [] }, invite.hash);
    predecessor = world.rosterEntry(world.lead, 'deputy.name', { member: deputy.member }, admitted.hash).hash;
  }
  const unlabelled = world.grant(world.lead, { cell: stream, roster: predecessor, to: withDeputy ? [world.lead, deputy] : [world.lead] });
  const labelled = buildGrant(world.lead.signer, { ...unlabelled.payload, labelSealed: sealLabel(world.epochKeyOf(stream, 1), stream, 1, label) });
  world.grants.push(labelled);
  const head = world.rosterEntry(world.lead, 'cell.create', { cell: stream, epoch: 1, grant: grantHash(labelled) }, predecessor);
  const root = await mkdtemp(path.join(tmpdir(), 'fp-prep-'));
  const clock = { now: FIXED_NOW };
  let signatures = 0;
  const signer = { ...world.lead.signer, sign: (bytes: Buffer) => { signatures += 1; return world.lead.signer.sign(bytes); } };
  const open = async () => {
    const store = await ReplicaStore.open(root, { secrets, signer: async () => signer,
      keyStatus: async () => () => ({ state: 'active' }), now: () => new Date(clock.now) });
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
  return { store, open, world, head, deputy, labelled, request, addGrants, replicaSignatures: () => signatures, storage, policyKey: key, clock };
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

test('an inert V2 fixture requires the frozen custodian and selected applied fence', async () => {
  const secrets = new MemorySecrets();
  const { store, open, world, head, deputy, labelled, addGrants } = await preparationWorld(secrets, true);
  const roster = world.foldRoster();
  assert.equal(roster.positions.at(-1), head.hash);
  assert.equal(isRosterWriterAt(roster, deputy.writer, roster.positions.length - 1), true);
  assert.ok(labelled.payload.wraps.some((wrap) => wrap.writer === deputy.writer));
  const request = await addGrants();
  assert.equal(await store['frontierPreparation'](request, 'capture'), 'ready');

  const pointer = [...secrets.values.entries()].find(([key]) => key.startsWith(CAPTURE_SLOT));
  assert.ok(pointer);
  const { artifact } = JSON.parse(pointer[1]) as { artifact: string };
  const bytes = await readFile(path.join(store.dir, 'frontier-policy-captures', `${artifact}.json`));
  const saved = JSON.parse(bytes.toString('utf8')) as { salt: string; entry: SealedEntry; requirement: string };
  const history = world.write(world.lead, { stream: request.stream, roster: head.hash, kind: 'product.create',
    data: { product: 'archived-product', section: 'j2', title: 'Archived product',
      roles: { owner: 'j2-chief', sectionLead: 'j2-lead', releaseGuard: 'release-guard' } } });
  const leaf = { kind: 'entry' as const, writer: history.writer, sequence: history.seq, hash: history.hash };
  const membership = buildFrontierMembership([leaf]);
  assert.ok(membership);
  const payload: FrontierV2Statement = { version: 2, project: world.project, genesis: request.pin.genesisHash,
    before: head.hash, requirement: saved.requirement, stream: request.stream,
    capture: frontierV2CaptureCommitment(saved.salt, sha256Hex(bytes)), heads: [{ writer: leaf.writer, sequence: leaf.sequence, hash: leaf.hash }],
    membership: membership.commitment };
  const root = frontierV2Root(payload);
  const sign = (writer = world.lead, statement = payload) => ({
    payload: statement, writer: writer.writer, signature: writer.signer.sign(frontierV2SigningBytes(statement, writer.writer))
  });
  const archive = { signed: sign(), entries: [history.entry], blobs: [], proofs: [{ leaf, proof: membership.proof(leaf) }] };
  assert.equal(await store['checkFrontierV2Fixture'](archive, { ...request, expectedSnapshot: request.snapshot, opening: undefined }), false);

  const id = accessRevisionId(world.project, null, saved.requirement, 'cell.access.commit', {});
  const cells = [world.project, request.stream].sort().map((cell) =>
    ({ cell, previousEpoch: 1, epoch: 1, decision: 'pending' as const, salt: 'b'.repeat(64), evidence: 'c'.repeat(64) }));
  const commitment = buildAccessCommitment(id, cells, [], root);
  const opening = commitment?.cellProof(request.stream);
  assert.ok(root && commitment && opening);
  const applied = buildEntry({ signer: world.lead.signer, stream: world.project, epoch: 1, key: world.epochKeyOf(world.project, 1),
    prev: saved.requirement, seq: saved.entry.header.seq + 1, body: { deps: [], roster: saved.requirement, lamport: head.lamport + 2,
      at: new Date(FIXED_NOW + 11).toISOString(), actor: { kind: 'person' }, kind: 'cell.access.commit',
      data: { rosterPrev: saved.requirement, accessRevision: id, accessRoot: commitment.root } } });
  assert.ok('ok' in await store.ingestForeign([saved.entry, applied.entry], [], async () => ({ ok: true })));
  assert.ok('ok' in await store.recordRosterHead(applied.hash));
  const expectedSnapshot = await store.appendSnapshot();
  const selected = { ...request, opening, expectedSnapshot };
  const before = [...secrets.values.entries()];
  const directories = await readdir(store.dir);
  assert.equal(await store['checkFrontierV2Fixture'](archive, selected), true);

  assert.equal(await store['checkFrontierV2Fixture']({ ...archive, signed: sign(deputy) }, selected), false);
  const { capture: _capture, ...legacy } = payload;
  const legacySignature = world.lead.signer.sign(frontierSigningBytes({ ...legacy, version: 1 }, world.lead.writer));
  assert.equal(await store['checkFrontierV2Fixture']({ ...archive, signed: { ...archive.signed, signature: legacySignature } }, selected), false);
  assert.equal(await store['checkFrontierV2Fixture']({ ...archive, signed: sign(world.lead, { ...payload, capture: '0'.repeat(64) }) }, selected), false);
  assert.equal(await store['checkFrontierV2Fixture']({ ...archive, entries: [] }, selected), false);
  assert.equal(await store['checkFrontierV2Fixture'](archive, { ...selected, snapshot: expectedSnapshot }), false);
  assert.equal(await store['checkFrontierV2Fixture'](archive, { ...selected, opening: buildAccessCommitment(id, cells, [], 'd'.repeat(64))?.cellProof(request.stream) }), false);
  const sibling = world.rosterEntry(world.lead, 'roster.require', { features: [CELL_ACCESS_FEATURE] }, head.hash,
    { at: new Date(FIXED_NOW + 9).toISOString() });
  const siblingPayload = { ...payload, requirement: sibling.hash };
  const siblingCommitment = buildAccessCommitment(accessRevisionId(world.project, null, sibling.hash, 'cell.access.commit', {}),
    cells, [], frontierV2Root(siblingPayload));
  assert.ok(siblingCommitment);
  assert.equal(await store['checkFrontierV2Fixture']({ ...archive, signed: sign(world.lead, siblingPayload) },
    { ...selected, opening: siblingCommitment.cellProof(request.stream) }), false);

  const changedPointer = JSON.stringify({ ...JSON.parse(pointer[1]), artifact: 'e'.repeat(64) });
  await secrets.store(pointer[0], changedPointer);
  assert.equal(await store['checkFrontierV2Fixture'](archive, selected), false);
  await secrets.store(pointer[0], pointer[1]);
  assert.deepEqual([...secrets.values.entries()], before);
  assert.deepEqual(await readdir(store.dir), directories);
  assert.equal(await store.appendSnapshot(), expectedSnapshot);
  assert.equal(await (await open())['checkFrontierV2Fixture'](archive, selected), true);

  const replacement = world.grant(world.lead, { cell: request.stream, roster: labelled.payload.roster, to: [world.lead] });
  assert.ok('ok' in await store.putGrant(request.stream, 1, replacement));
  const founding = path.join(store.dir, 'grants', request.stream, `1-${grantHash(labelled)}.json`);
  await rename(founding, `${founding}.preserved`);
  assert.equal(await store['checkFrontierV2Fixture'](archive, { ...selected, expectedSnapshot: await store.appendSnapshot() }), false);
});
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
  const currentPersonal = policyDocumentFor({ key: next, now: FIXED_NOW + 6 });
  await writeFile(path.join(gateDir(storage), POLICY_BUNDLE_FILE), JSON.stringify(signPersonalLayer(currentPersonal, next)));
  await writeLastValid(secrets, { hash: bundleHash(currentPersonal), at: FIXED_NOW + 10 });
  const sameIssuerUpdate = enrolmentTextFor(issuerKey(), { serial: 2, now: FIXED_NOW + 7 });
  const updated = await new OrganizationStore(storage, secrets).accept(sameIssuerUpdate, { wordsConfirmed: true }, FIXED_NOW + 10);
  assert.equal(updated.kind, 'update');
  assert.equal(await reopened['frontierPreparation'](request, 'reopen'), 'ready');
  assert.deepEqual(await readFile(target), bytes);
  assert.equal(replicaSignatures(), signatures);

  await appendKeyRecord(identityDir(storage), secrets, next, { kind: 'revoked', key: policyKey }, { now: () => new Date(FIXED_NOW + 8) });
  assert.equal(await withFrontierPolicySource(storage, secrets, () => new Date(FIXED_NOW + 10), async (capture) => (await capture()) !== undefined), true);
  assert.equal(await reopened['frontierPreparation'](request, 'reopen'), 'refused');
  assert.equal(await reopened.appendSnapshot(), request.snapshot);
});

test('prospective policy refuses an accepted organization handover issued before the historical capture', async () => {
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

test('prospective policy refuses a healthy current personal history whose signed prefix differs', async () => {
  const secrets = new MemorySecrets();
  const { store, open, addGrants, storage, policyKey, replicaSignatures } = await preparationWorld(secrets);
  const request = await addGrants();
  assert.equal(await store['frontierPreparation'](request, 'capture'), 'ready');
  const otherSecrets = new MemorySecrets();
  const other = await mkdtemp(path.join(tmpdir(), 'fp-history-'));
  await appendKeyRecord(other, otherSecrets, policyKey, { kind: 'created', key: policyKey }, { now: () => new Date(FIXED_NOW + 1) });
  const next = deviceKey('different-history-successor');
  await appendKeyRecord(other, otherSecrets, policyKey, { kind: 'rotated', key: policyKey, next }, { now: () => new Date(FIXED_NOW + 5) });
  const otherHead = await otherSecrets.get(KEY_HISTORY_HEAD_SECRET);
  assert.ok(otherHead);
  await writeFile(path.join(identityDir(storage), KEY_HISTORY_FILE), await readFile(path.join(other, KEY_HISTORY_FILE)));
  await secrets.store(KEY_HISTORY_HEAD_SECRET, otherHead);
  assert.equal(await withFrontierPolicySource(storage, secrets, () => new Date(FIXED_NOW + 10), async (capture) => (await capture()) !== undefined), true);
  const reopened = await open();
  const signatures = replicaSignatures();
  assert.equal(await reopened['frontierPreparation'](request, 'reopen'), 'refused');
  assert.equal(replicaSignatures(), signatures);
});

test('private reopen requires the exact protected accepted one-hop handover and does not write', async () => {
  const secrets = new MemorySecrets();
  const { store, open, addGrants, storage, replicaSignatures, clock } = await preparationWorld(secrets);
  const request = await addGrants();
  assert.equal(await store['frontierPreparation'](request, 'capture'), 'ready');
  const old = issuerKey();
  const next = issuerKey('exact-protected-successor');
  const at = FIXED_NOW + DAY_MS;
  const layer = buildOrganizationLayer(next, organizationSections(), { now: at, days: 90 });
  const signed = (now: number) => JSON.stringify(buildEnrolment(next, { layer, now, serial: 2, days: 1, rotation: old, organization: EXAMPLE_ORGANIZATION }));
  const exact = signed(at);
  const sibling = signed(at + 1);
  const organization = new OrganizationStore(storage, secrets);
  assert.equal((await organization.accept(exact, { wordsConfirmed: true }, at)).kind, 'rotate');
  clock.now = at + 2 * DAY_MS;
  const reopened = await open();
  const marker = await secrets.get(ORGANIZATION_ISSUER_SECRET);
  assert.ok(marker);
  const pinned = JSON.parse(marker) as Record<string, unknown>;
  assert.ok(pinned.acceptedHandover);
  const record = path.join(gateDir(storage), ORGANIZATION_DIR_NAME, ENROLMENT_RECORD_FILE);
  const retained = await readFile(record);
  const signatures = replicaSignatures();
  const protectedBefore = [...secrets.values.entries()];
  const captureDir = path.join(store.dir, 'frontier-policy-captures');
  const captureFiles = await readdir(captureDir);
  const captureBytes = await Promise.all(captureFiles.map((file) => readFile(path.join(captureDir, file))));
  assert.equal(await reopened['frontierPreparation'](request, 'reopen'), 'ready', 'the accepted record is checked at authentic issue time');
  assert.equal(replicaSignatures(), signatures);
  assert.deepEqual([...secrets.values.entries()], protectedBefore);
  assert.deepEqual(await readdir(captureDir), captureFiles);
  assert.deepEqual(await Promise.all(captureFiles.map((file) => readFile(path.join(captureDir, file)))), captureBytes);
  assert.deepEqual(await readFile(record), retained);

  await writeFile(record, sibling);
  assert.equal((await organization.load(clock.now)).state, 'valid', 'ordinary current policy still verifies');
  assert.equal(await reopened['frontierPreparation'](request, 'reopen'), 'refused', 'an authentic sibling with the same pinned layer is not the accepted edge');

  await writeFile(record, retained);
  await rename(record, `${record}.fixture-kept`);
  assert.equal(await reopened['frontierPreparation'](request, 'reopen'), 'refused');
  await rename(`${record}.fixture-kept`, record);
  const { acceptedHandover: _proof, ...legacy } = pinned;
  await secrets.store(ORGANIZATION_ISSUER_SECRET, JSON.stringify(legacy));
  assert.equal(await reopened['frontierPreparation'](request, 'reopen'), 'refused');
  const mismatchedRoot = { ...pinned, acceptedHandover: { ...(pinned.acceptedHandover as object), previousLayer: 'f'.repeat(64) } };
  await secrets.store(ORGANIZATION_ISSUER_SECRET, JSON.stringify(mismatchedRoot));
  assert.equal(await reopened['frontierPreparation'](request, 'reopen'), 'refused');
  await secrets.store(ORGANIZATION_ISSUER_SECRET, marker);

  clock.now += 1;
  assert.equal((await organization.accept(rulesTextFor(next, organizationSections(), { now: clock.now }), {}, clock.now)).kind, 'update');
  assert.equal(await reopened['frontierPreparation'](request, 'reopen'), 'refused');
  assert.equal(replicaSignatures(), signatures);
  assert.equal(await reopened.appendSnapshot(), request.snapshot);
});
