import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { clientIdOf } from '../domain/replica/clientIds';
import { createLocalDoc, docText, localInsert, snapshotOf } from '../domain/replica/doc';
import { entryHash } from '../domain/replica/entry';
import type { Actor, BuiltEntry } from '../domain/replica/entry';
import { sessionCertifyData } from '../domain/replica/sessionKeys';
import { replicaVersionHash } from '../domain/replica/versions';
import type { ProductVersions } from '../domain/replica/versions';
import { REPLICA_DIR } from '../domain/staff/multiUser';
import { appendProductEntry, proposeVersion } from '../staff/replica/labelCells';
import { updateMember } from '../staff/replica/membership';
import { deviceKeys, storeDeps } from '../staff/replica/projectDevice';
import { ReplicaProject } from '../staff/replica/replicaProject';
import type { ProjectState } from '../staff/replica/replicaProject';
import { ReplicaStore } from '../staff/replica/store';
import { productPath, StaffHost } from '../staff/staffHost';
import { CHANGED_WHILE_DECIDING_TEXT, VERSION_ACT_WORDS, VersionActs } from '../staff/replica/versionActs';
import { STEP_UP_TEXT } from './helpers/hostedWorld';
import { bringIn, hostOf, leadWith, MemorySecrets, ok, orgClearance, project, streamEntries, syncTo } from './helpers/labelCellWorld';
import type { Seat } from './helpers/labelCellWorld';
import { fixedSigner } from './helpers/replicaWorld';
import { trusting } from './helpers/staffFixtures';

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
  return { ...await proposeText(lead, doc), doc };
}

async function proposeText(lead: Seat, doc: ReturnType<typeof createLocalDoc>) {
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

async function hostedSessionOf(lead: Seat, beforeSigning?: () => Promise<string | undefined>) {
  const session = fixedSigner('hosted-decision-session');
  const { roster } = await lead.p.state();
  const slot = roster.members.devices.get(lead.writer)?.find((device) => device.slot !== undefined)?.slot;
  assert.ok(slot !== undefined);
  const notAfter = new Date(lead.at.clock.now.getTime() + 60 * 60 * 1000).toISOString();
  assert.ok('ok' in await lead.p.appendOwn('session.certify', sessionCertifyData({
    project: lead.p.projectId, member: lead.member, device: lead.writer, sessionKey: session.publicKey, slot, notAfter
  }, (bytes) => session.signer.sign(bytes))));
  const { identity, encryption, kem, kemPrivate } = await deviceKeys(lead.at.deps);
  const deps = {
    ...lead.at.deps, secrets: new MemorySecrets(), keyStatus: async () => trusting(session.signer),
    sessionSigner: session.signer,
    hosted: {
      personPublicKey: identity.publicKey, encryption,
      kem: kem === undefined || kemPrivate === undefined ? undefined : { publicKeys: kem, privateKeys: kemPrivate }
    },
    personSigner: {
      fingerprint: identity.fingerprint, publicKey: identity.publicKey,
      sign: async (bytes: Buffer) => {
        const refused = await beforeSigning?.();
        return refused === undefined ? identity.sign(bytes) : { refused };
      }
    }
  };
  return { deps, session };
}

type NativeVersionActs = VersionActs & {
  submitForRosterRole?: VersionActs['submit'];
  roomActions?: (state: ProjectState, product: string) => Array<{
    hash: string; number: number; submitRoles: string[]; decision?: { stamp: string; settle: boolean };
  }>;
};

test('native submission and a stamped approval use the session and person keys and converge across replicas', async () => {
  const lead = await leadWith({ roles: LEAD_DECISION_ROLES });
  const guard = await bringIn(lead, 'guard', 'Guard Reviewer', orgClearance('Internal'));
  const outside = await bringIn(lead, 'outside-cell', 'Outside the cell', orgClearance('Public'));
  ok(await updateMember(lead.host, { member: outside.member, roles: ['member', 'decision_for:outside-cell'] }), 'assign a role without cell access');
  ok(await updateMember(lead.host, { member: guard.member, agentSeats: [ROLES.releaseGuard], roles: ['member', 'decision_for:deputy'] }), 'authorise guard');
  const { stream, version } = await versionOn(lead);
  let signatures = 0;
  const { deps, session } = await hostedSessionOf(lead, async () => { signatures += 1; return undefined; });
  const hosted = project(await ReplicaProject.open(lead.at.root, deps));
  const acts: NativeVersionActs = new VersionActs(hosted, PERSON);
  const guardActs: NativeVersionActs = new VersionActs(guard.p, PERSON);
  const request = { product: PRODUCT, hash: version, decisionFor: 'commander' };
  const draft = streamEntries(lead.at, stream);
  assert.equal((await acts.submitForRosterRole?.(request))?.ok, false, 'an unguarded version cannot be submitted');
  assert.deepEqual(streamEntries(lead.at, stream), draft);
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
  assert.deepEqual(acts.roomActions?.(await hosted.state(), PRODUCT), [{ hash: version, number: 1, submitRoles: ['commander', 'deputy'] }]);
  const cleared = streamEntries(lead.at, stream);
  assert.equal((await guardActs.submitForRosterRole?.(request))?.ok, false, 'a role holder outside the owner side cannot submit');
  assert.deepEqual(streamEntries(guard.at, stream), cleared);
  ok(await updateMember(lead.host, { member: guard.member, roles: ['member'] }), 'remove the alternative decision role');
  for (const decisionFor of ['unknown', 'deputy', 'outside-cell']) {
    assert.equal((await acts.submitForRosterRole?.({ ...request, decisionFor }))?.ok, false, `${decisionFor} is unavailable for this cell`);
  }
  assert.deepEqual(streamEntries(lead.at, stream), cleared);
  assert.deepEqual(acts.roomActions?.(await hosted.state(), PRODUCT), [{ hash: version, number: 1, submitRoles: ['commander'] }]);
  const submitted = await acts.submitForRosterRole?.(request);
  assert.ok(submitted?.ok, submitted?.ok === false ? submitted.message : undefined);
  const awaiting = (await versionFold({ ...lead, p: hosted }, stream)).product;
  const submission = awaiting.records[0]?.acts.find((act) => act.kind === 'version.submit');
  assert.deepEqual(submission?.data, request);
  assert.equal(submitted.stream, stream);
  assert.equal(submission?.entry, submitted.hash);
  assert.equal(submission?.writer, session.writer);
  const beforeDecision = streamEntries(lead.at, stream);
  assert.equal((await acts.submitForRosterRole?.(request))?.ok, false, 'an awaiting version cannot be resubmitted');
  assert.deepEqual(streamEntries(lead.at, stream), beforeDecision);
  await syncTo(lead, guard, [stream]);
  assert.equal((await versionFold(guard, stream)).product.versions[0]?.state, 'awaiting-decision');
  assert.deepEqual(guardActs.roomActions?.(await guard.p.state(), PRODUCT), []);

  const stamp = await acts.decisionStamp(request);
  assert.ok(stamp);
  assert.deepEqual(acts.roomActions?.(await hosted.state(), PRODUCT), [{
    hash: version, number: 1, submitRoles: [], decision: { stamp, settle: false }
  }]);
  const decision = { product: PRODUCT, hash: version, outcome: 'approve', reasons: ['Ready to proceed.'] } as const;
  ok(await updateMember(lead.host, { member: lead.member, roles: ['member', 'section_lead:j4'] }), 'withdraw the decision role while the dialog is open');
  assert.deepEqual(acts.roomActions?.(await hosted.state(), PRODUCT), []);
  const refused = await acts.decide({ ...decision, stamp });
  assert.equal(refused.ok ? undefined : refused.reason, 'not-decision-holder');
  assert.equal(signatures, 0, 'the old dialog did not ask the person key to sign');
  assert.deepEqual(streamEntries(lead.at, stream), beforeDecision);

  ok(await updateMember(lead.host, { member: lead.member, roles: LEAD_DECISION_ROLES }), 'restore the decision role');
  const reopened = await acts.decisionStamp(request);
  assert.ok(reopened);
  const approved = await acts.decide({ ...decision, stamp: reopened });
  assert.ok(approved.ok, approved.ok ? undefined : approved.message);
  assert.equal(signatures, 1);
  const [written] = await lead.p.findOwnAll('version.decide', () => true);
  assert.deepEqual(written?.data, { ...decision, decisionsSeen: [] });
  assert.equal(written.stream, stream);
  assert.equal(written.hash, approved.hash);
  assert.equal(streamEntries(lead.at, stream).find((item) => entryHash(item.header) === approved.hash)?.header.writer, lead.writer);
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
  const noContest = await holder.decide({ ...approve, settle: true });
  assert.equal(noContest.ok ? undefined : noContest.reason, 'wrong-state');
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

test('ordinary decisions made offline can contest, and a stamped decision settles every conflicting act', async () => {
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
  const withdrawal = await first.withdraw({ ...target, reason: 'The version is no longer needed.' });
  assert.equal(withdrawal.ok ? undefined : withdrawal.reason, 'wrong-state');
  const agent = await new VersionActs(lead.p, OWNER).decide({ ...target, outcome: 'approve', reasons: [], settle: true });
  assert.equal(agent.ok ? undefined : agent.reason, 'agent-cannot-decide');
  assert.deepEqual(streamEntries(lead.at, stream), before);

  const stamp = await first.decisionStamp(target);
  assert.ok(stamp);
  assert.equal(stamp, await second.decisionStamp(target));
  const result = await first.decide({ ...target, outcome: 'approve', reasons: [], stamp, settle: true });
  assert.ok(result.ok, result.ok ? undefined : result.message);
  const [written] = await lead.p.findOwnAll('version.decide', (data: unknown) => (data as { decisionsSeen: string[] }).decisionsSeen.length > 0);
  assert.equal(written.hash, result.hash);
  assert.deepEqual(written.data, { ...target, outcome: 'approve', reasons: [], decisionsSeen: a.product.versions[0].decision.contested });
  await syncTo(lead, alternate, [stream]);
  const settled = await versionFold(lead, stream);
  assert.equal(settled.product.versions[0]?.state, 'approved');
  assert.equal(settled.product.versions[0]?.overlay, undefined);
  assert.deepEqual(settled.product.versions, (await versionFold(alternate, stream)).product.versions);
  assert.notEqual(await first.decisionStamp(target), stamp);
});

test('a stamped decision refuses after another device decides while the request is open', async () => {
  const lead = await leadWith({ roles: LEAD_DECISION_ROLES });
  const alternate = await bringIn(lead, 'stamp-other', 'Alternate Commander', orgClearance('Internal'));
  ok(await updateMember(lead.host, { member: alternate.member, roles: ['member', 'decision_for:commander'] }), 'authorize alternate');
  const { stream, target } = await awaitingVersion(lead);
  await syncTo(lead, alternate, [stream]);
  const { signer } = await ReplicaProject.localDevice(lead.at.deps);
  const host = new StaffHost({
    root: lead.at.root, signer: async () => signer, keyStatus: async () => trusting(signer), headStore: lead.at.secrets,
    now: () => lead.at.clock.now.getTime(), replica: { globalStorageDir: lead.at.global }
  });
  try {
    const captured = await host.sharedReplica();
    assert.ok(captured);
    const stamp = await captured.decisionStamp(target);
    assert.ok(stamp);
    assert.ok((await new VersionActs(alternate.p, PERSON).decide({ ...target, outcome: 'approve', reasons: [] })).ok);
    await syncTo(alternate, lead, [stream]);

    const refreshed = await host.sharedReplica();
    assert.ok(refreshed);
    assert.match(await refreshed.decisionStamp(target) ?? '', /^[a-f0-9]{64}$/);
    assert.notEqual(await refreshed.decisionStamp(target), stamp);
    assert.equal(await captured.decisionStamp(target), stamp, 'the open request keeps the state it was shown');

    const before = streamEntries(lead.at, stream);
    const local = new VersionActs(lead.p, PERSON);
    const stale = await local.decide({ ...target, outcome: 'reject', reasons: ['Unavailable support.'], stamp });
    assert.deepEqual(stale, { ok: false, reason: 'changed-while-deciding', message: CHANGED_WHILE_DECIDING_TEXT });
    assert.deepEqual(streamEntries(lead.at, stream), before);
  } finally {
    await host.close();
  }
});

test('the checked append rechecks a decision stamp after an incoming entry lands in another window', async (t) => {
  const lead = await leadWith({ roles: LEAD_DECISION_ROLES });
  const alternate = await bringIn(lead, 'stamp-race', 'Alternate Commander', orgClearance('Internal'));
  ok(await updateMember(lead.host, { member: alternate.member, roles: ['member', 'decision_for:commander'] }), 'authorize alternate');
  const { stream, target } = await awaitingVersion(lead);
  await syncTo(lead, alternate, [stream]);
  const local = new VersionActs(lead.p, PERSON);
  const stamp = await local.decisionStamp(target);
  assert.ok(stamp);
  assert.ok((await new VersionActs(alternate.p, PERSON).decide({ ...target, outcome: 'approve', reasons: [] })).ok);
  const other = project(await ReplicaProject.open(lead.at.root, lead.at.deps));
  const otherSeat = { ...lead, p: other, host: hostOf(other, lead.at) };
  let raced = false;
  const append = ReplicaStore.prototype.appendOwn;
  t.mock.method(ReplicaStore.prototype, 'appendOwn', async function (this: ReplicaStore, built: readonly BuiltEntry[], expectedSnapshot?: string) {
    if (expectedSnapshot !== undefined && !raced) {
      raced = true;
      await syncTo(alternate, otherSeat, [stream]);
    }
    return append.call(this, built, expectedSnapshot);
  });
  const stale = await local.decide({ ...target, outcome: 'reject', reasons: ['Unavailable support.'], stamp });
  assert.ok(raced);
  assert.deepEqual(stale, { ok: false, reason: 'changed-while-deciding', message: CHANGED_WHILE_DECIDING_TEXT });
  assert.deepEqual(await lead.p.findOwnAll('version.decide', () => true), []);
  assert.equal((await versionFold(lead, stream)).product.versions[0]?.state, 'approved');
});

for (const { scenario, remoteDecides, signerRefuses } of [
  { scenario: 'a hosted signature after a competing decision', remoteDecides: true, signerRefuses: false },
  { scenario: 'a hosted step-up refusal after a competing decision', remoteDecides: true, signerRefuses: true },
  { scenario: 'a hosted step-up refusal with an unchanged decision', remoteDecides: false, signerRefuses: true }
]) {
  test(scenario, async () => {
    const lead = await leadWith({ roles: LEAD_DECISION_ROLES });
    const alternate = await bringIn(lead, 'hosted-race', 'Alternate Commander', orgClearance('Internal'));
    ok(await updateMember(lead.host, { member: alternate.member, roles: ['member', 'decision_for:commander'] }), 'authorize alternate');
    const { stream, target } = await awaitingVersion(lead);
    await syncTo(lead, alternate, [stream]);

    const approved = await new VersionActs(alternate.p, PERSON).decide({ ...target, outcome: 'approve', reasons: [] });
    assert.ok(approved.ok, approved.ok ? undefined : approved.message);
    const incoming = streamEntries(alternate.at, stream).find((entry) => entryHash(entry.header) === approved.hash);
    assert.ok(incoming);

    let requests = 0;
    const { deps, session } = await hostedSessionOf(lead, async () => {
      requests += 1;
      // This independent handle advances the same store before the person signer answers.
      if (remoteDecides) {
        const ingested = await other.ingestForeign([incoming], []);
        assert.ok('ok' in ingested, 'ok' in ingested ? undefined : ingested.message);
        assert.equal(ingested.added, 1);
        assert.deepEqual(ingested.held, []);
        assert.deepEqual(ingested.waiting, []);
      }
      return signerRefuses ? STEP_UP_TEXT : undefined;
    });
    const other = project(await ReplicaProject.open(lead.at.root, deps));
    const baseline = await versionFold({ ...lead, p: other }, stream);
    assert.equal(baseline.product.versions.find((version) => version.hash === target.hash)?.state, 'awaiting-decision');
    const hosted = project(await ReplicaProject.open(lead.at.root, deps));
    assert.equal(hosted.signer.publicKey, session.publicKey);
    assert.equal(hosted.signerOf('version.decide').publicKey, lead.p.signer.publicKey);
    assert.notEqual(session.writer, lead.writer);
    const local = new VersionActs(hosted, PERSON);
    const stamp = await local.decisionStamp(target);
    assert.ok(stamp);
    const before = streamEntries(lead.at, stream);
    const blobDir = path.join(lead.at.root, REPLICA_DIR, 'blobs');
    const blobNames = (): string[] => existsSync(blobDir) ? readdirSync(blobDir).sort() : [];
    const blobsBefore = blobNames();
    // Escaped reason text makes the rejected decision large enough to use a sealed blob.
    const reasons = Array.from({ length: 20 }, () => '"'.repeat(500));
    const stale = await local.decide({ ...target, outcome: 'reject', reasons, stamp });

    assert.equal(requests, 1);
    const store = await ReplicaStore.open(lead.at.root, storeDeps(deps, session.signer));
    assert.ok(store instanceof ReplicaStore);
    const { product } = await versionFold({ ...lead, p: hosted }, stream);
    const folded = product.versions.find((version) => version.hash === target.hash);
    assert.ok(folded);
    const after = streamEntries(lead.at, stream);
    assert.deepEqual({
      result: stale.ok ? { ok: true } : stale,
      appended: after.filter((entry) => !before.some((previous) => entryHash(previous.header) === entryHash(entry.header)))
        .map((entry) => entry.header.writer),
      blobs: blobNames().filter((blob) => !blobsBefore.includes(blob)),
      held: store.heldForCheck(),
      waiting: store.waitingForCheck(),
      state: folded.state,
      effective: folded.decision.effective
    }, {
      result: remoteDecides
        ? { ok: false, reason: 'changed-while-deciding', message: CHANGED_WHILE_DECIDING_TEXT }
        : { ok: false, reason: 'signer-refused', message: STEP_UP_TEXT },
      appended: remoteDecides ? [alternate.writer] : [],
      blobs: [],
      held: [],
      waiting: [],
      state: remoteDecides ? 'approved' : 'awaiting-decision',
      effective: remoteDecides ? [approved.hash] : []
    });
  });
}

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

test('a person on the owner side may withdraw before approval but an agent and an unrelated person write nothing', async () => {
  const lead = await leadWith({ roles: ['member', 'section_lead:j4'] });
  const member = await bringIn(lead, 'withdraw-member', 'Staff Member', orgClearance('Internal'));
  const { stream, version } = await versionOn(lead);
  await syncTo(lead, member, [stream]);
  const input = { product: PRODUCT, hash: version, reason: 'The figures need revision.' };
  const beforeLead = streamEntries(lead.at, stream);
  const beforeMember = streamEntries(member.at, stream);
  const agent = await new VersionActs(lead.p, OWNER).withdraw(input);
  assert.equal(agent.ok ? undefined : agent.reason, 'agent-cannot-decide');
  const stranger = await new VersionActs(member.p, PERSON).withdraw(input);
  assert.equal(stranger.ok ? undefined : stranger.reason, 'not-owner-or-person');
  const owner = new VersionActs(lead.p, PERSON);
  const missing = await owner.withdraw({ ...input, reason: '' });
  assert.equal(missing.ok ? undefined : missing.reason, 'bad-input');
  assert.deepEqual(streamEntries(lead.at, stream), beforeLead);
  assert.deepEqual(streamEntries(member.at, stream), beforeMember);
  const withdrawn = await owner.withdraw(input);
  assert.ok(withdrawn.ok, withdrawn.ok ? undefined : withdrawn.message);
  const [entry] = await lead.p.findOwnAll('version.withdraw', () => true);
  assert.deepEqual(entry?.data, { ...input, decisionsSeen: [] });
  assert.equal(entry.stream, stream);
  assert.equal(entry.hash, withdrawn.hash);
  const repeated = await owner.withdraw(input);
  assert.equal(repeated.ok ? undefined : repeated.reason, 'terminal');
  await syncTo(lead, member, [stream]);
  const a = await versionFold(lead, stream);
  const b = await versionFold(member, stream);
  assert.equal(a.product.versions[0]?.state, 'withdrawn');
  assert.equal(a.product.records[0]?.release.withdrawal?.reason, input.reason);
  assert.equal(a.fold.digests[stream], b.fold.digests[stream]);
  assert.deepEqual(a.product.refusals, []);
});

test('only a decision holder may withdraw after approval and a concurrent window’s release is observed on retry', async (t) => {
  const lead = await leadWith({ roles: ['member', 'section_lead:j4'] });
  const approver = await bringIn(lead, 'withdraw-approver', 'Approver', orgClearance('Internal'));
  const alternate = await bringIn(lead, 'withdraw-alternate', 'Alternate Approver', orgClearance('Internal'));
  for (const seat of [approver, alternate]) {
    ok(await updateMember(lead.host, { member: seat.member, roles: ['member', 'decision_for:commander'] }), 'authorize decision holder');
  }
  const { stream, target } = await awaitingVersion(lead);
  await syncTo(lead, approver, [stream]);
  const approval = await new VersionActs(approver.p, PERSON).decide({ ...target, outcome: 'approve', reasons: [] });
  assert.ok(approval.ok, approval.ok ? undefined : approval.message);
  await syncTo(approver, lead, [stream]);
  await syncTo(lead, alternate, [stream]);
  const input = { ...target, reason: 'The release is no longer needed.' };
  const before = streamEntries(lead.at, stream);
  const owner = await new VersionActs(lead.p, PERSON).withdraw(input);
  assert.equal(owner.ok ? undefined : owner.reason, 'not-decision-holder');
  assert.deepEqual(streamEntries(lead.at, stream), before);
  const other = project(await ReplicaProject.open(alternate.at.root, alternate.at.deps));
  const otherSeat = { ...alternate, p: other, host: hostOf(other, alternate.at) };
  let releaseHash: string | undefined;
  let raced = false;
  const append = ReplicaStore.prototype.appendOwn;
  t.mock.method(ReplicaStore.prototype, 'appendOwn', async function (this: ReplicaStore, built: readonly BuiltEntry[], expectedSnapshot?: string) {
    if (expectedSnapshot !== undefined && !raced) {
      raced = true;
      const released = await new VersionActs(approver.p, PERSON).release(target);
      assert.ok(released.ok, released.ok ? undefined : released.message);
      releaseHash = released.hash;
      await syncTo(approver, otherSeat, [stream]);
    }
    return append.call(this, built, expectedSnapshot);
  });
  const withdrawn = await new VersionActs(alternate.p, PERSON).withdraw(input);
  assert.ok(withdrawn.ok, withdrawn.ok ? undefined : withdrawn.message);
  assert.ok(releaseHash);
  const [entry] = await alternate.p.findOwnAll('version.withdraw', () => true);
  assert.deepEqual(entry?.data, { ...input, decisionsSeen: [releaseHash] });
  await syncTo(alternate, lead, [stream]);
  assert.equal((await versionFold(lead, stream)).product.records[0]?.release.state, 'withdrawn');
});

test('supersession requires both releases and writes their exact version references on a second replica', async () => {
  const lead = await leadWith({ roles: LEAD_DECISION_ROLES });
  const alternate = await bringIn(lead, 'supersede-holder', 'Alternate Commander', orgClearance('Internal'));
  ok(await updateMember(lead.host, { member: alternate.member, roles: ['member', 'decision_for:commander'] }), 'authorize alternate');
  ok(await updateMember(lead.host, { member: lead.member, agentSeats: [ROLES.releaseGuard] }), 'authorize guard');
  const { stream, version, doc } = await versionOn(lead);
  const acts = new VersionActs(lead.p, PERSON);
  const prepare = async (hash: string) => {
    const target = { product: PRODUCT, hash };
    assert.ok((await new VersionActs(lead.p, GUARD).verdict({ ...target, gate: 'guard', verdict: 'CLEARED', reasons: [] })).ok);
    assert.ok((await new VersionActs(lead.p, OWNER).submit({ ...target, decisionFor: 'commander' })).ok);
    assert.ok((await acts.decide({ ...target, outcome: 'approve', reasons: [] })).ok);
    return target;
  };
  const previous = await prepare(version);
  const noRelease = await acts.supersede({ ...previous, byHash: version });
  assert.equal(noRelease.ok ? undefined : noRelease.reason, 'no-release');
  assert.ok((await acts.release(previous)).ok);
  const update = Buffer.from(localInsert(doc, 'Fuel for three days.'.length, ' Reserve in place.')).toString('base64url');
  assert.ok((await appendProductEntry(lead.host, 'doc.update', { product: PRODUCT, update })).ok);
  const next = await prepare((await proposeText(lead, doc)).version);
  const input = { ...previous, byHash: next.hash };
  const before = streamEntries(lead.at, stream);
  const earlier = await acts.supersede({ ...previous, byHash: previous.hash });
  assert.equal(earlier.ok ? undefined : earlier.reason, 'out-of-order');
  const unreleased = await acts.supersede(input);
  assert.equal(unreleased.ok ? undefined : unreleased.reason, 'not-released');
  const stale = await acts.supersede({ ...previous, byHash: '0'.repeat(64) });
  assert.equal(stale.ok ? undefined : stale.reason, 'stale-version');
  assert.deepEqual(streamEntries(lead.at, stream), before);
  assert.ok((await acts.release(next)).ok);
  await syncTo(lead, alternate, [stream]);
  const replacer = new VersionActs(alternate.p, PERSON);
  const agent = await new VersionActs(alternate.p, OWNER).supersede(input);
  assert.equal(agent.ok ? undefined : agent.reason, 'agent-cannot-decide');
  const written = await replacer.supersede(input);
  assert.ok(written.ok, written.ok ? undefined : written.message);
  const [entry] = await alternate.p.findOwnAll('version.supersede', () => true);
  assert.deepEqual(entry?.data, input);
  assert.equal(entry.hash, written.hash);
  assert.equal(entry.stream, stream);
  await syncTo(alternate, lead, [stream]);
  const a = await versionFold(lead, stream);
  const b = await versionFold(alternate, stream);
  assert.deepEqual(a.product.versions.map((version) => version.state), ['superseded', 'released']);
  assert.equal(a.product.records[0]?.release.supersededBy, 2);
  assert.equal(a.fold.digests[stream], b.fold.digests[stream]);
  assert.deepEqual(a.product.refusals, []);
});

// ---- 33-05: proposing from the live text, and the staff host's shared branch ----------------------------------------------------------------

/** A product with live text and no version yet. */
async function liveProduct(lead: Seat) {
  const created = await appendProductEntry(lead.host, 'product.create', { product: PRODUCT, section: 'j4', roles: ROLES, title: 'Logistics estimate' }, { label: LABEL });
  assert.ok(created.ok, created.ok ? undefined : created.message);
  const { roster } = await lead.p.state();
  const clientId = clientIdOf(roster.members.devices.get(lead.writer)?.[0]?.slot ?? 1, 0);
  assert.ok((await appendProductEntry(lead.host, 'doc.client', { product: PRODUCT, clientId, actor: { kind: 'person' } })).ok);
  const doc = createLocalDoc(clientId);
  const type = async (text: string): Promise<void> => {
    const update = Buffer.from(localInsert(doc, docText(doc).length, text)).toString('base64url');
    assert.ok((await appendProductEntry(lead.host, 'doc.update', { product: PRODUCT, update })).ok);
  };
  await type('Fuel for three days.');
  return { stream: created.stream, type };
}

test('propose takes the live text the fold accepted, keeps the newest header, and refuses an unchanged text or a first version with no kind', async () => {
  const lead = await leadWith();
  const { stream, type } = await liveProduct(lead);
  const owner = new VersionActs(lead.p, OWNER, { deps: lead.at.deps });
  const before = streamEntries(lead.at, stream);
  const missing = await owner.propose({ product: PRODUCT });
  assert.equal(missing.ok ? undefined : missing.reason, 'header-missing');
  const without = await new VersionActs(lead.p, OWNER).propose({ product: PRODUCT, header: { kind: 'estimate', profile: 'j4', level: 'official' } });
  assert.equal(without.ok ? undefined : without.reason, 'cannot-write');
  const unknown = await owner.propose({ product: 'no-such-product' });
  assert.equal(unknown.ok ? undefined : unknown.reason, 'product-unavailable');
  assert.deepEqual(streamEntries(lead.at, stream), before);

  const first = await owner.propose({ product: PRODUCT, header: { kind: 'estimate', profile: 'j4', level: 'official' } });
  assert.ok(first.ok, first.ok ? undefined : first.message);
  assert.equal(first.version, replicaVersionHash('Fuel for three days.', []));
  let { product, fold } = await versionFold(lead, stream);
  assert.deepEqual(product.versions.map((version) => [version.number, version.hash, version.header]),
    [[1, first.version, { label: LABEL, kind: 'estimate', profile: 'j4', level: 'official' }]]);
  assert.deepEqual(fold.refused, []);
  const again = await owner.propose({ product: PRODUCT });
  assert.equal(again.ok ? undefined : again.reason, 'unchanged');

  await type(' Water for two.');
  const second = await owner.propose({ product: PRODUCT });
  assert.ok(second.ok, second.ok ? undefined : second.message);
  ({ product, fold } = await versionFold(lead, stream));
  assert.deepEqual(product.versions.map((version) => [version.number, version.hash, version.header.kind]),
    [[1, first.version, 'estimate'], [2, replicaVersionHash('Fuel for three days. Water for two.', []), 'estimate']]);
  assert.deepEqual(fold.refused, []);
  assert.deepEqual(product.refusals, []);
});

test('in a shared project the staff host proposes, checks, submits and decides on the shared record, and the mechanical check binds to the version', async () => {
  const lead = await leadWith({ roles: LEAD_DECISION_ROLES });
  ok(await updateMember(lead.host, { member: lead.member, agentSeats: [ROLES.releaseGuard] }), 'authorise guard');
  const { stream } = await liveProduct(lead);
  const { signer } = await ReplicaProject.localDevice(lead.at.deps);
  const host = new StaffHost({
    root: lead.at.root, signer: async () => signer, keyStatus: async () => trusting(signer), headStore: lead.at.secrets,
    now: () => lead.at.clock.now.getTime(), replica: { globalStorageDir: lead.at.global }
  });
  const team = { slug: 'j4-logistics', section: 'j4' as const, sectionLead: ROLES.sectionLead, members: Object.values(ROLES) };
  const as = (member: string) => ({ member, run: `${member}-run`, root: lead.at.root, team });
  const person = { kind: 'person' as const, name: 'A. Demo', role: 'commander', deviceFingerprint: signer.fingerprint };
  const text = (result: { ok: true; text: string } | { ok: false; message: string }): string => (result.ok ? result.text : result.message);
  try {
    const proposed = await host.propose(as(ROLES.owner), { product: PRODUCT, kind: 'estimate' });
    assert.ok(proposed.ok, text(proposed));
    assert.match(text(proposed), /^logistics-estimate version 1 recorded in the shared record\./);
    const target = { product: PRODUCT, hash: replicaVersionHash('Fuel for three days.', []) };
    const { writeProjections } = await import('../staff/replica/projection');
    const { projectionInputOf } = await import('../staff/replica/migrate');
    await writeProjections(lead.at.root, await projectionInputOf(lead.p, lead.at.deps));
    const file = path.join(lead.at.root, ...productPath('j4', PRODUCT).split('/'));
    const projected = readFileSync(file);

    // A file that is not the version named is never what a CLEARED rests on.
    writeFileSync(file, `${projected.toString('utf8')}\nAn edit made outside the shared editor.\n`);
    const refused = await host.verdict(as(ROLES.releaseGuard), { ...target, gate: 'guard', verdict: 'CLEARED', reasons: [] });
    assert.equal(text(refused), 'CLEARED is refused: the product file on this computer is not version 1. Sync, then check it again.');
    assert.equal((await lead.p.findOwnAll('version.verdict', () => true)).length, 0);
    writeFileSync(file, projected);

    const cleared = await host.verdict(as(ROLES.releaseGuard), { ...target, gate: 'guard', verdict: 'CLEARED', reasons: [] });
    assert.ok(cleared.ok, text(cleared));
    assert.equal(text(cleared), 'CLEARED recorded on logistics-estimate version 1; it is now guard-checked.');
    const submitted = await host.submit(as(ROLES.owner), { product: PRODUCT, decisionFor: 'commander' });
    assert.ok(submitted.ok, text(submitted));
    assert.match(text(submitted), /^logistics-estimate version 1 is awaiting a decision by the commander\./);
    const [submission] = await lead.p.findOwnAll('version.submit', () => true);
    assert.deepEqual(submission?.data, { ...target, decisionFor: 'commander' });

    // Withdrawing is a person's step; an agent asking the host writes nothing.
    const before = streamEntries(lead.at, stream);
    assert.equal(text(await host.withdraw(as(ROLES.owner), { product: PRODUCT, reason: 'Overtaken by events.' })), VERSION_ACT_WORDS['agent-cannot-decide']);
    // A decision dialog that showed another state of the version is stopped with the D-24 sentence.
    assert.equal(text(await host.decide(person, { ...target, action: 'approve', stamp: 'f'.repeat(64) })), CHANGED_WHILE_DECIDING_TEXT);
    // An approval names the version the person saw.
    assert.equal(text(await host.decide(person, { product: PRODUCT, action: 'approve' })), VERSION_ACT_WORDS['stale-version']);
    assert.deepEqual(streamEntries(lead.at, stream), before);

    const stamp = await (await host.sharedReplica())?.decisionStamp(target);
    assert.ok(stamp);
    const released = await host.decide(person, { ...target, action: 'approve', stamp, releaseOnApproval: true, reasons: ['Ready to proceed.'] });
    assert.ok(released.ok, text(released));
    assert.equal(text(released), 'logistics-estimate version 1 is now released, by A. Demo (commander).');
    const [decision] = await lead.p.findOwnAll('version.decide', () => true);
    assert.deepEqual(decision?.data, { ...target, outcome: 'approve', reasons: ['Ready to proceed.'], decisionsSeen: [] });
    const { product, fold } = await versionFold(lead, stream);
    assert.deepEqual(product.records[0]?.acts.find((act) => act.entry === decision.hash)?.actor, PERSON);
    assert.equal(product.versions[0]?.state, 'released');
    assert.deepEqual(fold.refused, []);
    assert.deepEqual(product.refusals, []);
  } finally {
    await host.close();
  }
});
