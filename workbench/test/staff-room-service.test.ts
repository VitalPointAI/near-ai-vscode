// Phase 33 plan 26 (D-24, D-59, D-60; Pitfall N8.4): the Staff Room service over a live engine and the engine bundle's version acts. A contested
// version is one card; beginDecision keeps the version's decision stamp in the backend, and decide writes the decision with it as a person, signed
// by the project's signer for the kind (the person key in a hosted session). A decision that folds meanwhile refuses with the D-24 sentence and
// nothing is written; a confirmation that is too old answers with the step-up link and the same stamp finishes later. Fictional exercise data only.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { staffRoomView } from '../extension/src/browser/staff/staff-room-view.ts';
import type { StaffEngine } from '../extension/src/node/staff/staff-engine.ts';
import { StaffLiveEngine, type HostedSessionKeys } from '../extension/src/node/staff/staff-live-engine.ts';
import { StaffRoomService } from '../extension/src/node/staff/staff-room-service.ts';
import { startSessionKeys } from '../extension/src/node/staff/session-keys.ts';
import { KEY_SERVICE_TEXT } from '../extension/src/common/key-service.ts';
import { stepUpUrl } from '../extension/src/common/session-identity.ts';
import { STAFF_ROOM_TEXT, type StaffRoom } from '../extension/src/common/staff-room.ts';
import { ok as signed, refused } from '../extension/src/common/service-result.ts';
import { clientIdOf } from '../../src/domain/replica/clientIds.ts';
import { createLocalDoc, docText, localInsert, snapshotOf } from '../../src/domain/replica/doc.ts';
import type { Actor } from '../../src/domain/replica/entry.ts';
import { entryHash } from '../../src/domain/replica/entry.ts';
import type { ProductVersions } from '../../src/domain/replica/versions.ts';
import { appendProductEntry, proposeVersion } from '../../src/staff/replica/labelCells.ts';
import { updateMember } from '../../src/staff/replica/membership.ts';
import { deviceKeys } from '../../src/staff/replica/projectDevice.ts';
import { CHANGED_WHILE_DECIDING_TEXT, VERSION_ACT_WORDS, VersionActs } from '../../src/staff/replica/versionActs.ts';
import { bringIn, leadWith, MemorySecrets, ok, orgClearance, streamEntries, syncTo, type Seat } from '../../src/test/helpers/labelCellWorld.ts';
import { engine, FakeReplicator, relayPresence, settle, until, withProduct } from './helpers/staff-binding-world.ts';
import { FakeTimers } from '../../src/test/helpers/liveWorld.ts';

const PRODUCT = 'logistics-estimate';
const LABEL = 'org/Internal';
const ROLES = { owner: 'j4-planner', sectionLead: 'j4-lead', releaseGuard: 'j4-guard' };
const PERSON: Actor = { kind: 'person' };
const OWNER: Actor = { kind: 'agent', member: ROLES.owner, run: 'owner-run' };
const GUARD: Actor = { kind: 'agent', member: ROLES.releaseGuard, run: 'guard-run' };
const DECIDERS = ['member', 'section_lead:j4', 'decision_for:commander'];
const ACR = 'urn:example:stepup';

/** Two people who both decide for the commander, and one cleared or submitted version. */
async function awaiting(state: 'awaiting-decision' | 'guard-checked' = 'awaiting-decision') {
  const lead = await leadWith({ roles: DECIDERS });
  const alternate = await bringIn(lead, 'alternate', 'Alternate Commander', orgClearance('Internal'));
  ok(await updateMember(lead.host, { member: alternate.member, roles: ['member', 'decision_for:commander'] }), 'authorize alternate');
  ok(await updateMember(lead.host, { member: lead.member, agentSeats: [ROLES.releaseGuard] }), 'authorise guard');
  const created = await appendProductEntry(lead.host, 'product.create', { product: PRODUCT, section: 'j4', roles: ROLES, title: 'Logistics estimate' }, { label: LABEL });
  assert.ok(created.ok, created.ok ? '' : created.message);
  const { roster } = await lead.p.state();
  const clientId = clientIdOf(roster.members.devices.get(lead.writer)?.[0]?.slot ?? 1, 0);
  assert.ok((await appendProductEntry(lead.host, 'doc.client', { product: PRODUCT, clientId, actor: { kind: 'person' } })).ok);
  const doc = createLocalDoc(clientId);
  const typeMore = async (text: string): Promise<void> => {
    const update = Buffer.from(localInsert(doc, docText(doc).length, text)).toString('base64url');
    assert.ok((await appendProductEntry(lead.host, 'doc.update', { product: PRODUCT, update })).ok);
  };
  await typeMore('Fuel for three days.');
  const proposed = await proposeVersion(lead.host, { product: PRODUCT, text: docText(doc), header: { kind: 'estimate', label: LABEL, profile: 'j4', level: 'official' }, pins: [], snapshot: snapshotOf(doc) });
  assert.ok(proposed.ok, proposed.ok ? '' : proposed.message);
  const target = { product: PRODUCT, hash: proposed.version };
  assert.ok((await new VersionActs(lead.p, GUARD).verdict({ ...target, gate: 'guard', verdict: 'CLEARED', reasons: [] })).ok);
  if (state === 'awaiting-decision') assert.ok((await new VersionActs(lead.p, OWNER).submit({ ...target, decisionFor: 'commander' })).ok);
  await syncTo(lead, alternate, [proposed.stream]);
  return { lead, alternate, stream: proposed.stream, target, typeMore };
}

/** Both decide offline, and each computer has both decisions: the version is contested. */
async function contested() {
  const world = await awaiting();
  const { lead, alternate, stream, target } = world;
  assert.ok((await new VersionActs(lead.p, PERSON).decide({ ...target, outcome: 'approve', reasons: ['Fuel figures check out.'] })).ok);
  assert.ok((await new VersionActs(alternate.p, PERSON).decide({ ...target, outcome: 'reject', reasons: ['Water is missing.'] })).ok);
  await syncTo(alternate, lead, [stream]);
  await syncTo(lead, alternate, [stream]);
  return world;
}

/** The lead's live engine (its replicator faked) and the Staff Room service over it. */
async function roomOf(seat: Seat, hosted?: HostedSessionKeys) {
  let replicator: FakeReplicator | undefined;
  const live = new StaffLiveEngine({
    engine: { ...engine, LiveReplicator: function Made() { replicator = new FakeReplicator(); return replicator; } as never, projectLive: async () => ({ written: [], left: [] }) } as StaffEngine,
    roots: async () => [seat.at.root], globalStorageDir: seat.at.global,
    secrets: hosted === undefined ? seat.at.secrets : new MemorySecrets(), hosted, now: () => seat.at.clock.now,
  });
  await live.start();
  const service = new StaffRoomService({ live: () => live, engine, stepUpAcr: () => ACR });
  const project = live.projects()[0].project;
  const room = async (): Promise<StaffRoom> => (await service.rooms())[0];
  return { live, service, project, room, replicator: () => replicator as FakeReplicator };
}

async function hostedRoomOf(seat: Seat) {
  const person = seat.p.signer;
  let beforeSign: (() => Promise<string | undefined>) | undefined;
  const keyService = {
    async sign(message: string) {
      const reason = await beforeSign?.();
      if (reason !== undefined) return refused(reason, KEY_SERVICE_TEXT.confirm);
      const signature = Buffer.from(person.sign(Buffer.from(message, 'base64')), 'base64url').toString('base64');
      return signed({ signature, keyVersion: 1 });
    },
  };
  const identity = { status: () => ({ mode: 'hosted' as const, state: 'active' as const }) };
  const started = await startSessionKeys(keyService, identity, { now: () => seat.at.clock.now.getTime() }, { personPublicKey: person.publicKey, engine });
  assert.ok(started.kind === 'ok');
  const { encryption, kem, kemPrivate } = await deviceKeys(seat.at.deps);
  const room = await roomOf(seat, {
    keys: started.value,
    encryption: { ...encryption, kem: kem === undefined || kemPrivate === undefined ? undefined : { publicKeys: kem, privateKeys: kemPrivate }, drop: () => undefined },
  });
  return {
    ...room, sessionWriter: engine.writerIdOf(started.value.sessionSigner.publicKey),
    onSigning: (callback: () => Promise<string | undefined>) => { beforeSign = callback; },
  };
}

const versionsOf = async (seat: Seat) =>
  ((await seat.p.state()).fold.families.versions as ProductVersions[]).find((product) => product.product === PRODUCT)?.versions ?? [];

const renderer = createRequire(import.meta.url)('@theia/core/shared/react-dom/server') as { renderToStaticMarkup(element: unknown): string };
const markupOf = (room: StaffRoom): string => renderer.renderToStaticMarkup(staffRoomView([room], {
  act: () => undefined, decide: () => undefined, cancel: () => undefined,
}));

test('the Staff Room submits and decides the exact version even after a newer proposal', async () => {
  const { lead, alternate, stream, target, typeMore } = await awaiting('guard-checked');
  const owner = await hostedRoomOf(lead);
  const viewer = await roomOf(alternate);
  const actions = async (room: typeof viewer.room) => {
    const row = (await room()).view.rows.find((item) => item.product === PRODUCT);
    assert.ok(row);
    return row.versionActions;
  };
  try {
    const before = streamEntries(lead.at, stream);
    assert.equal((await owner.service.submit(owner.project, PRODUCT, target.hash, 'unassigned')).kind, 'refused');
    assert.equal((await owner.service.submit('0'.repeat(32), PRODUCT, target.hash, 'commander')).kind, 'refused');
    assert.equal((await owner.service.submit(owner.project, 'other-product', target.hash, 'commander')).kind, 'refused');
    assert.equal((await owner.service.submit(owner.project, PRODUCT, 'f'.repeat(64), 'commander')).kind, 'refused');
    assert.equal((await viewer.service.submit(viewer.project, PRODUCT, target.hash, 'commander')).kind, 'refused');
    assert.equal((await owner.service.beginDecision(owner.project, PRODUCT, target.hash, false)).kind, 'refused');
    assert.deepEqual(streamEntries(lead.at, stream), before);
    assert.deepEqual(streamEntries(alternate.at, stream), before);
    assert.deepEqual(await actions(owner.room), [{ hash: target.hash, number: 1, submitRoles: ['commander'] }]);
    assert.equal(await actions(viewer.room), undefined);
    const form = markupOf(await owner.room());
    const roleField = /<label for="([^"]+)">Decision role for v1 of [^<]+<\/label><select id="\1"/;
    assert.match(form, roleField);
    assert.match(form, /<button type="submit"[^>]*aria-label="Submit v1 of [^"]+"/);

    const submitted = await owner.service.submit(owner.project, PRODUCT, target.hash, 'commander');
    assert.equal(submitted.kind, 'ok');
    assert.equal(streamEntries(lead.at, stream).find((entry) => entryHash(entry.header) === submitted.value)?.header.writer, owner.sessionWriter);
    assert.equal(owner.replicator().appended, 1);
    assert.equal((await owner.service.submit(owner.project, PRODUCT, target.hash, 'commander')).kind, 'refused');
    assert.equal((await versionsOf(lead))[0]?.state, 'awaiting-decision');
    await syncTo(lead, alternate, [stream]);
    assert.deepEqual(await actions(owner.room), [{ hash: target.hash, number: 1, submitRoles: [], decide: true }]);
    assert.deepEqual(await actions(viewer.room), await actions(owner.room));
    assert.equal((await owner.service.beginDecision(owner.project, PRODUCT, target.hash, true)).kind, 'refused');
    const begun = await owner.service.beginDecision(owner.project, PRODUCT, target.hash, false);
    assert.ok(begun.kind === 'ok');
    assert.deepEqual([begun.value.hash, begun.value.number, begun.value.settle], [target.hash, 1, false]);

    await typeMore(' Water for four.');
    assert.equal((await owner.service.propose(owner.project, PRODUCT)).kind, 'ok');
    assert.deepEqual(await actions(owner.room), [{ hash: target.hash, number: 1, submitRoles: [], decide: true }]);
    const afterProposal = markupOf(await owner.room());
    assert.match(afterProposal, /aria-label="Decide v1 of [^"]+"/);
    assert.doesNotMatch(afterProposal, /aria-label="Decide v2 of /);
    const beforeDecision = streamEntries(lead.at, stream).length;
    assert.deepEqual(await owner.service.decide('unknown-ticket', 'approve', [], '/'), { kind: 'refused', reason: STAFF_ROOM_TEXT.decisionGone });
    const decided = await owner.service.decide(begun.value.ticket, 'approve', ['Ready.'], '/');
    assert.ok(decided.kind === 'ok');
    assert.equal(streamEntries(lead.at, stream).length, beforeDecision + 1);
    assert.equal(streamEntries(lead.at, stream).find((entry) => entryHash(entry.header) === decided.value.hash)?.header.writer, lead.writer);
    const versions = await versionsOf(lead);
    assert.deepEqual(versions.map((version) => [version.number, version.state]), [[1, 'approved'], [2, 'draft']]);
    assert.equal(versions[0].hash, target.hash);
  } finally {
    await owner.live.stop();
    await viewer.live.stop();
  }
});

test('a decision ticket cannot follow the room into a different person’s session', async () => {
  const { lead, alternate, stream, target } = await awaiting();
  const owner = await roomOf(lead);
  const viewer = await roomOf(alternate);
  try {
    let current = owner.live;
    const service = new StaffRoomService({ live: () => current, engine });
    const begun = await service.beginDecision(owner.project, PRODUCT, target.hash, false);
    assert.ok(begun.kind === 'ok');
    current = viewer.live;
    assert.equal((await service.rooms())[0]?.pending, undefined);
    const before = streamEntries(alternate.at, stream);
    assert.deepEqual(await service.decide(begun.value.ticket, 'approve', [], '/'), { kind: 'refused', reason: STAFF_ROOM_TEXT.decisionGone });
    await service.cancelDecision(begun.value.ticket);
    assert.deepEqual(streamEntries(alternate.at, stream), before);
    current = owner.live;
    assert.equal((await service.rooms())[0]?.pending?.ticket, begun.value.ticket);
    await service.cancelDecision(begun.value.ticket);
    assert.equal((await service.rooms())[0]?.pending, undefined);
    assert.deepEqual(await service.decide(begun.value.ticket, 'approve', [], '/'), { kind: 'refused', reason: STAFF_ROOM_TEXT.decisionGone });
  } finally {
    await owner.live.stop();
    await viewer.live.stop();
  }
});

test('a person who lost the decision role cannot finish or reopen the ticket', async () => {
  const { lead, stream, target } = await awaiting();
  const { live, room, service, project, onSigning } = await hostedRoomOf(lead);
  try {
    const begun = await service.beginDecision(project, PRODUCT, target.hash, false);
    assert.ok(begun.kind === 'ok');
    const before = streamEntries(lead.at, stream);
    let asked = 0;
    onSigning(async () => { asked += 1; return undefined; });
    ok(await updateMember(lead.host, { member: lead.member, roles: ['member', 'section_lead:j4'] }), 'withdraw the decision role');
    assert.deepEqual(await service.decide(begun.value.ticket, 'approve', [], '/'), { kind: 'refused', reason: VERSION_ACT_WORDS['not-decision-holder'] });
    assert.equal((await room()).pending, undefined);
    assert.equal((await service.beginDecision(project, PRODUCT, target.hash, false)).kind, 'refused');
    assert.equal(asked, 0);
    assert.deepEqual(streamEntries(lead.at, stream), before);
  } finally {
    await live.stop();
  }
});

test('a competing approval during hosted signing closes the ticket even when the signer requests step-up', async () => {
  const { lead, alternate, stream, target } = await awaiting();
  const { live, room, service, project, onSigning } = await hostedRoomOf(lead);
  try {
    const begun = await service.beginDecision(project, PRODUCT, target.hash, false);
    assert.ok(begun.kind === 'ok');
    const approved = await new VersionActs(alternate.p, PERSON).decide({ ...target, outcome: 'approve', reasons: [] });
    assert.ok(approved.ok);
    const before = streamEntries(lead.at, stream).length;
    let asked = 0;
    onSigning(async () => {
      asked += 1;
      await syncTo(alternate, lead, [stream]);
      return KEY_SERVICE_TEXT.stepUpNeeded;
    });
    const result = await service.decide(begun.value.ticket, 'reject', ['Unavailable support.'], '/staff?x=1');
    assert.deepEqual(result, { kind: 'refused', reason: CHANGED_WHILE_DECIDING_TEXT });
    assert.equal(asked, 1);
    assert.equal((await room()).pending, undefined);
    assert.deepEqual(await service.decide(begun.value.ticket, 'reject', ['Unavailable support.'], '/'), { kind: 'refused', reason: STAFF_ROOM_TEXT.decisionGone });
    assert.deepEqual((await versionsOf(lead))[0]?.decision.effective, [approved.hash]);
    assert.equal(streamEntries(lead.at, stream).length, before + 1);
  } finally {
    await live.stop();
  }
});

test('a contested version gives one card with both names, both reasons and the two actions', async () => {
  const { lead, stream, target } = await contested();
  const observer = await bringIn(lead, 'observer', 'Staff Observer', orgClearance('Internal'));
  await syncTo(lead, observer, [stream]);
  const { live, room } = await roomOf(lead);
  const observed = await roomOf(observer);
  try {
    const cards = (await room()).view.cards.filter((card) => card.kind === 'contested');
    assert.equal(cards.length, 1);
    // The two decisions come in the fold's order, which either may lead.
    assert.match(cards[0].text, /^Contested: .+ (approved|rejected) v1 and .+ (approved|rejected) it at the same time\. Neither applies\. A new decision is needed\.$/);
    assert.deepEqual(cards[0].decisions?.map((item) => item.reasons[0]).sort(), ['Fuel figures check out.', 'Water is missing.']);
    assert.deepEqual(cards[0].actions.map((action) => action.label), ['Approve v1', 'Reject v1']);
    const other = (await observed.room()).view.cards.find((card) => card.kind === 'contested');
    assert.deepEqual(other?.decisions, cards[0].decisions);
    assert.deepEqual(other?.actions, []);
    assert.equal((await observed.service.beginDecision(observed.project, PRODUCT, target.hash, true)).kind, 'refused');
  } finally {
    await live.stop();
    await observed.live.stop();
  }
});

test('beginDecision keeps the stamp in the backend, and settling writes one decision as a person that lists every contested decision; the card goes', async () => {
  const { lead, stream, target } = await contested();
  const { live, service, project, room, replicator } = await roomOf(lead);
  try {
    const begun = await service.beginDecision(project, target.product, target.hash, true);
    assert.equal(begun.kind, 'ok');
    assert.ok(begun.kind === 'ok');
    assert.equal((await room()).pending?.ticket, begun.value.ticket, 'the room shows the open decision');
    const contestedIds = ((await lead.p.state()).fold.families.versions as Array<{ product: string; versions: Array<{ decision: { contested: string[] } }> }>)
      .find((item) => item.product === PRODUCT)?.versions[0].decision.contested;
    const before = streamEntries(lead.at, stream).length;
    const decided = await service.decide(begun.value.ticket, 'approve', ['Water was added in annex B.'], '/');
    assert.equal(decided.kind, 'ok');
    assert.equal(streamEntries(lead.at, stream).length, before + 1, 'one entry');
    const [written] = await lead.p.findOwnAll('version.decide', (data: unknown) => (data as { decisionsSeen: string[] }).decisionsSeen.length > 0);
    assert.deepEqual((written.data as { decisionsSeen: string[] }).decisionsSeen, contestedIds);
    assert.equal(replicator().appended, 1, 'the replicator was told to push');
    const after = await room();
    assert.equal(after.view.cards.filter((card) => card.kind === 'contested').length, 0);
    assert.equal(after.pending, undefined);
  } finally {
    await live.stop();
  }
});

test('when another decision on the version folds between beginDecision and decide, the answer is the D-24 sentence and nothing is written', async () => {
  const { lead, alternate, stream, target } = await awaiting();
  const { live, service, project } = await roomOf(lead);
  try {
    const begun = await service.beginDecision(project, target.product, target.hash, false);
    assert.ok(begun.kind === 'ok');
    assert.ok((await new VersionActs(alternate.p, PERSON).decide({ ...target, outcome: 'approve', reasons: [] })).ok);
    await syncTo(alternate, lead, [stream]);
    const before = streamEntries(lead.at, stream).length;
    const decided = await service.decide(begun.value.ticket, 'reject', ['Unavailable support.'], '/');
    assert.deepEqual(decided, { kind: 'refused', reason: 'Someone else decided this version while you were deciding. Look again.' });
    assert.equal(streamEntries(lead.at, stream).length, before);
    assert.deepEqual(await service.decide(begun.value.ticket, 'reject', ['Unavailable support.'], '/'), { kind: 'refused', reason: 'This decision is no longer open. Look again.' });
  } finally {
    await live.stop();
  }
});

test('with a confirmation that is too old, decide answers the fix and the step-up link; after a fresh one the same stamp completes', async () => {
  const { lead, stream, target } = await awaiting();
  let fresh = false;
  let asked = 0;
  const { live, room, service, project, onSigning } = await hostedRoomOf(lead);
  try {
    const begun = await service.beginDecision(project, target.product, target.hash, false);
    assert.ok(begun.kind === 'ok');
    const before = streamEntries(lead.at, stream).length;
    onSigning(async () => { asked += 1; return fresh ? undefined : KEY_SERVICE_TEXT.stepUpNeeded; });
    const stale = await service.decide(begun.value.ticket, 'approve', ['Ready.'], '/staff?x=1');
    assert.deepEqual(stale, { kind: 'step-up', reason: KEY_SERVICE_TEXT.stepUpNeeded, fix: KEY_SERVICE_TEXT.confirm, url: stepUpUrl('/staff?x=1', ACR) });
    assert.equal(streamEntries(lead.at, stream).length, before, 'nothing written');
    assert.equal((await room()).pending?.ticket, begun.value.ticket);
    fresh = true;
    const done = await service.decide(begun.value.ticket, 'approve', ['Ready.'], '/staff?x=1');
    assert.equal(done.kind, 'ok', JSON.stringify(done));
    assert.equal(asked, 2);
    assert.equal(streamEntries(lead.at, stream).length, before + 1);
  } finally {
    await live.stop();
  }
});

test('only a person decides: the room\'s acts write as a person, and an agent actor is refused by the executed version acts', async () => {
  const { lead, target } = await awaiting();
  const { live, service, project } = await roomOf(lead);
  try {
    const agent = await new VersionActs(lead.p, OWNER).decide({ ...target, outcome: 'approve', reasons: [] });
    assert.deepEqual(agent.ok ? undefined : agent.reason, 'agent-cannot-decide');
    const begun = await service.beginDecision(project, target.product, target.hash, false);
    assert.ok(begun.kind === 'ok');
    assert.equal((await service.decide(begun.value.ticket, 'approve', [], '/')).kind, 'ok');
    const shared = live.shared(project);
    assert.ok(shared);
    const versions = (await shared.project.state() as unknown as { fold: { families: Record<string, unknown> } }).fold.families.versions as Array<{ product: string; records: Array<{ acts: Array<{ kind: string; actor: { kind: string } }> }> }>;
    const decisions = versions.find((item) => item.product === PRODUCT)?.records.flatMap((record) => record.acts).filter((act) => act.kind === 'version.decide');
    assert.deepEqual(decisions?.map((act) => act.actor.kind), ['person'], JSON.stringify(versions.flatMap((item) => item.records.flatMap((record) => record.acts.map((act) => [act.kind, act.actor])))));
  } finally {
    await live.stop();
  }
});

test('a version the shared record does not hold opens no decision', async () => {
  const { lead } = await awaiting();
  const { live, service, project } = await roomOf(lead);
  try {
    assert.deepEqual(await service.beginDecision(project, PRODUCT, 'f'.repeat(64), false), { kind: 'refused', reason: 'This version is not in the shared record on this computer.' });
    assert.deepEqual(await service.beginDecision('0'.repeat(32), PRODUCT, 'f'.repeat(64), false), { kind: 'refused', reason: 'This shared work is not open in this session.' });
  } finally {
    await live.stop();
  }
});

test('the people list shows each person presence heard, with the name and position this roster gives, and Last seen once they leave (33-29)', async () => {
  const timers = new FakeTimers();
  await withProduct(async ({ avery, blake }) => {
    const service = new StaffRoomService({ live: () => avery.live, engine });
    const project = avery.device.project.projectId;
    const peopleOf = async () => (await service.rooms()).find((room) => room.project === project)?.view.people ?? [];
    assert.deepEqual((await peopleOf()).map((person) => person.name), ['Avery Lead'], 'only this person before anyone is heard');
    await settle();
    relayPresence(blake, avery);
    const people = await until(peopleOf, (list) => list.some((person) => person.name === 'Blake Rivers' && person.live), 'Blake in the people list');
    assert.equal(people.find((person) => person.name === 'Blake Rivers')?.position, 'j4-planner');
    await blake.live.stop();
    relayPresence(blake, avery);
    await until(peopleOf, (list) => list.some((person) => person.name === 'Blake Rivers' && !person.live), 'Blake shown as last seen');
  }, { timers });
});
