import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { buildFrontierMembership, verifiesFrontierMembership } from '../domain/replica/acceptedFrontier';
import type { FrontierLeaf } from '../domain/replica/acceptedFrontier';
import { frontierRoot, frontierSigningBytes, openAcceptedFrontier, openStoredAcceptedFrontier, putAcceptedFrontier, verifiesFrontierCustody } from './helpers/acceptedFrontierV1';
import type { FrontierStatement } from './helpers/acceptedFrontierV1';
import { sealBlob } from '../domain/replica/entry';
import { grantHash } from '../domain/replica/cellKeys';
import { accessRevisionId, buildAccessCommitment } from '../domain/replica/rotationProof';
import { SCALE_PRESETS } from '../domain/gate/labels';
import type { RosterWorld } from './helpers/replicaRosterWorld';
import { createRosterWorld, INVITE_EXPIRES } from './helpers/replicaRosterWorld';
import { setFolderSyncProbe } from '../staff/staffFiles';
import { ReplicaStore } from '../staff/replica/store';
import { MemorySecrets } from './helpers/teamHarness';

const hash = (char: string) => char.repeat(64);
const first: FrontierLeaf = { kind: 'entry', writer: hash('a'), sequence: 0, hash: hash('b') };
const second: FrontierLeaf = { kind: 'entry', writer: hash('a'), sequence: 1, hash: hash('c') };
const content: FrontierLeaf = { kind: 'blob', entry: hash('b'), hash: hash('d') };

test('exact archive membership is canonical and binds kind, accepted entry and content', () => {
  const inventory = buildFrontierMembership([first, second, content]);
  const permuted = buildFrontierMembership([content, second, first]);
  assert.ok(inventory && permuted);
  assert.deepEqual(inventory.commitment, permuted.commitment);
  const proof = inventory.proof(content);
  assert.ok(proof);
  assert.equal(verifiesFrontierMembership(inventory.commitment, content, proof), true);
  assert.equal(verifiesFrontierMembership(inventory.commitment, { ...content, entry: hash('c') }, proof), false);
  assert.equal(verifiesFrontierMembership(inventory.commitment, { ...content, hash: hash('e') }, proof), false);
  assert.equal(verifiesFrontierMembership(inventory.commitment, first, proof), false);
});

test('frontier membership checks exact sequence occupancy, counts and bounded path shape', () => {
  assert.equal(buildFrontierMembership([first, { ...first, hash: hash('f') }]), undefined);
  assert.equal(buildFrontierMembership([first, content, content]), undefined);
  assert.equal(buildFrontierMembership([{ ...first, hash: hash('F') }]), undefined);
  assert.equal(buildFrontierMembership([{ ...first, sequence: -0 }]), undefined);
  const inventory = buildFrontierMembership([first, second, content]);
  assert.ok(inventory);
  const proof = inventory.proof(second);
  assert.ok(proof);
  assert.equal(verifiesFrontierMembership(inventory.commitment, second, proof), true);
  assert.equal(verifiesFrontierMembership(inventory.commitment, { ...second, hash: hash('f') }, proof), false);
  assert.equal(verifiesFrontierMembership({ ...inventory.commitment, entries: 1, blobs: 2 }, second, proof), false);
  assert.equal(verifiesFrontierMembership(inventory.commitment, second, { ...proof, index: 3 }), false);
  assert.equal(verifiesFrontierMembership(inventory.commitment, second, { ...proof, siblings: proof.siblings.slice(1) }), false);
  assert.equal(verifiesFrontierMembership(inventory.commitment, second, { ...proof, siblings: Array(2) }), false);
  const empty = buildFrontierMembership([]);
  assert.ok(empty);
  assert.notEqual(empty.commitment.root, inventory.commitment.root);
  assert.equal(empty.proof(first), undefined);
});

function custodyFixture(inventory: (world: RosterWorld, cell: string, at: string) => readonly FrontierLeaf[] = () => [first]) {
  const world = createRosterWorld();
  const cell = '2'.repeat(32);
  const incoming = world.device('next-custodian', 'mbr-next');
  const clearance = { scale: 'org', level: 'Restricted', compartments: [], releasability: [] };
  const label = { ...clearance, level: 'Confidential', handling: [] };
  const genesis = world.genesis().entry.hash;
  const cleared = world.rosterEntry(world.lead, 'member.update', { member: world.lead.member, clearance }, genesis);
  const invited = world.rosterEntry(world.lead, 'member.invite', { invite: 'next-invite', name: 'Next', seat: 'j2-chief',
    roles: ['member'], clearance, expiresAt: INVITE_EXPIRES, secretHash: hash('a') }, cleared.hash);
  const admitted = world.rosterEntry(world.lead, 'member.admit', { member: incoming.member, invite: 'next-invite', name: 'Next',
    seat: 'j2-chief', roles: ['member'], clearance, device: incoming.descriptor(2), agentSeats: [] }, invited.hash);
  const grant = world.grant(world.lead, { cell, to: [world.lead, incoming], roster: admitted.hash });
  const pre = world.rosterEntry(world.lead, 'cell.create', { cell, epoch: 1, grant: grantHash(grant) }, admitted.hash);
  const leaves = inventory(world, cell, pre.hash);
  const fence = world.rosterEntry(world.lead, 'roster.require', { features: ['cell-access@1'] }, pre.hash);
  const contents = buildFrontierMembership(leaves);
  assert.ok(contents);
  const payload: FrontierStatement = { version: 1, project: world.project, genesis, stream: cell, before: pre.hash,
    requirement: fence.hash, heads: leaves.flatMap((leaf) => leaf.kind === 'entry' ? [{ writer: leaf.writer, sequence: leaf.sequence, hash: leaf.hash }] : []), membership: contents.commitment };
  const root = frontierRoot(payload);
  assert.ok(root);
  const id = accessRevisionId(world.project, null, fence.hash, 'cell.access.commit', {});
  const cells = [world.project, cell].sort().map((stream) =>
    ({ cell: stream, previousEpoch: 1, epoch: 1, decision: 'pending' as const, salt: hash('b'), evidence: hash('c') }));
  const commitment = buildAccessCommitment(id, cells, [], root);
  const opening = commitment?.cellProof(cell);
  assert.ok(commitment && opening);
  const selected = world.rosterEntry(world.lead, 'cell.access.commit', { accessRevision: id, accessRoot: commitment.root }, fence.hash);
  const after = world.rosterEntry(world.lead, 'lead.handover', { to: incoming.member, reason: 'planned' }, selected.hash);
  const roster = world.foldRoster();
  assert.equal(roster.positions.at(-1), after.hash);
  assert.equal(roster.accessRevision?.entry, selected.hash);
  const signed = (custodian: typeof world.lead) => ({
    payload, writer: custodian.writer, signature: custodian.signer.sign(frontierSigningBytes(payload, custodian.writer))
  });
  const within = { scales: SCALE_PRESETS, mappings: [], now: Date.parse('2026-03-01T00:00:00Z') };
  const context = { roster, opening, pin: { project: world.project, genesis }, accessEntry: selected.hash,
    historicalPolicyAt: (stream: string, at: string, epoch: number) =>
      stream === cell && at === pre.hash && epoch === 1 ? { label, context: within } : undefined };
  return { world, cell, incoming, context, id, cells, signed, payload, after, contents };
}

test('custody requires the selected fence and evaluates the device at that fence after a handover', () => {
  const { world, cell, incoming, context, id, cells, signed, payload, after } = custodyFixture();
  assert.equal(verifiesFrontierCustody(signed(world.lead), context), true);
  assert.equal(verifiesFrontierCustody(signed(incoming), context), false);
  assert.equal(verifiesFrontierCustody(signed(world.lead), { ...context, historicalPolicyAt: () => undefined }), false);
  assert.equal(verifiesFrontierCustody(signed(world.lead), { ...context, pin: { ...context.pin, genesis: hash('f') } }), false);
  assert.equal(verifiesFrontierCustody(signed(world.lead), { ...context, accessEntry: hash('e') }), false);
  const wrong = buildAccessCommitment(id, cells, [], hash('d'))?.cellProof(cell);
  assert.ok(wrong);
  assert.equal(verifiesFrontierCustody(signed(world.lead), { ...context, opening: wrong }), false);
  const mismatched = { ...payload, before: after.hash };
  assert.equal(verifiesFrontierCustody({
    payload: mismatched, writer: world.lead.writer, signature: world.lead.signer.sign(frontierSigningBytes(mismatched, world.lead.writer))
  }, context), false);
});

function archiveFixture(commitNested: boolean) {
  const result = custodyFixture((world, cell, at) => {
    const nested = sealBlob(world.epochKeyOf(cell, 1), cell, 1, Buffer.from(JSON.stringify({ text: 'Archived text', header: {} })));
    const written = world.write(world.lead, { stream: cell, kind: 'version.propose', roster: at,
      data: { product: 'archive-fixture', hash: hash('a'), textBlob: nested.hash, snapshot: Buffer.alloc(13_000).toString('base64url'), pins: [] } });
    const overflow = [...world.blobs.values()].at(-1);
    assert.ok(overflow);
    world.blobs.set(nested.hash, nested);
    const leaves: FrontierLeaf[] = [
      { kind: 'entry', writer: written.writer, sequence: written.seq, hash: written.hash },
      { kind: 'blob', entry: written.hash, hash: overflow.hash }
    ];
    if (commitNested) leaves.push({ kind: 'blob', entry: written.hash, hash: nested.hash });
    return leaves;
  });
  const { world, cell, contents, signed, context } = result;
  const entries = world.entries.filter((entry) => entry.header.stream === cell);
  const { heads } = result.payload;
  const blobs = [...world.blobs.values()];
  const leaves: FrontierLeaf[] = [
    ...heads.map((head) => ({ kind: 'entry' as const, ...head })),
    ...blobs.map((blob) => ({ kind: 'blob' as const, entry: heads[0].hash, hash: blob.hash }))
  ];
  const proofs = leaves.flatMap((leaf) => {
    const proof = contents.proof(leaf);
    return proof === undefined ? [] : [{ leaf, proof }];
  });
  const file = { signed: signed(world.lead), entries, blobs: commitNested ? blobs : blobs.slice(0, 1), proofs };
  const complete = { ...context, historicalKey: (stream: string, epoch: number) => stream === cell && epoch === 1 ? world.epochKeyOf(cell, 1) : undefined };
  return { file, complete, world, cell, incoming: result.incoming, after: result.after };
}

test('a read-only frontier requires every signed nested reference after opening the overflow body', () => {
  const { file, complete } = archiveFixture(true);
  assert.equal(file.blobs.length, 2);
  const opened = openAcceptedFrontier(file, complete);
  assert.equal(opened.status, 'ready');
  if (opened.status === 'ready') {
    assert.equal(opened.entries.length, 1);
    assert.equal(opened.blobs.length, 2);
    assert.equal(Object.isFrozen(opened.entries[0]), true);
  }
  assert.equal(openAcceptedFrontier(JSON.parse(JSON.stringify(file)), complete).status, 'ready');
  assert.equal(openAcceptedFrontier({ ...file, blobs: file.blobs.slice(0, 1) }, complete).status, 'waiting');
  assert.equal(openAcceptedFrontier(file, { ...complete, historicalKey: () => undefined }).status, 'waiting');

  const omitted = archiveFixture(false);
  assert.equal(verifiesFrontierCustody(omitted.file.signed, omitted.complete), true);
  assert.equal(openAcceptedFrontier(omitted.file, omitted.complete).status, 'refused');
});

test('a durable archive is private, exact and tied to the verified current signed selection and local reader', async () => {
  const { file, complete, world, cell, incoming, after } = archiveFixture(true);
  const root = await mkdtemp(path.join(tmpdir(), 'af-'));
  const secrets = new MemorySecrets();
  const deps = { secrets, signer: async () => world.lead.signer, keyStatus: async () => () => ({ state: 'active' as const }) };
  const store = await ReplicaStore.open(root, deps);
  assert.ok(store instanceof ReplicaStore);
  const rosterEntries = world.entries.filter((entry) => entry.header.stream === world.project);
  assert.ok('ok' in await store.ingestForeign(rosterEntries, [], async () => ({ ok: true })));
  assert.ok('ok' in await store.recordRosterHead(after.hash));
  const request = { ...complete, stream: cell, reader: world.lead.writer, expectedSnapshot: await store.appendSnapshot() };
  const bytes = Buffer.from(JSON.stringify(file, null, 2) + '\n');
  assert.equal((await putAcceptedFrontier(store, bytes, { ...request, historicalKey: () => undefined })).status, 'waiting');
  assert.equal((await putAcceptedFrontier(store, bytes, { ...request, reader: incoming.writer })).status, 'refused');
  const privateDir = path.join(store.dir, 'accepted-frontiers');
  setFolderSyncProbe((dir) => {
    if (dir === privateDir) throw new Error('fixture interrupts before publication');
  });
  try {
    assert.equal((await putAcceptedFrontier(store, bytes, request)).status, 'refused');
  } finally {
    setFolderSyncProbe(undefined);
  }
  assert.deepEqual((await readdir(privateDir)).filter((name) => name.endsWith('.json')), []);

  const written = await putAcceptedFrontier(store, bytes, request);
  assert.equal(written.status, 'ready');
  if (written.status !== 'ready') return;
  assert.deepEqual(await putAcceptedFrontier(store, bytes, request), written);
  const target = path.join(privateDir, `${written.handle}.json`);
  assert.deepEqual(await readFile(target), bytes);
  if (process.platform !== 'win32') assert.equal((await stat(target)).mode & 0o777, 0o600);
  const reopened = await ReplicaStore.open(root, deps);
  assert.ok(reopened instanceof ReplicaStore);
  const read = await openStoredAcceptedFrontier(reopened, written.handle, request);
  assert.equal(read.status, 'ready');
  assert.ok(reopened.entries().every((entry) => entry.header.stream !== cell));
  for (const blob of file.blobs) assert.equal(await reopened.blob(blob.hash), undefined);

  const other = await ReplicaStore.open(root, { ...deps, signer: async () => incoming.signer });
  assert.ok(other instanceof ReplicaStore);
  assert.equal((await openStoredAcceptedFrontier(other, written.handle, request)).status, 'refused');
  assert.equal((await openStoredAcceptedFrontier(other, written.handle, { ...request, reader: incoming.writer })).status, 'refused');

  const next = world.rosterEntry(incoming, 'lead.handover', { to: world.lead.member, reason: 'planned' }, after.hash);
  assert.ok('ok' in await reopened.ingestForeign([next.entry], [], async () => ({ ok: true })));
  assert.ok('ok' in await reopened.recordRosterHead(next.hash));
  assert.equal((await putAcceptedFrontier(store, bytes, request)).status, 'refused');
  assert.equal((await openStoredAcceptedFrontier(reopened, written.handle, request)).status, 'refused');
  const selectedAgain = { ...request, roster: world.foldRoster(), expectedSnapshot: await reopened.appendSnapshot() };
  assert.equal((await openStoredAcceptedFrontier(reopened, written.handle, selectedAgain)).status, 'refused');

  const stagedAgain = await putAcceptedFrontier(reopened, bytes, selectedAgain);
  assert.equal(stagedAgain.status, 'ready');
  if (stagedAgain.status !== 'ready') return;
  assert.notEqual(stagedAgain.handle, written.handle);
  await writeFile(path.join(privateDir, `${stagedAgain.handle}.json`), JSON.stringify(file));
  assert.equal((await openStoredAcceptedFrontier(reopened, stagedAgain.handle, selectedAgain)).status, 'refused');
  assert.equal((await putAcceptedFrontier(reopened, bytes, selectedAgain)).status, 'refused');
});
