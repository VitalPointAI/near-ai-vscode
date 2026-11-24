// Session keys certified by a person's own device (Phase 33 plan 21; D-60, D-62). A person's short-lived session key writes that person's ordinary
// work once a device of the person has certified it with session.certify; decisions and roster changes need the person key; revoking or quarantining
// the certifying device stops the session from that roster position on; and the fold reads no clock. Fictional exercise data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { clientIdOf, nextClientId } from '../domain/replica/clientIds';
import { createLocalDoc, localInsert } from '../domain/replica/doc';
import { foldEntries } from '../domain/replica/fold';
import type { FoldResult } from '../domain/replica/fold';
import { joinSecretHash, newJoinSecret } from '../domain/replica/invite';
import { REPLICA_KINDS, kindFamily, validateData } from '../domain/replica/kinds';
import { rosterView } from '../domain/replica/roster';
import type { RosterState } from '../domain/replica/roster';
import { PERSON_KEY_KINDS, SESSION_REFUSALS, certifiedWriter, isPersonKeyKind, sessionCertifyData } from '../domain/replica/sessionKeys';
import type { SessionBindingFields } from '../domain/replica/sessionKeys';
import type { ProductTextOutput } from '../domain/replica/textFold';
import { KEEP_REASONS, verifyEntry } from '../domain/replica/verify';
import { DEMO_CLEARANCE, INVITE_EXPIRES, createRosterWorld } from './helpers/replicaRosterWorld';
import type { RosterDevice, RosterWorld } from './helpers/replicaRosterWorld';
import { updateData } from './helpers/replicaWorld';
import type { Written } from './helpers/replicaWorld';

const PAT = 'mbr-pat';
const QUINN = 'mbr-quinn';
const PRODUCT = 'intel-estimate';
// ROSTER_AT is 2026-11-19T11:00Z, so this is the default 12 hours.
const NOT_AFTER = '2026-11-19T23:00:00.000Z';
const HASH = (char: string): string => char.repeat(64);

interface Shared {
  world: RosterWorld;
  pat: RosterDevice;
  quinn: RosterDevice;
  session: RosterDevice;
  slots: Map<string, number>;
  // The roster head after both members are admitted.
  head: string;
}

// The lead admits Pat (laptop at slot 2) and Quinn (laptop at slot 3); the lead's key ring opens the base cell, which every write here uses.
function shared(): Shared {
  const world = createRosterWorld();
  const pat = world.device('PAT-LAPTOP', PAT);
  const quinn = world.device('QUINN-LAPTOP', QUINN);
  // A session key is never a roster device: rosterDevice is used only for its signer and writer id.
  const session = world.device('PAT-SESSION', PAT);
  const { entry: genesis } = world.genesis();
  const invite = (id: string, name: string, prev: string): Written => world.rosterEntry(world.lead, 'member.invite', {
    invite: id, name, seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: joinSecretHash(newJoinSecret())
  }, prev);
  const admit = (member: string, id: string, name: string, device: RosterDevice, slot: number, prev: string): Written => world.rosterEntry(world.lead, 'member.admit', {
    member, invite: id, name, seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, device: device.descriptor(slot), agentSeats: []
  }, prev);
  const invitePat = invite('inv-pat', 'Pat Analyst', genesis.hash);
  const admitPat = admit(PAT, 'inv-pat', 'Pat Analyst', pat, 2, invitePat.hash);
  const inviteQuinn = invite('inv-quinn', 'Quinn Planner', admitPat.hash);
  const admitQuinn = admit(QUINN, 'inv-quinn', 'Quinn Planner', quinn, 3, inviteQuinn.hash);
  return { world, pat, quinn, session, slots: new Map([[pat.writer, 2], [quinn.writer, 3]]), head: admitQuinn.hash };
}

// The certifying device writes the certificate; the session key signs the binding (sessionSig) with its own key.
function certify(s: Shared, by: RosterDevice, session: RosterDevice, options: { roster?: string; fields?: Partial<SessionBindingFields>; at?: string } = {}): Written {
  const fields: SessionBindingFields = { project: s.world.project, member: by.member, device: by.writer, sessionKey: session.publicKey, slot: s.slots.get(by.writer) ?? 1, notAfter: NOT_AFTER, ...options.fields };
  const data = sessionCertifyData(fields, (bytes) => session.signer.sign(bytes));
  return s.world.write(by, { kind: 'session.certify', data, roster: options.roster ?? s.head, ...(options.at === undefined ? {} : { at: options.at }) });
}

function types(s: Shared, writer: RosterDevice, clientId: number, text: string, options: { roster?: string; product?: string } = {}): { client: Written; update: Written } {
  const roster = options.roster ?? s.head;
  const product = options.product ?? PRODUCT;
  const doc = createLocalDoc(clientId);
  const client = s.world.write(writer, { kind: 'doc.client', data: { product, clientId, actor: { kind: 'person' } }, roster });
  const update = s.world.write(writer, { kind: 'doc.update', data: updateData(product, localInsert(doc, 0, text)), roster });
  return { client, update };
}

function fold(s: Shared): { state: RosterState; result: FoldResult } {
  const state = s.world.foldRoster();
  return { state, result: foldEntries(s.world.entries, s.world.ctxFor(state, s.world.ringFor(s.world.lead))) };
}

const productOf = (result: FoldResult, product = PRODUCT): ProductTextOutput | undefined => (result.families.doc as ProductTextOutput[]).find((item) => item.product === product);
const keptReason = (result: FoldResult, hash: string): string | undefined => result.kept.find((item) => item.hash === hash)?.reason;
const refusedReason = (state: RosterState, hash: string): string | undefined => state.refused.find((item) => item.hash === hash)?.reason;

// ---- Task 1: the tracer ---------------------------------------------------------------------------------------------------------------------------

test('tracer: a session key certified by Pat\'s laptop writes a doc.update that folds as Pat\'s, and the certificate takes no roster position', () => {
  const s = shared();
  const certificate = certify(s, s.pat, s.session);
  const { client, update } = types(s, s.session, clientIdOf(2, 0), 'Enemy holds the ridge.');
  const { state, result } = fold(s);
  assert.deepEqual(state.refused, []);
  assert.equal(state.positions.includes(certificate.hash), false, 'a certificate is never on the roster line');
  assert.deepEqual(state.sessions.get(s.session.writer), {
    hash: certificate.hash, writer: s.session.writer, member: PAT, device: s.pat.writer, sessionKey: s.session.publicKey, slot: 2, notAfter: NOT_AFTER, roster: s.head
  });
  assert.deepEqual(certifiedWriter(rosterView(state), s.session.writer, s.head), { member: PAT, device: s.pat.writer, slot: 2 });
  assert.ok(result.applied.includes(client.hash));
  assert.ok(result.applied.includes(update.hash));
  const product = productOf(result);
  assert.equal(product?.text, 'Enemy holds the ridge.');
  assert.deepEqual(product?.attribution.map((span) => [span.writer, span.member, span.clientId]), [[s.session.writer, PAT, clientIdOf(2, 0)]]);
});

test('without a certificate the same doc.update is held as unknown-writer, as today', () => {
  const s = shared();
  const { client, update } = types(s, s.session, clientIdOf(2, 0), 'Enemy holds the ridge.');
  const { state, result } = fold(s);
  assert.equal(state.sessions.size, 0);
  for (const written of [client, update]) assert.equal(result.held.find((item) => item.hash === written.hash)?.reason, 'unknown-writer');
  assert.equal(result.applied.includes(update.hash), false);
  assert.equal(productOf(result), undefined);
});

test('a certificate with a bad key, a slot over 4095, another member, another device\'s slot, a wrong session signature or a bad lifetime is refused with its reason', () => {
  const s = shared();
  const valid = sessionCertifyData({ project: s.world.project, member: PAT, device: s.pat.writer, sessionKey: s.session.publicKey, slot: 2, notAfter: NOT_AFTER }, (bytes) => s.session.signer.sign(bytes));
  // Shape faults are the validator's: bad-data at verification.
  assert.equal(validateData('session.certify', valid).ok, true);
  const shortKey = s.world.write(s.pat, { kind: 'session.certify', data: { ...valid, sessionKey: Buffer.alloc(31, 7).toString('base64url') }, roster: s.head });
  const bigSlot = s.world.write(s.pat, { kind: 'session.certify', data: { ...valid, slot: 4096 }, roster: s.head });
  assert.equal(validateData('session.certify', { ...valid, extra: true }).ok, false);
  // Faults against the roster are the placement's: each with its own session key, so none is refused only as reused.
  const keys = ['S-QUINN', 'S-SLOT', 'S-SIG', 'S-LONG', 'S-BACKWARDS', 'S-DEVICE'].map((label) => s.world.device(label, PAT));
  const otherMember = certify(s, s.pat, keys[0], { fields: { member: QUINN } });
  const otherSlot = certify(s, s.pat, keys[1], { fields: { slot: 3 } });
  const forged = s.world.write(s.pat, { kind: 'session.certify', data: { ...sessionCertifyData({ project: s.world.project, member: PAT, device: s.pat.writer, sessionKey: keys[2].publicKey, slot: 2, notAfter: NOT_AFTER }, (bytes) => s.pat.signer.sign(bytes)) }, roster: s.head });
  const tooLong = certify(s, s.pat, keys[3], { fields: { notAfter: '2026-11-22T11:00:00.000Z' } });
  const backwards = certify(s, s.pat, keys[4], { fields: { notAfter: '2026-11-19T10:00:00.000Z' } });
  // A certificate written by one device naming another as its device.
  const wrongDevice = certify(s, s.pat, keys[5], { fields: { device: s.quinn.writer, member: QUINN, slot: 3 } });
  // A session key that is a roster device's own key.
  const deviceKey = certify(s, s.pat, s.quinn);
  const { state } = fold(s);
  assert.equal(refusedReason(state, shortKey.hash), 'bad-data');
  assert.equal(refusedReason(state, bigSlot.hash), 'bad-data');
  for (const written of [otherMember, otherSlot, forged, tooLong, backwards, wrongDevice, deviceKey]) assert.equal(refusedReason(state, written.hash), 'session-certificate-invalid', written.hash);
  assert.equal(state.sessions.size, 0);
  assert.equal(SESSION_REFUSALS['session-certificate-invalid'].includes('—'), false);
});

// ---- Task 2: refusals ----------------------------------------------------------------------------------------------------------------------------

test('PERSON_KEY_KINDS is every roster kind, the project genesis, session.certify and the four decision kinds; typing, compaction, proposals, verdicts and submissions are not', () => {
  for (const kind of REPLICA_KINDS.filter((item) => kindFamily(item) === 'roster')) assert.equal(isPersonKeyKind(kind), true, kind);
  for (const kind of ['project.genesis', 'session.certify', 'version.decide', 'version.release', 'version.supersede', 'version.withdraw', 'hub.readmit', 'roster.require']) assert.equal(isPersonKeyKind(kind), true, kind);
  for (const kind of ['doc.client', 'doc.update', 'doc.compact', 'version.propose', 'version.verdict', 'version.submit', 'product.create', 'not.a.kind']) assert.equal(isPersonKeyKind(kind), false, kind);
  assert.equal(PERSON_KEY_KINDS.length, new Set(PERSON_KEY_KINDS).size);
  assert.equal(SESSION_REFUSALS['person-key-required'], 'Only the person\'s own key can make this change.');
  assert.equal(KEEP_REASONS['person-key-required'], SESSION_REFUSALS['person-key-required']);
});

test('a session key writing a roster kind, a decision kind or a certificate is refused person-key-required; the roster does not move', () => {
  const s = shared();
  certify(s, s.pat, s.session);
  const roster = [
    s.world.rosterEntry(s.session, 'member.update', { member: PAT, name: 'Pat Analyst Senior' }, s.head),
    s.world.rosterEntry(s.session, 'roster.require', { features: ['cells@1'] }, s.head),
    s.world.rosterEntry(s.session, 'hub.readmit', { hub: 'hub-main', certPin: HASH('b') }, s.head)
  ];
  const ownCertificate = certify(s, s.session, s.world.device('PAT-SECOND-SESSION', PAT), { fields: { device: s.session.writer, slot: 2 } });
  const decisions = [
    s.world.write(s.session, { kind: 'version.decide', data: { product: PRODUCT, hash: HASH('c'), outcome: 'approve', reasons: [], decisionsSeen: [] }, roster: s.head }),
    s.world.write(s.session, { kind: 'version.release', data: { product: PRODUCT, hash: HASH('c'), decisionsSeen: [] }, roster: s.head }),
    s.world.write(s.session, { kind: 'version.supersede', data: { product: PRODUCT, hash: HASH('c'), byHash: HASH('d') }, roster: s.head }),
    s.world.write(s.session, { kind: 'version.withdraw', data: { product: PRODUCT, hash: HASH('c'), reason: 'Exercise ended.', decisionsSeen: [] }, roster: s.head })
  ];
  const { state, result } = fold(s);
  assert.equal(state.positions[state.positions.length - 1], s.head, 'no roster change by a session key applies');
  for (const written of [...roster, ownCertificate]) assert.equal(refusedReason(state, written.hash), 'person-key-required', written.hash);
  for (const written of [...roster, ownCertificate, ...decisions]) assert.equal(keptReason(result, written.hash), 'person-key-required', written.hash);
  assert.equal(state.sessions.size, 1, 'a session key cannot certify another');
});

test('propose, verdict, submit, doc.update and doc.compact by a certified session key verify with nothing kept back', () => {
  const s = shared();
  certify(s, s.pat, s.session);
  const written = [
    s.world.write(s.session, { kind: 'version.propose', data: { product: PRODUCT, hash: HASH('c'), textBlob: HASH('e'), snapshot: Buffer.from('snapshot').toString('base64url'), pins: [] }, roster: s.head }),
    s.world.write(s.session, { kind: 'version.verdict', data: { product: PRODUCT, hash: HASH('c'), gate: 'guard', verdict: 'CLEARED', reasons: [] }, roster: s.head }),
    s.world.write(s.session, { kind: 'version.submit', data: { product: PRODUCT, hash: HASH('c'), decisionFor: 'j2-chief' }, roster: s.head }),
    s.world.write(s.session, { kind: 'doc.compact', data: { product: PRODUCT, covers: [], stateVector: [], textHash: HASH('f'), stateBlob: HASH('a') }, roster: s.head }),
    types(s, s.session, clientIdOf(2, 0), 'Enemy holds the ridge.').update
  ];
  const state = s.world.foldRoster();
  const ctx = s.world.ctxFor(state, s.world.ringFor(s.world.lead));
  for (const item of written) {
    const outcome = verifyEntry(item.entry, ctx);
    assert.equal(outcome.status, 'verified', item.hash);
    if (outcome.status !== 'verified') continue;
    assert.equal(outcome.entry.keep, undefined, item.hash);
    assert.equal(outcome.entry.member, PAT);
    assert.deepEqual(outcome.entry.session, { device: s.pat.writer, slot: 2 });
  }
});

test('after the lead revokes Pat\'s laptop, session entries citing the revocation roster are kept and do nothing, and earlier ones keep folding', () => {
  const s = shared();
  certify(s, s.pat, s.session);
  const before = types(s, s.session, clientIdOf(2, 0), 'Enemy holds the ridge.');
  const revoke = s.world.rosterEntry(s.world.lead, 'device.revoke', { member: PAT, writer: s.pat.writer }, s.head);
  const after = types(s, s.session, clientIdOf(2, 1), 'A second note.', { roster: revoke.hash, product: 'intel-annex' });
  const { state, result } = fold(s);
  assert.equal(state.positions[state.positions.length - 1], revoke.hash);
  assert.ok(result.applied.includes(before.update.hash), 'history before the revocation stays valid');
  assert.equal(productOf(result)?.text, 'Enemy holds the ridge.');
  for (const written of [after.client, after.update]) assert.equal(keptReason(result, written.hash), 'session-device-stopped');
  const view = rosterView(state);
  assert.notEqual(certifiedWriter(view, s.session.writer, s.head), undefined);
  assert.equal(certifiedWriter(view, s.session.writer, revoke.hash), undefined);
});

test('a quarantine of the certifying device stops its session key from that roster position on; after a release a new session key works and the old one stays stopped', () => {
  const s = shared();
  certify(s, s.pat, s.session);
  const quarantine = s.world.rosterEntry(s.world.lead, 'device.quarantine', { writer: s.pat.writer, stream: s.world.project, seq: 0 }, s.head);
  const during = types(s, s.session, clientIdOf(2, 0), 'Written while set aside.', { roster: quarantine.hash });
  // A certificate made while the device is quarantined is refused.
  const whileQuarantined = certify(s, s.pat, s.world.device('PAT-SESSION-DURING', PAT), { roster: quarantine.hash });
  const release = s.world.rosterEntry(s.world.lead, 'device.release', { writer: s.pat.writer, stream: s.world.project, seq: 0, branch: HASH('a') }, quarantine.hash);
  const fresh = s.world.device('PAT-SESSION-2', PAT);
  certify(s, s.pat, fresh, { roster: release.hash });
  const old = types(s, s.session, clientIdOf(2, 1), 'Old session after release.', { roster: release.hash, product: 'intel-annex' });
  const renewed = types(s, fresh, clientIdOf(2, 2), 'New session after release.', { roster: release.hash, product: 'intel-brief' });
  const { state, result } = fold(s);
  assert.equal(refusedReason(state, whileQuarantined.hash), 'session-device-stopped');
  for (const written of [during.client, during.update, old.client, old.update]) assert.equal(keptReason(result, written.hash), 'session-device-stopped', written.hash);
  assert.ok(result.applied.includes(renewed.update.hash));
  assert.equal(productOf(result, 'intel-brief')?.attribution[0]?.member, PAT);
});

test('two certificates for one session key: the first placed wins and the second, from another device or the same one, is refused session-key-reused', () => {
  const s = shared();
  // Quinn's certificate cites a later roster, so Pat's is placed first on every machine.
  const later = s.world.rosterEntry(s.world.lead, 'member.update', { member: QUINN, name: 'Quinn Planner Senior' }, s.head);
  const first = certify(s, s.pat, s.session);
  const fromQuinn = certify(s, s.quinn, s.session, { roster: later.hash });
  const again = certify(s, s.pat, s.session, { roster: later.hash, fields: { notAfter: '2026-11-19T22:00:00.000Z' } });
  const { update } = types(s, s.session, clientIdOf(2, 0), 'Enemy holds the ridge.', { roster: later.hash });
  const { state, result } = fold(s);
  assert.equal(state.sessions.get(s.session.writer)?.hash, first.hash);
  assert.equal(refusedReason(state, fromQuinn.hash), 'session-key-reused');
  assert.equal(refusedReason(state, again.hash), 'session-key-reused');
  assert.deepEqual(productOf(result)?.attribution.map((span) => span.member), [PAT]);
  assert.ok(result.applied.includes(update.hash));
});

test('a session writer\'s client ids come from the certificate\'s slot and never collide with the device\'s own; another slot is refused foreign-client-id', () => {
  const s = shared();
  certify(s, s.pat, s.session);
  const laptop = types(s, s.pat, clientIdOf(2, 0), 'From the laptop.');
  // The session allocates from the certificate's slot against the ids the folded document already holds.
  const used = new Set(productOf(fold(s).result)?.registrations.map((item) => item.clientId));
  const id = nextClientId(2, used);
  assert.equal(id, clientIdOf(2, 1));
  const session = types(s, s.session, id as number, 'From the session.');
  const foreign = types(s, s.session, clientIdOf(1, 0), 'In the lead\'s range.', { product: 'intel-annex' });
  const { result } = fold(s);
  for (const written of [laptop.client, laptop.update, session.client, session.update]) assert.ok(result.applied.includes(written.hash), written.hash);
  const product = productOf(result);
  assert.ok(product?.text.includes('From the laptop.') && product.text.includes('From the session.'));
  assert.deepEqual(product?.registrations.map((item) => [item.clientId, item.writer, item.member]).sort(), [[clientIdOf(2, 0), s.pat.writer, PAT], [clientIdOf(2, 1), s.session.writer, PAT]].sort());
  assert.equal(result.refused.find((item) => item.hash === foreign.client.hash)?.reason, 'foreign-client-id');
});

test('the fold reads no clock: the same entries fold the same with the clock before and after notAfter', (t) => {
  const s = shared();
  certify(s, s.pat, s.session);
  types(s, s.session, clientIdOf(2, 0), 'Enemy holds the ridge.');
  const summary = (): unknown => {
    const { state, result } = fold(s);
    return { sessions: [...state.sessions.values()], positions: state.positions, applied: result.applied, kept: result.kept, held: result.held, refused: result.refused, digests: result.digests };
  };
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-19T12:00:00.000Z') });
  const early = summary();
  t.mock.timers.setTime(Date.parse('2027-01-01T00:00:00.000Z'));
  const late = summary();
  t.mock.timers.reset();
  assert.deepEqual(late, early);
  assert.equal((early as { applied: string[] }).applied.length > 0, true);
});
