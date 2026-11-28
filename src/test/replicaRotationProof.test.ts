import assert from 'node:assert/strict';
import test from 'node:test';
import { accessPermitBytes, accessRevisionId, buildAccessCommitment, verifiesAccessWrite } from '../domain/replica/rotationProof';
import type { AccessPermit, AccessWriteContext, CellAccessDecision } from '../domain/replica/rotationProof';
import { advanceGrantEvidence, grantEvidenceHash, matchesGrantEvidence } from '../domain/replica/rotationGrants';
import type { GrantEvidence } from '../domain/replica/rotationGrants';
import { grantHash } from '../domain/replica/cellKeys';
import { foldRoster, prepareManagedWithdrawal } from '../domain/replica/roster';
import { isPersonKeyKind, requiresActionId } from '../domain/replica/sessionKeys';
import { fixedSigner } from './helpers/replicaWorld';
import { createRosterWorld, DEMO_CLEARANCE, INVITE_EXPIRES } from './helpers/replicaRosterWorld';

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

test('managed grant evidence requires the exact page set and recipient union', () => {
  const grant = { hash: '1'.repeat(64), pages: ['2'.repeat(64), '3'.repeat(64)], recipients: [lead.writer, writer.writer].sort() };
  const evidence: GrantEvidence = { project, cell, epoch: 1, policy: '4'.repeat(64), grants: [grant], excluded: [] };
  assert.ok(grantEvidenceHash(evidence));
  assert.equal(matchesGrantEvidence(evidence, grant), true);
  assert.equal(matchesGrantEvidence(evidence, { ...grant, pages: grant.pages.slice(1) }), false);
  assert.equal(matchesGrantEvidence(evidence, { ...grant, recipients: [lead.writer] }), false);
  assert.equal(matchesGrantEvidence(evidence, { ...grant, hash: '5'.repeat(64) }), false);
  assert.notEqual(grantEvidenceHash(evidence), grantEvidenceHash({ ...evidence, policy: '6'.repeat(64) }));
  assert.equal(grantEvidenceHash({ ...evidence, grants: [grant, grant] }), undefined);
});

test('interrupted managed rotations retain earlier recipients and overlapping exclusions until a safe next epoch', () => {
  const grant = { hash: '1'.repeat(64), pages: [], recipients: [lead.writer, writer.writer, other.writer].sort() };
  const evidence: GrantEvidence = { project, cell, epoch: 1, policy: null, grants: [grant], excluded: [] };
  const interrupted = advanceGrantEvidence(evidence, { epoch: 1, grants: [], excluded: [writer.writer] });
  assert.ok(interrupted);
  const resumed = advanceGrantEvidence(interrupted, { epoch: 1, grants: [], excluded: [other.writer] });
  assert.ok(resumed);
  assert.deepEqual(resumed.excluded, [writer.writer, other.writer].sort());
  assert.deepEqual(resumed.grants, [grant]);
  const later = { hash: '2'.repeat(64), pages: [], recipients: [writer.writer] };
  assert.equal(advanceGrantEvidence(resumed, { epoch: 1, grants: [later], excluded: [] }), undefined);
  assert.equal(advanceGrantEvidence(resumed, { epoch: 2, grants: [later], excluded: [] }), undefined);
  const next = { ...later, recipients: [lead.writer] };
  const committed = advanceGrantEvidence(resumed, { epoch: 2, grants: [next], excluded: [] });
  assert.ok(committed);
  assert.deepEqual(committed.grants, [next]);
  const additional = { ...next, hash: '7'.repeat(64) };
  assert.deepEqual(advanceGrantEvidence(committed, { epoch: 2, grants: [additional], excluded: [] })?.grants, [next, additional]);
});

test('the fold releases a staged managed grant only with exact cell evidence under its selected roster root', () => {
  const world = createRosterWorld();
  const genesis = world.genesis().entry.hash;
  const arm = world.rosterEntry(world.lead, 'roster.require', { features: ['cell-access@1'] }, genesis);
  const grant = world.grant(world.lead, { roster: arm.hash, to: [world.lead] });
  const hash = grantHash(grant);
  const evidence = { project: world.project, cell: world.project, epoch: 1, policy: null,
    grants: [{ hash, pages: [], recipients: [world.lead.writer] }], excluded: [] };
  const digest = grantEvidenceHash(evidence);
  assert.ok(digest);
  const id = accessRevisionId(world.project, null, arm.hash, 'cell.access.commit', {});
  const committed = buildAccessCommitment(id, [{ ...decision, cell: world.project, evidence: digest }], []);
  assert.ok(committed);
  const binding = world.rosterEntry(world.lead, 'cell.access.commit', { accessRevision: id, accessRoot: committed.root }, arm.hash);
  const proof = committed.cellProof(world.project);
  assert.ok(proof);
  const input = { entries: world.entries, anchor: world.anchor(), keys: world.ringFor(world.lead),
    blobs: (blob: string) => world.blobs.get(blob), grants: world.grants, now: new Date('2026-11-19T12:00:00.000Z') };
  const placed = (openings: readonly unknown[]): boolean | undefined => foldRoster({ ...input, grantEvidence: openings })
    .cells.cells.get(world.project)?.grants.some((item) => item.hash === hash);
  const opening = { ...proof, entry: binding.hash, evidence };
  assert.equal(placed([]), false);
  assert.equal(placed([{ ...opening, entry: genesis }]), false);
  assert.equal(placed([{ ...opening, evidence: { ...evidence, grants: [] } }]), false);
  assert.equal(placed([opening]), true);
  const delivered = { opening, grants: [grant] };
  const withoutRaw = { ...input, grants: input.grants.filter((item) => grantHash(item) !== hash), grantEvidence: [delivered] };
  const stagedBeforeRoot = foldRoster({ ...withoutRaw, entries: world.entries.slice(0, -1) });
  assert.equal(stagedBeforeRoot.cells.cells.get(world.project)?.grants.some((item) => item.hash === hash), false);
  const promoted = foldRoster(withoutRaw);
  assert.equal(promoted.cells.cells.get(world.project)?.grants.some((item) => item.hash === hash), true);
  assert.ok('accessGrants' in promoted && promoted.accessGrants instanceof Map);
  assert.equal(promoted.accessGrants.get(world.project)?.entry, binding.hash);
});

test('scoped withdrawal uses all selected private manifests, including recipients whose wraps have not arrived', () => {
  const world = createRosterWorld();
  const base = world.project;
  const unchanged = '5'.repeat(32);
  const closes = '6'.repeat(32);
  const peer = world.device('withdrawal-recipient', 'mbr-analyst');
  const genesis = world.genesis();
  const invited = world.rosterEntry(world.lead, 'member.invite', { invite: 'analyst-invite', name: 'Mo Analyst', seat: 'j2-chief',
    roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: 'e'.repeat(64) }, genesis.entry.hash);
  const admitted = world.rosterEntry(world.lead, 'member.admit', { member: peer.member, invite: 'analyst-invite', name: 'Mo Analyst',
    seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, device: peer.descriptor(2), agentSeats: [] }, invited.hash);
  const stableGrant = world.grant(world.lead, { cell: unchanged, roster: admitted.hash, to: [world.lead] });
  const createStable = world.rosterEntry(world.lead, 'cell.create', { cell: unchanged, epoch: 1, grant: grantHash(stableGrant) }, admitted.hash);
  const closingGrant = world.grant(world.lead, { cell: closes, roster: createStable.hash, to: [peer] });
  const createClosing = world.rosterEntry(world.lead, 'cell.create', { cell: closes, epoch: 1, grant: grantHash(closingGrant) }, createStable.hash);
  const arm = world.rosterEntry(world.lead, 'roster.require', { features: ['cell-access@1'] }, createClosing.hash);
  const id = accessRevisionId(base, null, arm.hash, 'cell.access.commit', {});
  const late = 'f'.repeat(64);
  const commitments = (items: Array<[string, string]>) => items
    .map(([hash, recipient]) => ({ hash, pages: [], recipients: [recipient] }))
    .sort((a, b) => a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0);
  const manifests: GrantEvidence[] = [
    { project: base, cell: base, epoch: 1, policy: null, grants: commitments([[grantHash(genesis.grant), world.lead.writer], [late, peer.writer]]), excluded: [] },
    { project: base, cell: unchanged, epoch: 1, policy: null, grants: commitments([[grantHash(stableGrant), world.lead.writer]]), excluded: [] },
    { project: base, cell: closes, epoch: 1, policy: null, grants: commitments([[grantHash(closingGrant), peer.writer]]), excluded: [] }
  ].sort((a, b) => a.cell < b.cell ? -1 : 1);
  const committed = buildAccessCommitment(id, manifests.map((manifest) => {
    const evidence = grantEvidenceHash(manifest);
    assert.ok(evidence);
    return { ...decision, cell: manifest.cell, evidence };
  }), []);
  assert.ok(committed);
  const bound = world.rosterEntry(world.lead, 'cell.access.commit', { accessRevision: id, accessRoot: committed.root }, arm.hash);
  const receipts = manifests.map((evidence) => ({ ...committed.cellProof(evidence.cell), entry: bound.hash, evidence }));
  const folded = (grantEvidence: readonly unknown[]) => foldRoster({
    entries: world.entries, anchor: world.anchor(), keys: world.ringFor(world.lead), blobs: (blob) => world.blobs.get(blob),
    grants: [genesis.grant, stableGrant], grantEvidence, now: new Date('2026-11-19T12:00:00.000Z')
  });
  const state = folded(receipts);
  assert.equal(state.cells.cells.get(base)?.grants.some((grant) => grant.hash === late), false);
  assert.equal(prepareManagedWithdrawal(folded(receipts.slice(0, -1)), world.lead.writer, { member: peer.member }) === undefined, true);
  assert.equal(prepareManagedWithdrawal(state, peer.writer, { member: world.lead.member }) === undefined, true);
  assert.equal(prepareManagedWithdrawal(state, world.lead.writer, { member: peer.member, writer: world.lead.writer }) === undefined, true);
  const plan = prepareManagedWithdrawal(state, world.lead.writer, { member: peer.member });
  assert.ok(plan);
  const cells = new Map(plan.cells.map((item) => [item.evidence.cell, item]));
  assert.equal(plan.priorEntry, bound.hash);
  assert.equal(plan.priorRoot, committed.root);
  assert.equal(plan.revision, accessRevisionId(base, id, bound.hash, 'member.remove', { member: peer.member }));
  assert.deepEqual(cells.get(base)?.evidence.excluded, [peer.writer]);
  assert.equal(cells.get(base)?.decision, 'pending');
  assert.deepEqual(cells.get(base)?.recipients, [world.lead.writer]);
  assert.equal(cells.get(unchanged)?.decision, 'continues');
  assert.equal(cells.get(closes)?.decision, 'closed');
  assert.deepEqual(cells.get(closes)?.recipients, []);
  const revoke = prepareManagedWithdrawal(state, world.lead.writer, { member: peer.member, writer: peer.writer });
  assert.equal(revoke?.kind, 'device.revoke');
  assert.equal(revoke?.revision, accessRevisionId(base, id, bound.hash, 'device.revoke', { member: peer.member, writer: peer.writer }));
});
