import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFrontierMembership, frontierRoot, frontierSigningBytes, verifiesFrontierCustody, verifiesFrontierMembership } from '../domain/replica/acceptedFrontier';
import type { FrontierLeaf, FrontierStatement } from '../domain/replica/acceptedFrontier';

import { grantHash } from '../domain/replica/cellKeys';
import { accessRevisionId, buildAccessCommitment } from '../domain/replica/rotationProof';
import { SCALE_PRESETS } from '../domain/gate/labels';
import { createRosterWorld, INVITE_EXPIRES } from './helpers/replicaRosterWorld';

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

test('custody requires the selected fence and evaluates the device at that fence after a handover', () => {
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
  const fence = world.rosterEntry(world.lead, 'roster.require', { features: ['cell-access@1'] }, pre.hash);
  const contents = buildFrontierMembership([first]);
  assert.ok(contents);
  const payload: FrontierStatement = { version: 1, project: world.project, genesis, stream: cell, before: pre.hash,
    requirement: fence.hash, heads: [{ writer: first.writer, sequence: 0, hash: first.hash }], membership: contents.commitment };
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
