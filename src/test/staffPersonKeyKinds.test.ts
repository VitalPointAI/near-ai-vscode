// The one append path chooses who signs a person-key kind (33.1 D-09, plan 33.1-17 task 3). In a hosted project (a session key, or a person signer,
// is set) every PERSON_KEY_KINDS kind is signed by the person signer and by nothing else, and every person-key kind outside Phase 33's own list
// needs the id of the one action the person confirmed. Each refusal comes before anything is signed. A single-machine project signs with its device
// key as before. The tests read the live lists, so each kind a later plan adds is covered when it lands (33.1-01 adds the first posting kinds).
// Fictional exercise data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PERSON_KEY_KINDS, PHASE_33_PERSON_KEY_KINDS, isPersonKeyKind, requiresActionId, sessionCertifyData } from '../domain/replica/sessionKeys';
import type { AsyncPayloadSigner, PayloadSigner, SignOptions } from '../domain/team/signedPayload';
import { ReplicaProject } from '../staff/replica/replicaProject';
import { leadWith, project, streamEntries } from './helpers/labelCellWorld';
import type { Seat } from './helpers/labelCellWorld';
import { fixedSigner } from './helpers/replicaWorld';

const STEP_UP = 'Confirm with your passkey or security key to work on shared projects.';
const PERSON_KEY_REQUIRED = 'Only the person\'s own key can make this change.';

/** A signer that counts its calls and records the options each call came with; `refuse` makes it answer a refusal. */
interface Counted extends AsyncPayloadSigner { calls: number; seen: Array<SignOptions | undefined> }
function counted(signer: PayloadSigner, refuse?: string): Counted {
  const wrapped: Counted = {
    calls: 0,
    seen: [],
    fingerprint: signer.fingerprint,
    publicKey: signer.publicKey,
    sign: async (bytes: Buffer, options?: SignOptions): Promise<string | { refused: string }> => {
      wrapped.calls += 1;
      wrapped.seen.push(options);
      await new Promise((resolve) => setImmediate(resolve));
      return refuse === undefined ? signer.sign(bytes) : { refused: refuse };
    }
  };
  return wrapped;
}

/** A synchronous session signer that counts its calls. */
function countedSync(signer: PayloadSigner): PayloadSigner & { calls: number } {
  const wrapped = { calls: 0, fingerprint: signer.fingerprint, publicKey: signer.publicKey, sign: (bytes: Buffer): string => { wrapped.calls += 1; return signer.sign(bytes); } };
  return wrapped;
}

interface Hosted { lead: Seat; hosted: ReplicaProject; person: Counted; session: PayloadSigner & { calls: number }; base: string }

/** The lead certifies a session key from their own device, then a second project object over the same folder plays the hosted session. */
async function hostedSession(options: { person?: boolean; refuse?: string } = {}): Promise<Hosted> {
  const lead = await leadWith({ roles: ['member', 'section_lead:j4'] });
  const { roster } = await lead.p.state();
  const slot = roster.members.devices.get(lead.writer)?.find((record) => record.slot !== undefined)?.slot as number;
  const sessionKey = fixedSigner('HOSTED-SESSION-KINDS');
  const notAfter = new Date(lead.at.clock.now.getTime() + 12 * 60 * 60 * 1000).toISOString();
  const data = sessionCertifyData({ project: lead.p.projectId, member: lead.member, device: lead.writer, sessionKey: sessionKey.publicKey, slot, notAfter }, (bytes) => sessionKey.signer.sign(bytes));
  const certified = await lead.p.appendOwn('session.certify', data);
  assert.ok('ok' in certified, 'ok' in certified ? undefined : certified.message);
  const person = counted(lead.p.signer, options.refuse);
  const session = countedSync(sessionKey.signer);
  const deps = { ...lead.at.deps, sessionSigner: session, ...(options.person === false ? {} : { personSigner: person }) };
  const hosted = project(await ReplicaProject.open(lead.at.root, deps));
  return { lead, hosted, person, session, base: lead.p.projectId };
}

const baseEntries = (h: Hosted): number => streamEntries(h.lead.at, h.base).length;

test('PHASE_33_PERSON_KEY_KINDS is the Phase 33 list frozen by name; requiresActionId is true for every other person-key kind and for nothing else', () => {
  assert.ok(Object.isFrozen(PHASE_33_PERSON_KEY_KINDS));
  assert.equal(PHASE_33_PERSON_KEY_KINDS.length, new Set(PHASE_33_PERSON_KEY_KINDS).size);
  for (const kind of PHASE_33_PERSON_KEY_KINDS) {
    assert.equal(isPersonKeyKind(kind), true, `${kind} is still a person-key kind`);
    assert.equal(requiresActionId(kind), false, `${kind} keeps signing without an action id`);
  }
  for (const kind of ['project.genesis', 'member.update', 'roster.require', 'hub.readmit', 'session.certify', 'version.decide', 'version.release', 'version.supersede', 'version.withdraw']) {
    assert.ok(PHASE_33_PERSON_KEY_KINDS.includes(kind), kind);
  }
  // Every live person-key kind outside the frozen list needs an action: a kind a later plan adds is action-bound by default.
  for (const kind of PERSON_KEY_KINDS) assert.equal(requiresActionId(kind), !PHASE_33_PERSON_KEY_KINDS.includes(kind), kind);
  for (const kind of ['doc.client', 'doc.update', 'doc.compact', 'version.propose', 'version.verdict', 'version.submit', 'product.create', 'not.a.kind']) {
    assert.equal(requiresActionId(kind), false, kind);
  }
});

test('in a hosted session every person-key kind signed through the session key, or the device key, is refused person-key-required before anything is signed', async () => {
  const h = await hostedSession();
  const before = baseEntries(h);
  for (const kind of PERSON_KEY_KINDS) {
    for (const signer of [h.session, h.lead.p.signer]) {
      const written = await h.hosted.appendOwn(kind, {}, { signer, action: 'act-session' });
      assert.ok('refused' in written, `${kind} is refused`);
      assert.equal(written.refused, 'person-key-required', kind);
      assert.equal(written.message, PERSON_KEY_REQUIRED);
    }
  }
  assert.equal(h.session.calls, 0, 'the session key signed nothing');
  assert.equal(h.person.calls, 0, 'the person key was not asked');
  assert.equal(baseEntries(h), before, 'nothing was written');
});

test('a hosted session opened with no person signer refuses every person-key kind before anything is signed, and the roster does not move', async () => {
  const h = await hostedSession({ person: false });
  const { roster } = await h.hosted.state();
  const before = baseEntries(h);
  for (const kind of PERSON_KEY_KINDS) {
    const written = await h.hosted.appendOwn(kind, {});
    assert.ok('refused' in written, `${kind} is refused`);
    assert.equal(written.refused, 'person-key-required', kind);
  }
  assert.equal(h.session.calls, 0);
  assert.equal(baseEntries(h), before);
  assert.deepEqual((await h.hosted.state()).roster.positions, roster.positions);
});

test('a person-key kind outside Phase 33\'s list with no action id is refused while the person signer would sign; Phase 33\'s kinds sign without one; an action id reaches the signer', async () => {
  const h = await hostedSession();
  const before = baseEntries(h);
  // The person signer here signs every request (an open step-up window), so only the missing action id can refuse.
  for (const kind of PERSON_KEY_KINDS.filter(requiresActionId)) {
    const written = await h.hosted.appendOwn(kind, {});
    assert.ok('refused' in written, `${kind} is refused`);
    assert.equal(written.refused, 'action-required', kind);
  }
  assert.equal(h.person.calls, 0, 'no action-bound kind was signed without its action');
  assert.equal(baseEntries(h), before);
  // A Phase 33 kind keeps 33-23's behaviour: the person signer signs it with no action id.
  const renamed = await h.hosted.appendOwn('member.update', { member: h.lead.member, name: 'Watch Officer Lead' });
  assert.ok('ok' in renamed, 'ok' in renamed ? undefined : renamed.message);
  assert.equal(renamed.built.entry.header.writer, h.lead.writer, 'signed by the person key');
  assert.deepEqual(h.person.seen, [undefined]);
  // With an action id the person signer is told which action it signs for.
  const again = await h.hosted.appendOwn('member.update', { member: h.lead.member, name: 'Watch Officer Lead, night' }, { action: 'act-0001' });
  assert.ok('ok' in again, 'ok' in again ? undefined : again.message);
  assert.deepEqual(h.person.seen[1], { action: 'act-0001' });
  assert.equal(h.session.calls, 0);
  const { roster } = await h.hosted.state();
  assert.equal(roster.members.members.get(h.lead.member)?.at(-1)?.name, 'Watch Officer Lead, night');
});

test('a person signer that answers the step-up refusal: appendOwn returns it in its own words and appends nothing', async () => {
  const h = await hostedSession({ refuse: STEP_UP });
  const before = baseEntries(h);
  const written = await h.hosted.appendOwn('member.update', { member: h.lead.member, name: 'Not renamed' }, { action: 'act-0002' });
  assert.deepEqual(written, { refused: 'signer-refused', message: STEP_UP });
  assert.equal(h.person.calls, 1);
  assert.deepEqual(h.person.seen, [{ action: 'act-0002' }]);
  assert.equal(baseEntries(h), before);
});

test('a single-machine project signs every kind with its device key as before, with or without an action id', async () => {
  const lead = await leadWith({ roles: ['member', 'section_lead:j4'] });
  for (const kind of PERSON_KEY_KINDS) assert.equal(lead.p.signerOf(kind), lead.p.signer, kind);
  const renamed = await lead.p.appendOwn('member.update', { member: lead.member, name: 'Lead, single machine' });
  assert.ok('ok' in renamed, 'ok' in renamed ? undefined : renamed.message);
  const withAction = await lead.p.appendOwn('member.update', { member: lead.member, name: 'Lead, single machine, again' }, { action: 'act-0003' });
  assert.ok('ok' in withAction, 'ok' in withAction ? undefined : withAction.message);
  for (const written of [renamed, withAction]) assert.equal(written.built.entry.header.writer, lead.writer);
});
