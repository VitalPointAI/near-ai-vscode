// Every posting act needs the person key (Phase 33.1 plan 03 task 3; D-09): every roster-family kind and both personnel kinds are person-key kinds, so
// a stolen session key can type but cannot post, report, delegate, change the way of working or stage a key change. The fold refuses them, the same
// session key's typing still folds, and in a hosted project a 33.1 kind is signed only under the one action the person confirmed. Fictional only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { clientIdOf } from '../domain/replica/clientIds';
import { createLocalDoc, localInsert } from '../domain/replica/doc';
import { foldEntries } from '../domain/replica/fold';
import { joinSecretHash, newJoinSecret } from '../domain/replica/invite';
import { REPLICA_KINDS, kindFamily } from '../domain/replica/kinds';
import { PERSON_KEY_KINDS, isPersonKeyKind, requiresActionId, sessionCertifyData } from '../domain/replica/sessionKeys';
import type { AsyncPayloadSigner, PayloadSigner, SignOptions } from '../domain/team/signedPayload';
import { ReplicaProject } from '../staff/replica/replicaProject';
import { leadWith, orgClearance, project, streamEntries } from './helpers/labelCellWorld';
import { DEMO_CLEARANCE, INVITE_EXPIRES, createRosterWorld } from './helpers/replicaRosterWorld';
import type { RosterDevice, RosterWorld } from './helpers/replicaRosterWorld';
import { fixedSigner, updateData } from './helpers/replicaWorld';

const PAT = 'mbr-pat';
const POSITION = 'watch-officer-night';
const POSTING = 'pst-watch-night-1';
const NOT_AFTER = '2026-11-19T23:00:00.000Z';
const hashOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const POLICY = hashOf('policy/example-organization');
const START = '2026-11-19T00:00:00.000Z';

const createData = { position: POSITION, title: 'Watch Officer, night', section: 'j3', decides: [], clearance: DEMO_CLEARANCE, keyGroups: [], acting: false, dualHat: false };
const orderData = (member: string): Record<string, unknown> => ({
  posting: POSTING, position: POSITION, person: { member }, evidence: [hashOf('credential/clearance')], kind: 'substantive', start: START, policy: POLICY, stages: [],
  status: [{ list: 'urn:example:status:1', hash: hashOf('status/1'), validFrom: '2026-11-18T00:00:00.000Z' }]
});

// One data shape per 33.1 kind the session key tries, each valid for its closed schema.
const SESSION_TRIES: Array<[string, Record<string, unknown>]> = [
  ['position.create', { ...createData, position: 'j1-delegate' }],
  ['posting.order', { ...orderData(PAT), posting: 'pst-by-session' }],
  ['posting.report', { posting: POSTING }],
  ['authority.delegate', { grant: 'grt-j1', member: PAT, scope: { section: 'j1' }, kinds: ['substantive'], expiresAt: '2026-12-19T00:00:00.000Z', depth: 0 }],
  ['cell.rekey.staged', { cell: 'c'.repeat(32), epoch: 2, reason: 'scheduled', stage: 'prepared', posting: POSTING, replaces: 1 }],
  ['project.mode', { mode: 'military', settings: {}, policy: POLICY, reason: 'Fictional exercise way of working' }]
];

interface World { world: RosterWorld; pat: RosterDevice; session: RosterDevice; head: string }

/** The lead requires positions@1, admits Pat (laptop at slot 2), creates the position and orders Pat to it; Pat's laptop certifies a session key. */
function world(): World {
  const w = createRosterWorld();
  const pat = w.device('PAT-LAPTOP', PAT);
  const session = w.device('PAT-SESSION', PAT);
  const { entry: genesis } = w.genesis();
  const required = w.rosterEntry(w.lead, 'roster.require', { features: ['positions@1'] }, genesis.hash);
  const invite = w.rosterEntry(w.lead, 'member.invite', {
    invite: 'inv-pat', name: 'Pat Analyst', seat: 'j3-watch', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: joinSecretHash(newJoinSecret())
  }, required.hash);
  const admit = w.rosterEntry(w.lead, 'member.admit', {
    member: PAT, invite: 'inv-pat', name: 'Pat Analyst', seat: 'j3-watch', roles: ['member'], clearance: DEMO_CLEARANCE, device: pat.descriptor(2), agentSeats: []
  }, invite.hash);
  const create = w.rosterEntry(w.lead, 'position.create', createData, admit.hash);
  const order = w.rosterEntry(w.lead, 'posting.order', orderData(PAT), create.hash);
  const data = sessionCertifyData({ project: w.project, member: PAT, device: pat.writer, sessionKey: session.publicKey, slot: 2, notAfter: NOT_AFTER }, (bytes) => session.signer.sign(bytes));
  w.write(pat, { kind: 'session.certify', data, roster: order.hash });
  return { world: w, pat, session, head: order.hash };
}

const refusedReason = (state: ReturnType<RosterWorld['foldRoster']>, hash: string): string | undefined => state.refused.find((item) => item.hash === hash)?.reason;

test('PERSON_KEY_KINDS holds every roster-family kind and both personnel kinds, read from the kinds registry, and each 33.1 one is action-bound', () => {
  const required = REPLICA_KINDS.filter((kind) => kindFamily(kind) === 'roster' || kindFamily(kind) === 'personnel');
  assert.ok(required.includes('posting.unable') && required.includes('posting.reference') && required.includes('project.mode'));
  for (const kind of required) {
    assert.equal(isPersonKeyKind(kind), true, kind);
    assert.ok(PERSON_KEY_KINDS.includes(kind), kind);
  }
  for (const kind of ['position.create', 'posting.order', 'posting.report', 'authority.delegate', 'cell.rekey.staged', 'project.mode', 'posting.unable', 'posting.reference']) {
    assert.equal(requiresActionId(kind), true, kind);
  }
  for (const kind of ['doc.update', 'doc.compact', 'version.propose']) assert.equal(isPersonKeyKind(kind), false, kind);
});

test('a certified session key writing a 33.1 roster kind is refused person-key-required by the fold and the roster does not move; its doc.update still folds as Pat\'s', () => {
  const w = world();
  const tried = SESSION_TRIES.map(([kind, data]) => w.world.rosterEntry(w.session, kind, data, w.head));
  const clientId = clientIdOf(2, 0);
  const client = w.world.write(w.session, { kind: 'doc.client', data: { product: 'intel-estimate', clientId, actor: { kind: 'person' } }, roster: w.head });
  const typed = w.world.write(w.session, { kind: 'doc.update', data: updateData('intel-estimate', localInsert(createLocalDoc(clientId), 0, 'Fictional watch log')), roster: w.head });
  const state = w.world.foldRoster();
  assert.equal(state.positions[state.positions.length - 1], w.head, 'no session-key change applied');
  for (const written of tried) assert.equal(refusedReason(state, written.hash), 'person-key-required', written.hash);
  const result = foldEntries(w.world.entries, w.world.ctxFor(state, w.world.ringFor(w.world.lead)));
  assert.ok(result.applied.includes(client.hash) && result.applied.includes(typed.hash), 'the same session key\'s typing folds');
});

test('a personnel kind written by a session key is kept person-key-required by the fold, like the roster kinds', () => {
  const w = world();
  const reference = w.world.write(w.session, { kind: 'posting.reference', data: { posting: POSTING, sealed: Buffer.from('fictional sealed note').toString('base64url') }, roster: w.head });
  const state = w.world.foldRoster();
  const result = foldEntries(w.world.entries, w.world.ctxFor(state, w.world.ringFor(w.world.lead)));
  assert.equal(result.kept.find((entry) => entry.hash === reference.hash)?.reason, 'person-key-required');
});

test('Pat\'s session key cannot report for Pat\'s own posting; Pat\'s laptop, the person key\'s device, can', () => {
  const w = world();
  const bySession = w.world.rosterEntry(w.session, 'posting.report', { posting: POSTING }, w.head);
  const byLaptop = w.world.rosterEntry(w.pat, 'posting.report', { posting: POSTING }, w.head);
  const state = w.world.foldRoster();
  assert.equal(refusedReason(state, bySession.hash), 'person-key-required');
  assert.equal(state.positions[state.positions.length - 1], byLaptop.hash, 'the laptop\'s report is the roster head');
});

/** A person signer that records the options of each call, standing in for your organization's key store. */
function recording(signer: PayloadSigner): AsyncPayloadSigner & { seen: Array<SignOptions | undefined> } {
  const wrapped = {
    seen: [] as Array<SignOptions | undefined>,
    fingerprint: signer.fingerprint,
    publicKey: signer.publicKey,
    sign: async (bytes: Buffer, options?: SignOptions): Promise<string> => {
      wrapped.seen.push(options);
      return signer.sign(bytes);
    }
  };
  return wrapped;
}

test('in a hosted project a posting.order with no action id is refused before anything is signed; under the action its step-up was taken for it signs', async () => {
  const lead = await leadWith({ label: 'signers-hosted' });
  const { roster } = await lead.p.state();
  const slot = roster.members.devices.get(lead.writer)?.find((record) => record.slot !== undefined)?.slot as number;
  const sessionKey = fixedSigner('HOSTED-POSITIONS-SESSION');
  const notAfter = new Date(lead.at.clock.now.getTime() + 12 * 60 * 60 * 1000).toISOString();
  const certified = await lead.p.appendOwn('session.certify', sessionCertifyData({ project: lead.p.projectId, member: lead.member, device: lead.writer, sessionKey: sessionKey.publicKey, slot, notAfter }, (bytes) => sessionKey.signer.sign(bytes)));
  assert.ok('ok' in certified);
  const person = recording(lead.p.signer);
  const hosted = project(await ReplicaProject.open(lead.at.root, { ...lead.at.deps, sessionSigner: sessionKey.signer, personSigner: person }));
  assert.ok('ok' in await hosted.appendOwn('roster.require', { features: ['positions@1'] }), 'a Phase 33 kind signs without an action id');
  assert.ok('ok' in await hosted.appendOwn('position.create', { ...createData, clearance: orgClearance('Internal') }, { action: 'act-create-1' }));
  const before = streamEntries(lead.at, lead.p.projectId).length;
  const calls = person.seen.length;
  const bare = await hosted.appendOwn('posting.order', orderData(lead.member));
  assert.ok(!('ok' in bare) && bare.refused === 'action-required', 'refused action-required');
  assert.equal(person.seen.length, calls, 'nothing was signed');
  assert.equal(streamEntries(lead.at, lead.p.projectId).length, before, 'nothing was appended');
  const bound = await hosted.appendOwn('posting.order', orderData(lead.member), { action: 'act-order-1' });
  assert.ok('ok' in bound, 'ok' in bound ? undefined : bound.message);
  assert.equal(person.seen[person.seen.length - 1]?.action, 'act-order-1', 'the person signer is given the action');
  const state = await hosted.state();
  assert.equal(state.roster.positions[state.roster.positions.length - 1], bound.hash, 'the order folds');
});
