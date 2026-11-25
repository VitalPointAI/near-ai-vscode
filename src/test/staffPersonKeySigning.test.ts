// Person-key signing through an asynchronous signer (Phase 33 plan 21 task 3; D-60). Your organization's key store signs over the network, so a person
// key entry is signed through signPayloadAsync and buildEntryAsync, with the same bytes the synchronous path gives for the same key. A project opened for
// a hosted session writes ordinary work with its session key and asks the person signer once for each decision; a refusal from the person signer reaches
// the person in its own words and nothing is written. Fictional exercise data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalDoc, docText, localInsert, snapshotOf } from '../domain/replica/doc';
import { GENESIS_PREV, buildEntryAsync, entryHash, openBody, signHeader, signHeaderAsync, verifyHeader } from '../domain/replica/entry';
import type { Actor, SealedEntry, UnsignedHeader } from '../domain/replica/entry';
import { nextClientId } from '../domain/replica/clientIds';
import { sessionCertifyData } from '../domain/replica/sessionKeys';
import { replicaVersionHash } from '../domain/replica/versions';
import type { ProductVersions } from '../domain/replica/versions';
import { signPayload, signPayloadAsync } from '../domain/team/signedPayload';
import type { AsyncPayloadSigner, PayloadSigner } from '../domain/team/signedPayload';
import { appendProductEntry, proposeVersion } from '../staff/replica/labelCells';
import { updateMember } from '../staff/replica/membership';
import { ReplicaProject } from '../staff/replica/replicaProject';
import { VersionActs } from '../staff/replica/versionActs';
import { hostOf, leadWith, ok, project, streamEntries } from './helpers/labelCellWorld';
import type { Seat } from './helpers/labelCellWorld';
import { epochKey, fixedSigner } from './helpers/replicaWorld';

const PRODUCT = 'logistics-estimate';
const LABEL = 'org/Internal';
const ROLES = { owner: 'j4-planner', sectionLead: 'j4-lead', releaseGuard: 'j4-guard' };
const PERSON: Actor = { kind: 'person' };
const OWNER: Actor = { kind: 'agent', member: ROLES.owner, run: 'owner-run' };
const GUARD: Actor = { kind: 'agent', member: ROLES.releaseGuard, run: 'guard-run' };
const STEP_UP = 'Confirm with your passkey or security key to work on shared projects.';

/** An asynchronous signer over the same key, counting its calls; `refuse` makes it answer a refusal instead. */
function asyncOf(signer: PayloadSigner, refuse?: string): AsyncPayloadSigner & { calls: number } {
  const wrapped = {
    calls: 0,
    fingerprint: signer.fingerprint,
    publicKey: signer.publicKey,
    sign: async (bytes: Buffer): Promise<string | { refused: string }> => {
      wrapped.calls += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return refuse === undefined ? signer.sign(bytes) : { refused: refuse };
    }
  };
  return wrapped;
}

test('signPayloadAsync over the same key gives the bytes signPayload gives, and a refusal signs nothing', async () => {
  const { signer } = fixedSigner('PERSON-KEY');
  const payload = { product: PRODUCT, outcome: 'approve', count: 3 };
  const now = (): Date => new Date('2026-11-20T10:00:00.000Z');
  const sync = signPayload(signer, 'staff-decision', payload, { now });
  const later = await signPayloadAsync(asyncOf(signer), 'staff-decision', payload, { now });
  assert.deepEqual(later, sync);
  // A plain synchronous signer works through the same call.
  assert.deepEqual(await signPayloadAsync(signer, 'staff-decision', payload, { now }), sync);
  assert.deepEqual(await signPayloadAsync(asyncOf(signer, STEP_UP), 'staff-decision', payload, { now }), { refused: STEP_UP });
  // The same checks run before anything is asked of the signer.
  const unasked = asyncOf(signer);
  await assert.rejects(signPayloadAsync(unasked, 'not-a-purpose' as never, payload, { now }), /known purpose/);
  assert.equal(unasked.calls, 0);
});

test('signHeaderAsync gives the header signHeader gives; buildEntryAsync builds an entry that verifies and opens, or passes a refusal back', async () => {
  const { signer, writer } = fixedSigner('PERSON-KEY');
  const key = epochKey('person-key/base');
  const stream = 'a'.repeat(32);
  const unsigned: UnsignedHeader = { v: 2, stream, writer, seq: 0, prev: GENESIS_PREV, epoch: 1, body: { hash: 'b'.repeat(64), size: 64 } };
  assert.deepEqual(await signHeaderAsync(asyncOf(signer), unsigned), signHeader(signer, unsigned));
  const body = { deps: [], roster: GENESIS_PREV, lamport: 1, at: '2026-11-20T10:00:00.000Z', actor: PERSON, kind: 'version.decide', data: { product: PRODUCT, hash: 'c'.repeat(64), outcome: 'approve', reasons: [], decisionsSeen: [] } };
  const built = await buildEntryAsync({ signer: asyncOf(signer), key, stream, seq: 0, prev: GENESIS_PREV, epoch: 1, body });
  assert.ok('entry' in built);
  assert.equal(built.entry.header.writer, writer);
  assert.equal(built.hash, entryHash(built.entry.header));
  assert.equal(verifyHeader(built.entry.header, signer.publicKey), true);
  const opened = openBody(key, built.entry.header, Buffer.from(built.entry.body, 'base64url'));
  assert.equal(JSON.parse(opened?.toString('utf8') ?? '{}').kind, 'version.decide');
  // The same unsigned header signed through either path is the same header (the sealed body differs only by its random IV).
  const { sig: _sig, ...unsignedBuilt } = built.entry.header;
  assert.deepEqual(signHeader(signer, unsignedBuilt), built.entry.header);
  assert.deepEqual(await buildEntryAsync({ signer: asyncOf(signer, STEP_UP), key, stream, seq: 0, prev: GENESIS_PREV, epoch: 1, body }), { refused: STEP_UP });
});

interface Hosted { lead: Seat; hosted: ReplicaProject; person: AsyncPayloadSigner & { calls: number }; session: PayloadSigner; sessionWriter: string; stream: string; slot: number }

/**
 * The lead's own device certifies a session key, then a second project object over the same folder plays the hosted session: the session key signs
 * ordinary writes and the person signer (an asynchronous signer over the lead device's key) signs the person-key kinds.
 */
async function hostedSession(refuse?: string): Promise<Hosted> {
  const lead = await leadWith({ roles: ['member', 'section_lead:j4', 'decision_for:commander'] });
  ok(await updateMember(lead.host, { member: lead.member, agentSeats: [ROLES.releaseGuard] }), 'authorise guard');
  const created = await appendProductEntry(lead.host, 'product.create', { product: PRODUCT, section: 'j4', roles: ROLES, title: 'Logistics estimate' }, { label: LABEL });
  assert.ok(created.ok, created.ok ? undefined : created.message);
  const { roster } = await lead.p.state();
  const slot = roster.members.devices.get(lead.writer)?.find((record) => record.slot !== undefined)?.slot as number;
  // The single-machine project signs every kind with its device key, as before.
  assert.equal(lead.p.signerOf('version.decide'), lead.p.signer);
  assert.equal(lead.p.signerOf('doc.update'), lead.p.signer);
  const sessionKey = fixedSigner('HOSTED-SESSION');
  const notAfter = new Date(lead.at.clock.now.getTime() + 12 * 60 * 60 * 1000).toISOString();
  const data = sessionCertifyData({ project: lead.p.projectId, member: lead.member, device: lead.writer, sessionKey: sessionKey.publicKey, slot, notAfter }, (bytes) => sessionKey.signer.sign(bytes));
  const certified = await lead.p.appendOwn('session.certify', data);
  assert.ok('ok' in certified, 'ok' in certified ? undefined : certified.message);
  const person = asyncOf(lead.p.signer, refuse);
  const hosted = project(await ReplicaProject.open(lead.at.root, { ...lead.at.deps, sessionSigner: sessionKey.signer, personSigner: person }));
  assert.equal((await hosted.state()).roster.sessions.get(sessionKey.writer)?.member, lead.member);
  return { lead, hosted, person, session: sessionKey.signer, sessionWriter: sessionKey.writer, stream: created.stream, slot };
}

const writerOf = (entries: readonly SealedEntry[], hash: string): string | undefined => entries.find((entry) => entryHash(entry.header) === hash)?.header.writer;

async function versionsOf(p: ReplicaProject, stream: string): Promise<ProductVersions> {
  const { fold } = await p.state();
  const product = (fold.families.versions as ProductVersions[]).find((item) => item.product === PRODUCT && item.stream === stream);
  assert.ok(product);
  return product;
}

test('a hosted session: typing and proposals are signed by the session key; decide, release, supersede and withdraw ask the person signer once each, and everything folds', async () => {
  const h = await hostedSession();
  const host = hostOf(h.hosted, h.lead.at);
  const acts = (actor: Actor): VersionActs => new VersionActs(h.hosted, actor);
  // Typing under a client id from the certificate's slot.
  const clientId = nextClientId(h.slot, new Set()) as number;
  const doc = createLocalDoc(clientId);
  const client = await appendProductEntry(host, 'doc.client', { product: PRODUCT, clientId, actor: PERSON });
  assert.ok(client.ok, client.ok ? undefined : client.message);
  const type = async (more: string): Promise<string> => {
    const typed = await appendProductEntry(host, 'doc.update', { product: PRODUCT, update: Buffer.from(localInsert(doc, docText(doc).length, more)).toString('base64url') });
    assert.ok(typed.ok, typed.ok ? undefined : typed.message);
    return typed.hash;
  };
  const typed = { hash: await type('Fuel for three days.') };
  const propose = async (text: string): Promise<string> => {
    if (docText(doc) !== text) await type(text.slice(docText(doc).length));
    const proposed = await proposeVersion(host, { product: PRODUCT, text, header: { kind: 'estimate', label: LABEL, profile: 'j4', level: 'official' }, pins: [], snapshot: snapshotOf(doc) });
    assert.ok(proposed.ok, proposed.ok ? undefined : proposed.message);
    return proposed.version;
  };
  const toDecision = async (version: string): Promise<void> => {
    const cleared = await acts(GUARD).verdict({ product: PRODUCT, hash: version, gate: 'guard', verdict: 'CLEARED', reasons: [] });
    assert.ok(cleared.ok, cleared.ok ? undefined : cleared.message);
    const submitted = await acts(OWNER).submit({ product: PRODUCT, hash: version, decisionFor: 'commander' });
    assert.ok(submitted.ok, submitted.ok ? undefined : submitted.message);
  };
  const personCalls = async <T>(run: () => Promise<T>): Promise<{ result: T; calls: number }> => {
    const before = h.person.calls;
    const result = await run();
    return { result, calls: h.person.calls - before };
  };

  const first = await propose('Fuel for three days.');
  await toDecision(first);
  assert.equal(h.person.calls, 0, 'nothing ordinary asks the person signer');
  const decided = await personCalls(() => acts(PERSON).decide({ product: PRODUCT, hash: first, outcome: 'approve', reasons: ['Ready.'] }));
  const released = await personCalls(() => acts(PERSON).release({ product: PRODUCT, hash: first }));
  const second = await propose('Fuel for three days. Water for four.');
  await toDecision(second);
  await acts(PERSON).decide({ product: PRODUCT, hash: second, outcome: 'approve', reasons: ['Ready.'] });
  await acts(PERSON).release({ product: PRODUCT, hash: second });
  const superseded = await personCalls(() => acts(PERSON).supersede({ product: PRODUCT, hash: first, byHash: second }));
  const third = await propose('Fuel for three days. Water for four. Spares.');
  const withdrawn = await personCalls(() => acts(PERSON).withdraw({ product: PRODUCT, hash: third, reason: 'Exercise plan changed.' }));
  for (const step of [decided, released, superseded, withdrawn]) {
    assert.ok(step.result.ok, step.result.ok ? undefined : step.result.message);
    assert.equal(step.calls, 1);
  }
  assert.equal(h.person.calls, 6, 'two decisions, two releases, one supersession and one withdrawal');

  const entries = streamEntries(h.lead.at, h.stream);
  for (const hash of [client.hash, typed.hash]) assert.equal(writerOf(entries, hash), h.sessionWriter);
  for (const step of [decided, released, superseded, withdrawn]) assert.equal(writerOf(entries, (step.result as { hash: string }).hash), h.lead.writer);
  const product = await versionsOf(h.hosted, h.stream);
  assert.deepEqual(product.versions.map((version) => version.state), ['superseded', 'released', 'withdrawn']);
  assert.equal(product.versions[0]?.hash, replicaVersionHash('Fuel for three days.', []));
  assert.deepEqual(product.refusals, []);
  const { fold } = await h.hosted.state();
  assert.deepEqual(fold.refused, []);
  assert.equal(fold.kept.filter((item) => item.reason === 'person-key-required').length, 0);
  // The single-machine view of the same folder reads the same record.
  assert.deepEqual((await versionsOf(h.lead.p, h.stream)).versions, product.versions);
});

test('a person signer that refuses: the decision returns the refusal in its own words and nothing is written', async () => {
  const h = await hostedSession(STEP_UP);
  const host = hostOf(h.hosted, h.lead.at);
  const clientId = nextClientId(h.slot, new Set()) as number;
  const doc = createLocalDoc(clientId);
  assert.ok((await appendProductEntry(host, 'doc.client', { product: PRODUCT, clientId, actor: PERSON })).ok);
  assert.ok((await appendProductEntry(host, 'doc.update', { product: PRODUCT, update: Buffer.from(localInsert(doc, 0, 'Fuel for three days.')).toString('base64url') })).ok);
  const proposed = await proposeVersion(host, { product: PRODUCT, text: docText(doc), header: { kind: 'estimate', label: LABEL, profile: 'j4', level: 'official' }, pins: [], snapshot: snapshotOf(doc) });
  assert.ok(proposed.ok, proposed.ok ? undefined : proposed.message);
  assert.ok((await new VersionActs(h.hosted, GUARD).verdict({ product: PRODUCT, hash: proposed.version, gate: 'guard', verdict: 'CLEARED', reasons: [] })).ok);
  assert.ok((await new VersionActs(h.hosted, OWNER).submit({ product: PRODUCT, hash: proposed.version, decisionFor: 'commander' })).ok);
  const before = streamEntries(h.lead.at, h.stream);
  const decided = await new VersionActs(h.hosted, PERSON).decide({ product: PRODUCT, hash: proposed.version, outcome: 'approve', reasons: ['Ready.'] });
  assert.deepEqual(decided, { ok: false, reason: 'signer-refused', message: STEP_UP });
  assert.equal(h.person.calls, 1);
  assert.deepEqual(streamEntries(h.lead.at, h.stream), before);
  assert.equal((await versionsOf(h.hosted, h.stream)).versions[0]?.state, 'awaiting-decision');
});

// 33.1-17 task 3 (D-09) moved this refusal into the one append path: the session key is no longer asked to sign a person-key kind at all. The fold's
// own refusal of a session-key roster entry stays covered in replicaSessionCertify.test.ts and in the hub's sessionCertify.test.ts.
test('a hosted session with no person signer refuses a person-key kind person-key-required before the session key signs it: the roster does not move', async () => {
  const lead = await leadWith({ roles: ['member', 'section_lead:j4', 'decision_for:commander'] });
  const sessionKey = fixedSigner('HOSTED-SESSION-ONLY');
  const { roster } = await lead.p.state();
  const slot = roster.members.devices.get(lead.writer)?.find((record) => record.slot !== undefined)?.slot as number;
  const notAfter = new Date(lead.at.clock.now.getTime() + 12 * 60 * 60 * 1000).toISOString();
  const certified = await lead.p.appendOwn('session.certify', sessionCertifyData({ project: lead.p.projectId, member: lead.member, device: lead.writer, sessionKey: sessionKey.publicKey, slot, notAfter }, (bytes) => sessionKey.signer.sign(bytes)));
  assert.ok('ok' in certified, 'ok' in certified ? undefined : certified.message);
  const hosted = project(await ReplicaProject.open(lead.at.root, { ...lead.at.deps, sessionSigner: sessionKey.signer }));
  assert.equal(hosted.signerOf('version.decide'), sessionKey.signer);
  // A roster change is refused before the session key signs it, and changes nothing.
  const before = (await hosted.state()).roster.positions.length;
  const stored = streamEntries(lead.at, lead.p.projectId).length;
  const update = await hosted.appendOwn('member.update', { member: lead.member, name: 'Lead Renamed' });
  assert.ok('refused' in update);
  assert.deepEqual(update, { refused: 'person-key-required', message: 'Only the person\'s own key can make this change.' });
  const after = await hosted.state();
  assert.equal(after.roster.positions.length, before);
  assert.equal(streamEntries(lead.at, lead.p.projectId).length, stored, 'nothing was written');
  assert.ok(!streamEntries(lead.at, lead.p.projectId).some((entry) => entry.header.writer === sessionKey.writer), 'the session key signed nothing');
});
