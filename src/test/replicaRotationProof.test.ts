import assert from 'node:assert/strict';
import test from 'node:test';
import { accessPermitBytes, accessRevisionId, buildAccessCommitment, verifiesAccessWrite } from '../domain/replica/rotationProof';
import type { AccessPermit, AccessWriteContext, CellAccessDecision } from '../domain/replica/rotationProof';
import { isPersonKeyKind, requiresActionId } from '../domain/replica/sessionKeys';
import { fixedSigner } from './helpers/replicaWorld';
import { createRosterWorld } from './helpers/replicaRosterWorld';

const project = '0'.repeat(32);
const cell = '1'.repeat(32);
const predecessor = 'a'.repeat(64);
const certificate = 'b'.repeat(64);
const lead = fixedSigner('access-authority');
const writer = fixedSigner('hosted-writer');
const other = fixedSigner('another-hosted-writer');
const revisionId = accessRevisionId(project, null, predecessor, 'member.update', { member: 'mbr-analyst' });
const context: AccessWriteContext = {
  project, cell, epoch: 1, device: lead.writer, writer: writer.writer, certificate,
  authorityKey: (candidate) => candidate === lead.writer ? lead.publicKey : undefined
};

const decision: CellAccessDecision = { cell, epoch: 1, previousEpoch: 1, decision: 'continues', salt: 'c'.repeat(64), evidence: 'd'.repeat(64) };
const permit: AccessPermit = { project, revision: revisionId, predecessor, cell, epoch: 1, device: lead.writer, writer: writer.writer, certificate, authority: lead.writer };
const signed = { permit, signature: lead.signer.sign(accessPermitBytes(permit)) };

function fixture(rootSalt = decision.salt, signature = signed.signature) {
  const commitment = buildAccessCommitment(revisionId, [{ ...decision, salt: rootSalt }], [{ permit, signature }]);
  assert.ok(commitment);
  const proof = commitment.proof(cell, writer.writer);
  assert.ok(proof);
  return { revision: { id: revisionId, root: commitment.root, entry: 'e'.repeat(64), predecessor, cells: [cell] }, proof };
}

test('an append permit signed before the root verifies only for its exact subject and cell', () => {
  const { revision, proof } = fixture();
  assert.equal(verifiesAccessWrite(revision, proof, context), true);
  for (const mismatch of [
    { project: 'f'.repeat(32) }, { cell: 'f'.repeat(32) }, { epoch: 2 }, { writer: other.writer },
    { device: other.writer }, { certificate: 'f'.repeat(64) }, { certificate: null }, { authorityKey: () => undefined }
  ]) {
    assert.equal(verifiesAccessWrite(revision, proof, { ...context, ...mismatch }), false);
  }
  for (const invalid of [null, {}, { ...proof, cell: { ...proof.cell, count: 2 } }, { ...proof, cell: { ...proof.cell, index: 1 } },
    { ...proof, permitSiblings: proof.permitSiblings.slice(1) }, { ...proof, permitSiblings: Array(256) }]) {
    assert.equal(verifiesAccessWrite(revision, invalid, context), false);
  }
});

test('same-predecessor siblings use the finalized selected root even when their revision IDs match', () => {
  const first = fixture();
  const sibling = fixture('f'.repeat(64));
  assert.notEqual(first.revision.root, sibling.revision.root);
  assert.equal(verifiesAccessWrite(sibling.revision, first.proof, context), false);
  assert.equal(verifiesAccessWrite(sibling.revision, sibling.proof, context), true);
  const different = accessRevisionId(project, null, predecessor, 'member.update', { member: 'mbr-other' });
  assert.notEqual(different, revisionId);
  assert.equal(verifiesAccessWrite({ ...first.revision, id: different }, first.proof, context), false);
});

test('commitments reject duplicate slots and permits from another signature domain', () => {
  assert.equal(buildAccessCommitment(revisionId, [decision, decision], [signed]), undefined);
  assert.equal(buildAccessCommitment(revisionId, [decision], [signed, signed]), undefined);
  assert.equal(buildAccessCommitment(revisionId, [{ ...decision, decision: 'pending' }], [signed]), undefined);
  const wrong = fixture(decision.salt, lead.signer.sign(Buffer.from(revisionId)));
  assert.equal(verifiesAccessWrite(wrong.revision, wrong.proof, context), false);
});

test('a managed access commit needs the person key and an action ID', () => {
  assert.equal(isPersonKeyKind('cell.access.commit'), true);
  assert.equal(requiresActionId('cell.access.commit'), true);
});

test('a verified roster choice selects the root without treating a shared revision ID as a branch identifier', () => {
  const world = createRosterWorld();
  const genesis = world.genesis().entry.hash;
  const arm = world.rosterEntry(world.lead, 'roster.require', { features: ['cell-access@1'] }, genesis);
  const id = accessRevisionId(world.project, null, arm.hash, 'cell.access.commit', {});
  const common = { accessRevision: id };
  const before = world.rosterEntry(world.lead, 'cell.access.commit', { ...common, accessRoot: 'a'.repeat(64) }, arm.hash);
  const selected = world.rosterEntry(world.lead, 'cell.access.commit', { ...common, accessRoot: 'b'.repeat(64) }, arm.hash);
  const split = world.foldRoster();
  assert.equal(split.accessRevision, undefined);
  assert.deepEqual(split.pending[0]?.branches, [before.hash, selected.hash].sort());
  world.rosterEntry(world.lead, 'roster.choose', { chosen: selected.hash }, arm.hash);
  const chosen = world.foldRoster();
  assert.equal(chosen.accessRevision?.entry, selected.hash);
  assert.equal(chosen.accessRevision?.id, id);
  assert.equal(chosen.accessRevision?.root, 'b'.repeat(64));
});
