// Phase 33 plan 26 (D-24, D-59, D-60; Pitfall N8.4): the Staff Room service over a live engine and the engine bundle's version acts. A contested
// version is one card; beginDecision keeps the version's decision stamp in the backend, and decide writes the decision with it as a person, signed
// by the project's signer for the kind (the person key in a hosted session). A decision that folds meanwhile refuses with the D-24 sentence and
// nothing is written; a confirmation that is too old answers with the step-up link and the same stamp finishes later. Fictional exercise data only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StaffEngine } from '../extension/src/node/staff/staff-engine.ts';
import { StaffLiveEngine } from '../extension/src/node/staff/staff-live-engine.ts';
import { StaffRoomService, type RoomActs } from '../extension/src/node/staff/staff-room-service.ts';
import { KEY_SERVICE_TEXT } from '../extension/src/common/key-service.ts';
import { stepUpUrl } from '../extension/src/common/session-identity.ts';
import type { StaffRoom } from '../extension/src/common/staff-room.ts';
import { clientIdOf } from '../../src/domain/replica/clientIds.ts';
import { createLocalDoc, docText, localInsert, snapshotOf } from '../../src/domain/replica/doc.ts';
import type { Actor } from '../../src/domain/replica/entry.ts';
import { appendProductEntry, proposeVersion } from '../../src/staff/replica/labelCells.ts';
import { updateMember } from '../../src/staff/replica/membership.ts';
import { VersionActs } from '../../src/staff/replica/versionActs.ts';
import { bringIn, leadWith, ok, orgClearance, streamEntries, syncTo, type Seat } from '../../src/test/helpers/labelCellWorld.ts';
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

/** Two people who both decide for the commander, and one version of a product awaiting their decision. */
async function awaiting(): Promise<{ lead: Seat; alternate: Seat; stream: string; target: { product: string; hash: string } }> {
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
  assert.ok((await appendProductEntry(lead.host, 'doc.update', { product: PRODUCT, update: Buffer.from(localInsert(doc, 0, 'Fuel for three days.')).toString('base64url') })).ok);
  const proposed = await proposeVersion(lead.host, { product: PRODUCT, text: docText(doc), header: { kind: 'estimate', label: LABEL, profile: 'j4', level: 'official' }, pins: [], snapshot: snapshotOf(doc) });
  assert.ok(proposed.ok, proposed.ok ? '' : proposed.message);
  const target = { product: PRODUCT, hash: proposed.version };
  assert.ok((await new VersionActs(lead.p, GUARD).verdict({ ...target, gate: 'guard', verdict: 'CLEARED', reasons: [] })).ok);
  assert.ok((await new VersionActs(lead.p, OWNER).submit({ ...target, decisionFor: 'commander' })).ok);
  await syncTo(lead, alternate, [proposed.stream]);
  return { lead, alternate, stream: proposed.stream, target };
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
async function roomOf(seat: Seat, extra: { actsFor?: (shared: { project: never; deps: object }) => RoomActs } = {}) {
  let replicator: FakeReplicator | undefined;
  const live = new StaffLiveEngine({
    engine: { ...engine, LiveReplicator: function Made() { replicator = new FakeReplicator(); return replicator; } as never, projectLive: async () => ({ written: [], left: [] }) } as StaffEngine,
    roots: async () => [seat.at.root], globalStorageDir: seat.at.global, secrets: seat.at.secrets,
  });
  await live.start();
  const service = new StaffRoomService({ live: () => live, engine, stepUpAcr: () => ACR, ...(extra.actsFor === undefined ? {} : { actsFor: extra.actsFor as never }) });
  const project = live.projects()[0].project;
  const room = async (): Promise<StaffRoom> => (await service.rooms())[0];
  return { live, service, project, room, replicator: () => replicator as FakeReplicator };
}

test('a contested version gives one card with both names, both reasons and the two actions', async () => {
  const { lead } = await contested();
  const { live, room } = await roomOf(lead);
  try {
    const cards = (await room()).view.cards.filter((card) => card.kind === 'contested');
    assert.equal(cards.length, 1);
    // The two decisions come in the fold's order, which either may lead.
    assert.match(cards[0].text, /^Contested: .+ (approved|rejected) v1 and .+ (approved|rejected) it at the same time\. Neither applies\. A new decision is needed\.$/);
    assert.deepEqual(cards[0].decisions?.map((item) => item.reasons[0]).sort(), ['Fuel figures check out.', 'Water is missing.']);
    assert.deepEqual(cards[0].actions.map((action) => action.label), ['Approve v1', 'Reject v1']);
  } finally {
    await live.stop();
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
  // The person key as a hosted session has it: KeyService refuses until the passkey or security key confirmed again.
  const actsFor = (shared: { project: never; deps: object }): RoomActs => {
    const project = shared.project as unknown as { signerOf(kind: string): { fingerprint: string; publicKey: string; sign(bytes: Buffer): string } };
    const device = project.signerOf('version.decide');
    const person = {
      fingerprint: device.fingerprint, publicKey: device.publicKey,
      sign: async (bytes: Buffer) => { asked += 1; return fresh ? device.sign(bytes) : { refused: KEY_SERVICE_TEXT.stepUpNeeded, fix: KEY_SERVICE_TEXT.confirm }; },
    };
    const hosted = Object.create(project, { signerOf: { value: (kind: string) => (kind === 'version.decide' ? person : project.signerOf(kind)) } });
    const Acts = engine.VersionActs as unknown as new (project: unknown, actor: Actor, context: object) => RoomActs;
    return new Acts(hosted, PERSON, { deps: shared.deps });
  };
  const { live, service, project } = await roomOf(lead, { actsFor });
  try {
    const begun = await service.beginDecision(project, target.product, target.hash, false);
    assert.ok(begun.kind === 'ok');
    const before = streamEntries(lead.at, stream).length;
    const stale = await service.decide(begun.value.ticket, 'approve', ['Ready.'], '/staff?x=1');
    assert.deepEqual(stale, { kind: 'step-up', reason: KEY_SERVICE_TEXT.stepUpNeeded, fix: KEY_SERVICE_TEXT.confirm, url: stepUpUrl('/staff?x=1', ACR) });
    assert.equal(streamEntries(lead.at, stream).length, before, 'nothing written');
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
