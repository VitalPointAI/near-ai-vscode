import assert from 'node:assert/strict';
import test from 'node:test';
import { clientIdOf } from '../domain/replica/clientIds';
import { createLocalDoc, docText, localInsert, snapshotOf } from '../domain/replica/doc';
import type { Actor, BuiltEntry } from '../domain/replica/entry';
import type { ProductVersions } from '../domain/replica/versions';
import { appendProductEntry, proposeVersion } from '../staff/replica/labelCells';
import { updateMember } from '../staff/replica/membership';
import { ReplicaProject } from '../staff/replica/replicaProject';
import { ReplicaStore } from '../staff/replica/store';
import { VersionActs } from '../staff/replica/versionActs';
import { bringIn, hostOf, leadWith, ok, orgClearance, project, streamEntries, syncTo } from './helpers/labelCellWorld';
import type { Seat } from './helpers/labelCellWorld';

const PRODUCT = 'logistics-estimate';
const LABEL = 'org/Internal';
const ROLES = { owner: 'j4-planner', sectionLead: 'j4-lead', releaseGuard: 'j4-guard' };
const PERSON: Actor = { kind: 'person' };
const LEAD_DECISION_ROLES = ['member', 'section_lead:j4', 'decision_for:commander'];
const OWNER: Actor = { kind: 'agent', member: ROLES.owner, run: 'owner-run' };
const GUARD: Actor = { kind: 'agent', member: ROLES.releaseGuard, run: 'guard-run' };

async function versionOn(lead: Seat) {
  const created = await appendProductEntry(lead.host, 'product.create', { product: PRODUCT, section: 'j4', roles: ROLES, title: 'Logistics estimate' }, { label: LABEL });
  assert.ok(created.ok, created.ok ? undefined : created.message);
  const { roster } = await lead.p.state();
  const slot = roster.members.devices.get(lead.writer)?.[0]?.slot ?? 1;
  const clientId = clientIdOf(slot, 0);
  assert.ok((await appendProductEntry(lead.host, 'doc.client', { product: PRODUCT, clientId, actor: { kind: 'person' } })).ok);
  const doc = createLocalDoc(clientId);
  const update = Buffer.from(localInsert(doc, 0, 'Fuel for three days.')).toString('base64url');
  assert.ok((await appendProductEntry(lead.host, 'doc.update', { product: PRODUCT, update })).ok);
  const proposed = await proposeVersion(lead.host, {
    product: PRODUCT, text: docText(doc), header: { kind: 'estimate', label: LABEL, profile: 'j4', level: 'official' }, pins: [], snapshot: snapshotOf(doc)
  });
  assert.ok(proposed.ok, proposed.ok ? undefined : proposed.message);
  return proposed;
}

async function versionFold(seat: Seat, stream: string) {
  const { fold } = await seat.p.state();
  const product = (fold.families.versions as ProductVersions[]).find((item) => item.product === PRODUCT && item.stream === stream);
  assert.ok(product);
  return { product, fold };
}

test('a guard verdict, owner submission and person approval sign the exact version and converge across replicas', async () => {
  const lead = await leadWith({ roles: LEAD_DECISION_ROLES });
  const guard = await bringIn(lead, 'guard', 'Guard Reviewer', orgClearance('Internal'));
  ok(await updateMember(lead.host, { member: guard.member, agentSeats: [ROLES.releaseGuard] }), 'authorise guard');
  const { stream, version } = await versionOn(lead);
  await syncTo(lead, guard, [stream]);
  const data = { product: PRODUCT, hash: version, gate: 'guard', verdict: 'CLEARED', reasons: ['Reviewed against the plan.'] } as const;
  const result = await new VersionActs(guard.p, GUARD).verdict(data);
  assert.ok(result.ok, result.ok ? undefined : result.message);
  const [entry] = await guard.p.findOwnAll('version.verdict', () => true);
  assert.deepEqual(entry?.data, data);
  assert.equal(entry.stream, stream);
  assert.equal(entry.hash, result.hash);
  await syncTo(guard, lead, [stream]);
  assert.equal((await versionFold(lead, stream)).product.versions[0]?.state, 'guard-checked');
  const request = { product: PRODUCT, hash: version, decisionFor: 'commander' };
  const submitted = await new VersionActs(lead.p, OWNER).submit(request);
  assert.ok(submitted.ok, submitted.ok ? undefined : submitted.message);
  const [submission] = await lead.p.findOwnAll('version.submit', () => true);
  assert.deepEqual(submission?.data, request);
  assert.equal(submission.stream, stream);
  assert.equal(submission.hash, submitted.hash);
  await syncTo(lead, guard, [stream]);
  assert.equal((await versionFold(guard, stream)).product.versions[0]?.state, 'awaiting-decision');
  const decision = { product: PRODUCT, hash: version, outcome: 'approve', reasons: ['Ready to proceed.'] } as const;
  const approved = await new VersionActs(lead.p, PERSON).decide(decision);
  assert.ok(approved.ok, approved.ok ? undefined : approved.message);
  const [written] = await lead.p.findOwnAll('version.decide', () => true);
  assert.deepEqual(written?.data, { ...decision, decisionsSeen: [] });
  assert.equal(written.stream, stream);
  assert.equal(written.hash, approved.hash);
  await syncTo(lead, guard, [stream]);
  const a = await versionFold(lead, stream);
  const b = await versionFold(guard, stream);
  assert.equal(a.product.versions[0]?.state, 'approved');
  assert.equal(a.product.versions[0]?.decisionFor, 'commander');
  assert.deepEqual(a.product.versions, b.product.versions);
  assert.equal(a.fold.digests[stream], b.fold.digests[stream]);
  assert.deepEqual(a.fold.refused, []);
  assert.deepEqual(a.product.refusals, []);
});

test('stale version, unassigned agent and a hold with no reason write nothing', async () => {
  const lead = await leadWith();
  const { stream, version } = await versionOn(lead);
  const acts = new VersionActs(lead.p, GUARD);
  const data = { product: PRODUCT, hash: version, gate: 'guard', verdict: 'HOLD', reasons: [] } as const;
  const before = streamEntries(lead.at, stream);
  const stale = await acts.verdict({ ...data, hash: '0'.repeat(64) });
  assert.equal(stale.ok ? undefined : stale.reason, 'stale-version');
  const unassigned = await acts.verdict(data);
  assert.equal(unassigned.ok ? undefined : unassigned.reason, 'not-gate-member');
  assert.deepEqual(streamEntries(lead.at, stream), before);
  ok(await updateMember(lead.host, { member: lead.member, agentSeats: [ROLES.releaseGuard] }), 'authorise guard');
  const noReason = await acts.verdict(data);
  assert.equal(noReason.ok ? undefined : noReason.reason, 'reasons-required');
  assert.deepEqual(streamEntries(lead.at, stream), before);
  assert.deepEqual((await versionFold(lead, stream)).product.refusals, []);
});

test('a second window removing the guard seat between preview and append causes a fresh refusal', async (t) => {
  const lead = await leadWith();
  ok(await updateMember(lead.host, { member: lead.member, agentSeats: [ROLES.releaseGuard] }), 'authorise guard');
  const { stream, version } = await versionOn(lead);
  const other = hostOf(project(await ReplicaProject.open(lead.at.root, lead.at.deps)), lead.at);
  const before = streamEntries(lead.at, stream);
  let raced = false;
  const append = ReplicaStore.prototype.appendOwn;
  t.mock.method(ReplicaStore.prototype, 'appendOwn', async function (this: ReplicaStore, built: readonly BuiltEntry[], expectedSnapshot?: string) {
    if (expectedSnapshot !== undefined && !raced) {
      raced = true;
      ok(await updateMember(other, { member: lead.member, agentSeats: [] }), 'remove guard access');
    }
    return append.call(this, built, expectedSnapshot);
  });
  const result = await new VersionActs(lead.p, GUARD).verdict({
    product: PRODUCT, hash: version, gate: 'guard', verdict: 'CLEARED', reasons: []
  });
  assert.ok(raced);
  assert.equal(result.ok ? undefined : result.reason, 'not-gate-member');
  assert.deepEqual(streamEntries(lead.at, stream), before);
});

test('an authorized verdict with supported reasons exceeding the inline size folds from its sealed blob', async () => {
  const lead = await leadWith();
  ok(await updateMember(lead.host, { member: lead.member, agentSeats: [ROLES.releaseGuard] }), 'authorise guard');
  const { stream, version } = await versionOn(lead);
  const reasons = Array.from({ length: 20 }, () => '"'.repeat(500));
  const result = await new VersionActs(lead.p, GUARD).verdict({
    product: PRODUCT, hash: version, gate: 'guard', verdict: 'HOLD', reasons
  });
  assert.ok(result.ok, result.ok ? undefined : result.message);
  const { product } = await versionFold(lead, stream);
  assert.deepEqual(product.versions[0]?.held, { gate: 'guard', reasons });
});

test('submission requires an effective clearance and an authorized owner side without writing refusals', async () => {
  const lead = await leadWith();
  ok(await updateMember(lead.host, { member: lead.member, agentSeats: [ROLES.releaseGuard] }), 'authorise guard');
  const { stream, version } = await versionOn(lead);
  const owner = new VersionActs(lead.p, OWNER);
  const guard = new VersionActs(lead.p, GUARD);
  const request = { product: PRODUCT, hash: version, decisionFor: 'commander' };
  const draft = streamEntries(lead.at, stream);
  const uncleared = await owner.submit(request);
  assert.equal(uncleared.ok ? undefined : uncleared.reason, 'wrong-state');
  assert.deepEqual(streamEntries(lead.at, stream), draft);
  assert.ok((await guard.verdict({ product: PRODUCT, hash: version, gate: 'guard', verdict: 'CLEARED', reasons: [] })).ok);
  const cleared = streamEntries(lead.at, stream);
  const unauthorized = await guard.submit(request);
  assert.equal(unauthorized.ok ? undefined : unauthorized.reason, 'not-owner-or-lead');
  assert.deepEqual(streamEntries(lead.at, stream), cleared);
});

test('a submit from a second window cannot reroute a version already awaiting a decision', async (t) => {
  const lead = await leadWith();
  ok(await updateMember(lead.host, { member: lead.member, agentSeats: [ROLES.releaseGuard] }), 'authorise guard');
  const { stream, version } = await versionOn(lead);
  const other = project(await ReplicaProject.open(lead.at.root, lead.at.deps));
  assert.ok((await new VersionActs(lead.p, GUARD).verdict({ product: PRODUCT, hash: version, gate: 'guard', verdict: 'CLEARED', reasons: [] })).ok);

  let raced = false;
  const append = ReplicaStore.prototype.appendOwn;
  t.mock.method(ReplicaStore.prototype, 'appendOwn', async function (this: ReplicaStore, built: readonly BuiltEntry[], expectedSnapshot?: string) {
    if (expectedSnapshot !== undefined && !raced) {
      raced = true;
      assert.ok((await new VersionActs(other, OWNER).submit({ product: PRODUCT, hash: version, decisionFor: 'commander' })).ok);
    }
    return append.call(this, built, expectedSnapshot);
  });
  const result = await new VersionActs(lead.p, OWNER).submit({ product: PRODUCT, hash: version, decisionFor: 'staff-lead' });
  assert.ok(raced);
  assert.equal(result.ok ? undefined : result.reason, 'wrong-state');
  const { product } = await versionFold(lead, stream);
  assert.equal(product.versions[0]?.decisionFor, 'commander');
  assert.equal((await lead.p.findOwnAll('version.submit', () => true)).length, 1);
});

async function awaitingVersion(lead: Seat) {
  ok(await updateMember(lead.host, { member: lead.member, agentSeats: [ROLES.releaseGuard] }), 'authorise guard');
  const proposed = await versionOn(lead);
  const target = { product: PRODUCT, hash: proposed.version };
  assert.ok((await new VersionActs(lead.p, GUARD).verdict({ ...target, gate: 'guard', verdict: 'CLEARED', reasons: [] })).ok);
  assert.ok((await new VersionActs(lead.p, OWNER).submit({ ...target, decisionFor: 'commander' })).ok);
  return { stream: proposed.stream, target };
}

test('an agent, a person without the decision role and a rejection without reasons write no decision', async () => {
  const lead = await leadWith({ roles: LEAD_DECISION_ROLES });
  const member = await bringIn(lead, 'member', 'Staff Member', orgClearance('Internal'));
  const { stream, target } = await awaitingVersion(lead);
  await syncTo(lead, member, [stream]);
  const beforeLead = streamEntries(lead.at, stream);
  const beforeMember = streamEntries(member.at, stream);
  const approve = { ...target, outcome: 'approve', reasons: [] } as const;
  const agent = await new VersionActs(lead.p, OWNER).decide(approve);
  assert.equal(agent.ok ? undefined : agent.reason, 'agent-cannot-decide');
  const otherPerson = await new VersionActs(member.p, PERSON).decide(approve);
  assert.equal(otherPerson.ok ? undefined : otherPerson.reason, 'not-decision-holder');
  const holder = new VersionActs(lead.p, PERSON);
  const missingReason = await holder.decide({ ...approve, outcome: 'reject' });
  assert.equal(missingReason.ok ? undefined : missingReason.reason, 'reasons-required');
  assert.deepEqual(streamEntries(lead.at, stream), beforeLead);
  assert.deepEqual(streamEntries(member.at, stream), beforeMember);
  const rejected = await holder.decide({ ...target, outcome: 'reject', reasons: ['Missing the allocation.'] });
  assert.ok(rejected.ok, rejected.ok ? undefined : rejected.message);
  assert.equal((await versionFold(lead, stream)).product.versions[0]?.state, 'rejected');
});

test('a signed roster change in a second window removes decision authority before append', async (t) => {
  const lead = await leadWith({ roles: LEAD_DECISION_ROLES });
  const { stream, target } = await awaitingVersion(lead);
  const other = hostOf(project(await ReplicaProject.open(lead.at.root, lead.at.deps)), lead.at);
  const before = streamEntries(lead.at, stream);
  let raced = false;
  const append = ReplicaStore.prototype.appendOwn;
  t.mock.method(ReplicaStore.prototype, 'appendOwn', async function (this: ReplicaStore, built: readonly BuiltEntry[], expectedSnapshot?: string) {
    if (expectedSnapshot !== undefined && !raced) {
      raced = true;
      ok(await updateMember(other, { member: lead.member, roles: ['member', 'section_lead:j4'] }), 'remove decision role');
    }
    return append.call(this, built, expectedSnapshot);
  });
  const result = await new VersionActs(lead.p, PERSON).decide({ ...target, outcome: 'approve', reasons: [] });
  assert.ok(raced);
  assert.equal(result.ok ? undefined : result.reason, 'not-decision-holder');
  assert.deepEqual(streamEntries(lead.at, stream), before);
});

test('ordinary decisions made offline can contest, and a known contest requires settlement', async () => {
  const lead = await leadWith({ roles: LEAD_DECISION_ROLES });
  const alternate = await bringIn(lead, 'alternate', 'Alternate Commander', orgClearance('Internal'));
  ok(await updateMember(lead.host, { member: alternate.member, roles: ['member', 'decision_for:commander'] }), 'authorize alternate');
  const { stream, target } = await awaitingVersion(lead);
  await syncTo(lead, alternate, [stream]);
  const first = new VersionActs(lead.p, PERSON);
  const second = new VersionActs(alternate.p, PERSON);
  assert.ok((await first.decide({ ...target, outcome: 'approve', reasons: [] })).ok);
  assert.ok((await second.decide({ ...target, outcome: 'reject', reasons: ['A new condition applies.'] })).ok);
  await syncTo(alternate, lead, [stream]);
  await syncTo(lead, alternate, [stream]);
  const a = await versionFold(lead, stream);
  const b = await versionFold(alternate, stream);
  assert.deepEqual(a.product.versions, b.product.versions);
  assert.equal(a.product.versions[0]?.overlay, 'contested');
  assert.equal(a.product.versions[0]?.decision.contested.length, 2);
  const before = streamEntries(lead.at, stream);
  const retry = await first.decide({ ...target, outcome: 'approve', reasons: [] });
  assert.equal(retry.ok ? undefined : retry.reason, 'wrong-state');
  assert.deepEqual(streamEntries(lead.at, stream), before);
});

test('a different decision holder can release an approved version and both replicas agree', async () => {
  const lead = await leadWith({ roles: LEAD_DECISION_ROLES });
  const alternate = await bringIn(lead, 'release-holder', 'Alternate Commander', orgClearance('Internal'));
  ok(await updateMember(lead.host, { member: alternate.member, roles: ['member', 'decision_for:commander'] }), 'authorize alternate');
  const { stream, target } = await awaitingVersion(lead);
  const approval = await new VersionActs(lead.p, PERSON).decide({ ...target, outcome: 'approve', reasons: [] });
  assert.ok(approval.ok, approval.ok ? undefined : approval.message);
  await syncTo(lead, alternate, [stream]);
  const releaser = new VersionActs(alternate.p, PERSON);
  const release = await releaser.release(target);
  assert.ok(release.ok, release.ok ? undefined : release.message);
  const [entry] = await alternate.p.findOwnAll('version.release', () => true);
  assert.deepEqual(entry?.data, { ...target, decisionsSeen: [approval.hash] });
  assert.equal(entry.hash, release.hash);
  assert.equal(entry.stream, stream);
  const before = streamEntries(alternate.at, stream);
  const repeated = await releaser.release(target);
  assert.equal(repeated.ok ? undefined : repeated.reason, 'wrong-state');
  assert.deepEqual(streamEntries(alternate.at, stream), before);
  await syncTo(alternate, lead, [stream]);
  const a = await versionFold(lead, stream);
  const b = await versionFold(alternate, stream);
  assert.equal(a.product.versions[0]?.state, 'released');
  assert.deepEqual(a.product.versions, b.product.versions);
  assert.equal(a.fold.digests[stream], b.fold.digests[stream]);
  assert.deepEqual(a.product.refusals, []);
});

test('release writes nothing without an effective approval or the current person decision role', async () => {
  const lead = await leadWith({ roles: LEAD_DECISION_ROLES });
  const member = await bringIn(lead, 'release-member', 'Staff Member', orgClearance('Internal'));
  const { stream, target } = await awaitingVersion(lead);
  const acts = new VersionActs(lead.p, PERSON);
  const awaiting = streamEntries(lead.at, stream);
  const early = await acts.release(target);
  assert.equal(early.ok ? undefined : early.reason, 'no-approval');
  assert.deepEqual(streamEntries(lead.at, stream), awaiting);
  assert.ok((await acts.decide({ ...target, outcome: 'approve', reasons: [] })).ok);
  await syncTo(lead, member, [stream]);
  const approved = streamEntries(lead.at, stream);
  const received = streamEntries(member.at, stream);
  const agent = await new VersionActs(lead.p, OWNER).release(target);
  assert.equal(agent.ok ? undefined : agent.reason, 'agent-cannot-decide');
  const person = await new VersionActs(member.p, PERSON).release(target);
  assert.equal(person.ok ? undefined : person.reason, 'not-decision-holder');
  assert.deepEqual(streamEntries(lead.at, stream), approved);
  assert.deepEqual(streamEntries(member.at, stream), received);
});

test('a signed roster change in a second window removes release authority before append', async (t) => {
  const lead = await leadWith({ roles: LEAD_DECISION_ROLES });
  const alternate = await bringIn(lead, 'release-race', 'Alternate Commander', orgClearance('Internal'));
  ok(await updateMember(lead.host, { member: alternate.member, roles: ['member', 'decision_for:commander'] }), 'authorize alternate');
  const { stream, target } = await awaitingVersion(lead);
  assert.ok((await new VersionActs(lead.p, PERSON).decide({ ...target, outcome: 'approve', reasons: [] })).ok);
  await syncTo(lead, alternate, [stream]);
  const other = project(await ReplicaProject.open(alternate.at.root, alternate.at.deps));
  const otherSeat = { ...alternate, p: other, host: hostOf(other, alternate.at) };
  const before = streamEntries(alternate.at, stream);
  let raced = false;
  const append = ReplicaStore.prototype.appendOwn;
  t.mock.method(ReplicaStore.prototype, 'appendOwn', async function (this: ReplicaStore, built: readonly BuiltEntry[], expectedSnapshot?: string) {
    if (expectedSnapshot !== undefined && !raced) {
      raced = true;
      ok(await updateMember(lead.host, { member: alternate.member, roles: ['member'] }), 'remove decision role');
      await syncTo(lead, otherSeat, [stream]);
    }
    return append.call(this, built, expectedSnapshot);
  });
  const result = await new VersionActs(alternate.p, PERSON).release(target);
  assert.ok(raced);
  assert.equal(result.ok ? undefined : result.reason, 'not-decision-holder');
  assert.deepEqual(streamEntries(alternate.at, stream), before);
  assert.equal((await versionFold(alternate, stream)).product.versions[0]?.state, 'approved');
});
