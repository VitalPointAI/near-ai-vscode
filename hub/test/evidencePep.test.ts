import assert from 'node:assert/strict';
import test from 'node:test';
import { GENESIS_PREV, sealBlob } from '@ext/domain/replica/entry';
import { KNOWN_REPLICA_FEATURES } from '@ext/domain/replica/features';
import { buildSessionAnswer } from '@ext/domain/replica/hubFile';
import { sessionCertifyData } from '@ext/domain/replica/sessionKeys';
import { didKeyFromDevice } from '@ext/domain/did/didKey';
import { hostPathOf } from '../src/store/trustStore';
import { REVOCATIONS, SUSPENSIONS, bindingWithPlaces, issue, list, withComputers } from '@ext/test/helpers/credentialWorld';
import type { Issued, SignedList } from '@ext/test/helpers/credentialWorld';
import type { HubConnection, HubResponse } from './helpers/hubClient';
import { withHub } from './helpers/hubHarness';
import type { Hub, OpenedSession } from './helpers/hubHarness';
import { createHubWorld } from './helpers/hubWorld';
import type { HubWorld, WorldDevice, Written } from './helpers/hubWorld';
import { REVOCATION_ROUTE, SUSPENSION_ROUTE, TRUST_NOW, makeTrustWorld } from './helpers/trustWorld';
import type { TrustWorld } from './helpers/trustWorld';

// Phase 71, plan 09, task 2 (D-11, D-16, DCAC-04): the hub is an enforcement point. An entry that cites evidence is checked with the fold's own
// checkEvidence and then checkFreshness against the hub's newest lists; one citing a list replaced longer ago than the grace is refused
// 'stale-evidence'. Once the hub's newest list sets a bit of a credential a member's entries cited, that member's sessions are refused
// 'access-under-review'; a suspension lifted by a newer list lets them in again. All names, DIDs and keys are fictional and made at run time.

const ENTRY_AT = '2026-11-24T11:00:00.000Z';
const SAM_SLOT = 7;

interface Site {
  hub: Hub;
  world: HubWorld;
  trust: TrustWorld;
  lead: OpenedSession;
  sam: WorldDevice;
  samSession: OpenedSession;
  binding: Issued;
  role: Issued;
  clearance: Issued;
  lists: { revocations: SignedList; suspensions: SignedList };
  /** The next place in Sam's base-stream log: it moves only when the hub accepts an entry, so a refused entry's place is used again. */
  chain: { seq: number; prev: string };
}

const putJson = (connection: HubConnection, target: string, value: unknown, token: string): Promise<HubResponse> =>
  connection.call('PUT', target, { bytes: Buffer.from(JSON.stringify(value), 'utf8'), token });

async function putList(site: Pick<Site, 'lead'>, route: string, signed: SignedList): Promise<void> {
  const answer = await putJson(site.lead.connection, route, signed.credential, site.lead.token);
  assert.ok(answer.status === 201 || answer.status === 200, answer.text);
}

async function makeSite(hub: Hub, trust: TrustWorld, hosted = true): Promise<Site> {
  const world = createHubWorld();
  world.admitHub(hub.identity);
  const sam = world.device('MEMBER-SAM', 'mbr-sam');
  world.admitMember(sam, { slot: SAM_SLOT });
  const enrolled = await hub.enrolProject(world);
  assert.equal(enrolled?.status, 201, enrolled?.text ?? 'no answer');
  const lead = await hub.openSession(world.lead, world.project);
  const w = trust.world;
  // Sam lists two computers in their DID document (D-25): their own device, and the lead's device for the member-key test.
  w.member = await withComputers(w.member, [
    { slot: 1, device: didKeyFromDevice(sam.publicKey), revocation: 100_001, suspension: 100_002 },
    { slot: 2, device: didKeyFromDevice(world.lead.publicKey), revocation: 100_003, suspension: 100_004 },
  ]);
  // The hub hosts the DID logs of the root, the officer and Sam.
  for (const person of hosted ? [w.root, w.officer, w.member] : []) {
    const answer = await lead.connection.call('POST', `/v1/trust/did/${hostPathOf(person.did) as string}/did.jsonl`, { bytes: Buffer.from(person.log), token: lead.token });
    assert.equal(answer.status, 201, answer.text);
  }
  const role = await issue(w.root.signer, w.root.did, 'IssuerRoleCredential', { id: w.officer.did, credentialType: 'ClearanceCredential', scale: 'ca-classified', upTo: 'Secret' });
  const clearance = await issue(w.officer.signer, w.officer.did, 'ClearanceCredential', { id: w.member.did, scale: 'ca-classified', atLeast: 'Secret' });
  const binding = await bindingWithPlaces(w.member, didKeyFromDevice(sam.publicKey), 100_001, 100_002, `dev-${'a1'.repeat(16)}`);
  const lists = {
    revocations: await list(w.revocationKey, REVOCATIONS, 'revocation', [], { version: 1, validFrom: '2026-11-24T10:00:00Z' }),
    suspensions: await list(w.suspensionKey, SUSPENSIONS, 'suspension', [], { version: 1, validFrom: '2026-11-24T10:00:00Z' }),
  };
  if (hosted) {
    await putList({ lead }, REVOCATION_ROUTE, lists.revocations);
    await putList({ lead }, SUSPENSION_ROUTE, lists.suspensions);
  }
  return { hub, world, trust, lead, sam, samSession: await hub.openSession(sam, world.project), binding, role, clearance, lists, chain: { seq: 0, prev: GENESIS_PREV } };
}

const withSite = (body: (site: Site) => Promise<void>, options: { organization?: boolean } = {}) => async (): Promise<void> => {
  const trust = await makeTrustWorld();
  await withHub({ now: TRUST_NOW, ...(options.organization === false ? {} : { organization: trust.organization }) }, async (hub) => body(await makeSite(hub, trust, options.organization !== false)));
};

const statusOf = (lists: { revocations: SignedList; suspensions: SignedList }) => [
  { list: REVOCATIONS, hash: lists.revocations.hash, validFrom: lists.revocations.validFrom },
  { list: SUSPENSIONS, hash: lists.suspensions.hash, validFrom: lists.suspensions.validFrom },
];

interface Appended {
  written: Written;
  answer: HubResponse;
  refused: Array<{ reason: string; evidence?: string }>;
}

/**
 * Sam's device writes one base-stream entry whose data cites the given credentials and lists, uploads each credential as a blob sealed with the
 * base cell key, and appends the entry naming those blobs.
 */
async function cite(site: Site, data: Record<string, unknown>, credentials: readonly Issued[], options: { kind?: string; session?: OpenedSession } = {}): Promise<Appended> {
  const session = options.session ?? site.samSession;
  const key = site.world.keyOf(site.world.project, 1);
  const blobs = credentials.map((item) => sealBlob(key, site.world.project, 1, Buffer.from(JSON.stringify(item.credential), 'utf8')));
  for (const blob of blobs) {
    const put = await session.connection.put(`/v1/blobs/${blob.hash}`, Buffer.from(blob.bytes, 'base64url'), session.token);
    assert.ok(put.status === 201 || put.status === 200, put.text);
  }
  const written = site.world.write(site.sam, { kind: options.kind ?? 'posting.accept', data, at: ENTRY_AT, seq: site.chain.seq, prev: site.chain.prev });
  const answer = await session.connection.post(
    `/v1/projects/${site.world.project}/append`,
    { entries: [written.entry], blobRefs: blobs.map((blob) => ({ entry: written.hash, blob: blob.hash })) },
    session.token,
  );
  assert.equal(answer.status, 200, answer.text);
  const refused = answer.json<{ refused: Array<{ reason: string; evidence?: string }> }>().refused;
  if (refused.length === 0) site.chain = { seq: site.chain.seq + 1, prev: written.hash };
  return { written, answer, refused };
}

const evidenceOf = (site: Site, lists = site.lists): Record<string, unknown> => ({
  position: 'j2-analyst',
  evidence: [site.clearance.hash, site.binding.hash, site.role.hash],
  status: statusOf(lists),
});

test('tracer: an entry citing Sam\'s clearance, binding and the newest lists is accepted, and its status entries are kept for Sam', withSite(async (site) => {
  const done = await cite(site, evidenceOf(site), [site.clearance, site.binding, site.role]);
  assert.deepEqual(done.refused, []);
  assert.deepEqual(done.answer.json<{ accepted: string[] }>().accepted, [done.written.hash]);
  const cited = site.hub.trust.citedOf(site.world.project, site.sam.member);
  assert.deepEqual(
    cited.map((item) => `${item.purpose}:${item.index}`).sort(),
    [`revocation:${site.clearance.revocationIndex}`, `suspension:${site.clearance.suspensionIndex}`].sort(),
    'the member\'s own credential about them, not the officer\'s role or the device binding',
  );
}));

test('an entry citing a list older than the newest by more than the grace is refused stale-evidence', withSite(async (site) => {
  const newer = await list(site.trust.world.revocationKey, REVOCATIONS, 'revocation', [], { version: 2, validFrom: '2026-11-24T10:30:00Z' });
  await putList(site, REVOCATION_ROUTE, newer);
  const done = await cite(site, evidenceOf(site), [site.clearance, site.binding, site.role]);
  assert.equal(done.refused.length, 1);
  assert.equal(done.refused[0]?.reason, 'stale-evidence');
  const fresh = await cite(site, evidenceOf(site, { revocations: newer, suspensions: site.lists.suspensions }), [site.clearance, site.binding, site.role]);
  assert.deepEqual(fresh.refused, [], 'citing the newest list is accepted');
}));

test('a citation within the grace of the newest list is still accepted', withSite(async (site) => {
  const newer = await list(site.trust.world.revocationKey, REVOCATIONS, 'revocation', [], { version: 2, validFrom: '2026-11-24T10:10:00Z' });
  await putList(site, REVOCATION_ROUTE, newer);
  assert.deepEqual((await cite(site, evidenceOf(site), [site.clearance, site.binding, site.role])).refused, []);
}));

test('a cited credential that fails checkEvidence is refused with the checker\'s own reason', withSite(async (site) => {
  const missing = await cite(site, evidenceOf(site), [site.binding, site.role]);
  assert.equal(missing.refused[0]?.reason, 'evidence-refused');
  assert.equal(missing.refused[0]?.evidence, 'credential-missing');

  const revoked = await list(site.trust.world.revocationKey, REVOCATIONS, 'revocation', [site.clearance.revocationIndex], { version: 2, validFrom: '2026-11-24T10:05:00Z' });
  await putList(site, REVOCATION_ROUTE, revoked);
  const after = await cite(site, evidenceOf(site, { revocations: revoked, suspensions: site.lists.suspensions }), [site.clearance, site.binding, site.role]);
  assert.equal(after.refused[0]?.evidence, 'revoked');
}));

test('an entry whose cited binding is not for the writing device is refused member-key', withSite(async (site) => {
  const other = await bindingWithPlaces(site.trust.world.member, didKeyFromDevice(site.world.lead.publicKey), 100_003, 100_004, `dev-${'b2'.repeat(16)}`);
  const data = { evidence: [site.clearance.hash, other.hash, site.role.hash], status: statusOf(site.lists) };
  const done = await cite(site, data, [site.clearance, other, site.role]);
  assert.equal(done.refused[0]?.reason, 'evidence-refused');
  assert.equal(done.refused[0]?.evidence, 'member-key');
}));

test('evidence not in the cited shape is refused evidence-malformed; an entry with no evidence field is checked as today', withSite(async (site) => {
  const bad = await cite(site, { evidence: 'not-a-list', status: [] }, []);
  assert.equal(bad.refused[0]?.reason, 'evidence-malformed');
  const plain = await cite(site, { text: 'Fictional note' }, [], { kind: 'note.add' });
  assert.deepEqual(plain.refused, []);
}));

test('without your organization\'s rules the hub does not judge evidence and stores the entry as today', withSite(async (site) => {
  const done = await cite(site, { evidence: [site.clearance.hash], status: [] }, []);
  assert.deepEqual(done.refused, []);
}, { organization: false }));

test('once a newer list revokes Sam\'s cited clearance, Sam\'s sessions are refused access-under-review; the lead is not affected', withSite(async (site) => {
  assert.deepEqual((await cite(site, evidenceOf(site), [site.clearance, site.binding, site.role])).refused, []);
  const heads = `/v1/projects/${site.world.project}/heads`;
  assert.equal((await site.samSession.connection.get(heads, site.samSession.token)).status, 200);

  const revoked = await list(site.trust.world.revocationKey, REVOCATIONS, 'revocation', [site.clearance.revocationIndex], { version: 2, validFrom: '2026-11-24T10:05:00Z' });
  await putList(site, REVOCATION_ROUTE, revoked);
  const refused = await site.samSession.connection.get(heads, site.samSession.token);
  assert.equal(refused.status, 403);
  assert.equal(refused.json<{ reason: string }>().reason, 'access-under-review');
  assert.ok(!refused.text.includes('did:'), 'the refusal names no DID');

  // A new session is refused too, and the refusal stays through later roster changes and later lists (a revocation never clears).
  await assert.rejects(site.hub.openSession(site.sam, site.world.project), /access-under-review|403/);
  const roster = site.world.rosterEntry(site.world.lead, 'member.update', { member: site.sam.member, seat: 'j2-lead-analyst' });
  assert.equal((await site.lead.connection.post(`/v1/projects/${site.world.project}/append`, { entries: [roster.entry] }, site.lead.token)).status, 200);
  const later = await list(site.trust.world.revocationKey, REVOCATIONS, 'revocation', [site.clearance.revocationIndex, 99], { version: 3, validFrom: '2026-11-24T10:20:00Z' });
  await putList(site, REVOCATION_ROUTE, later);
  assert.equal((await site.samSession.connection.get(heads, site.samSession.token)).status, 403);

  assert.equal((await site.lead.connection.get(heads, site.lead.token)).status, 200, 'other members are unaffected');
}));

test('a suspension of Sam\'s cited clearance refuses Sam until a newer list lifts it', withSite(async (site) => {
  assert.deepEqual((await cite(site, evidenceOf(site), [site.clearance, site.binding, site.role])).refused, []);
  const heads = `/v1/projects/${site.world.project}/heads`;
  const suspended = await list(site.trust.world.suspensionKey, SUSPENSIONS, 'suspension', [site.clearance.suspensionIndex], { version: 2, validFrom: '2026-11-24T10:05:00Z' });
  await putList(site, SUSPENSION_ROUTE, suspended);
  assert.equal((await site.samSession.connection.get(heads, site.samSession.token)).status, 403);
  const lifted = await list(site.trust.world.suspensionKey, SUSPENSIONS, 'suspension', [], { version: 3, validFrom: '2026-11-24T10:10:00Z' });
  await putList(site, SUSPENSION_ROUTE, lifted);
  assert.equal((await site.samSession.connection.get(heads, site.samSession.token)).status, 200);
}));

test('a bit set for the officer\'s role credential, not one of Sam\'s own, leaves Sam\'s sessions alone, and any entry kind\'s citations are kept', withSite(async (site) => {
  assert.deepEqual((await cite(site, evidenceOf(site), [site.clearance, site.binding, site.role], { kind: 'marking.approve' })).refused, []);
  assert.ok(site.hub.trust.citedOf(site.world.project, site.sam.member).length > 0, 'a kind the hub has never heard of is covered');
  const other = await list(site.trust.world.revocationKey, REVOCATIONS, 'revocation', [site.role.revocationIndex], { version: 2, validFrom: '2026-11-24T10:05:00Z' });
  await putList(site, REVOCATION_ROUTE, other);
  assert.equal((await site.samSession.connection.get(`/v1/projects/${site.world.project}/heads`, site.samSession.token)).status, 200);
}));

test('G467: an entry citing a computer binding Sam\'s DID document does not list is refused binding-not-in-slots', withSite(async (site) => {
  const unlisted = await bindingWithPlaces(site.trust.world.member, didKeyFromDevice(site.sam.publicKey), 100_011, 100_012, `dev-${'c3'.repeat(16)}`);
  const data = { evidence: [site.clearance.hash, unlisted.hash, site.role.hash], status: statusOf(site.lists) };
  const done = await cite(site, data, [site.clearance, unlisted, site.role]);
  assert.equal(done.refused[0]?.evidence, 'binding-not-in-slots');
  const low = await bindingWithPlaces(site.trust.world.member, didKeyFromDevice(site.sam.publicKey), 4_001, 4_002, `dev-${'d4'.repeat(16)}`);
  const lowDone = await cite(site, { evidence: [site.clearance.hash, low.hash, site.role.hash], status: statusOf(site.lists) }, [site.clearance, low, site.role]);
  assert.equal(lowDone.refused[0]?.evidence, 'binding-outside-computer-range');
}));

test('G467: the hub refuses a DID log whose computer uses another person\'s place, or that lists more than five computers', withSite(async (site) => {
  const w = site.trust.world;
  const post = (log: string, did: string) => site.lead.connection.call('POST', `/v1/trust/did/${hostPathOf(did) as string}/did.jsonl`, { bytes: Buffer.from(log), token: site.lead.token });
  // Kim's computer claims Sam's place 100,001.
  const kim = await withComputers(w.other, [{ slot: 1, device: didKeyFromDevice(site.world.lead.publicKey), revocation: 100_001, suspension: 100_090 }]);
  const taken = await post(kim.log, kim.did);
  assert.equal(taken.status, 422);
  assert.match(taken.text, /computer-place-taken/);
  const fine = await withComputers(w.other, [{ slot: 1, device: didKeyFromDevice(site.world.lead.publicKey), revocation: 100_091, suspension: 100_090 }]);
  assert.equal((await post(fine.log, fine.did)).status, 201);
  const keys = [1, 2, 3, 4, 5, 6].map((slot) => ({ slot, device: didKeyFromDevice(site.world.lead.publicKey), revocation: 110_000 + slot * 2, suspension: 110_001 + slot * 2 }));
  const many = await withComputers(fine, keys, '2026-02-02T00:00:00Z');
  const refused = await post(many.log, many.did);
  assert.equal(refused.status, 422);
  assert.match(refused.text, /computer-slots/);
}));

// Integration of Phase 33 session keys (D-62) with 71-09: a session key stands for the person's device, so it cites through that device's
// binding, and once a newer list puts that person under review the session key's token and any new session it asks for are refused too.
test('a session key cites through its certifying device, and is refused access-under-review with that person once a newer list revokes', withSite(async (site) => {
  const key = site.world.device('SAM-SESSION', site.sam.member);
  const notAfter = new Date(TRUST_NOW + 10 * 60 * 60 * 1000).toISOString();
  const data = sessionCertifyData({ project: site.world.project, member: site.sam.member, device: site.sam.writer, sessionKey: key.publicKey, slot: SAM_SLOT, notAfter }, (bytes) => key.signer.sign(bytes));
  const certificate = site.world.write(site.sam, { kind: 'session.certify', data, at: ENTRY_AT, seq: site.chain.seq, prev: site.chain.prev });
  const pushed = await site.samSession.connection.post(`/v1/projects/${site.world.project}/append`, { entries: [certificate.entry] }, site.samSession.token);
  assert.deepEqual(pushed.json<{ refused: unknown[] }>().refused, [], pushed.text);
  site.chain = { seq: site.chain.seq + 1, prev: certificate.hash };

  const openKeySession = async (): Promise<{ response: HubResponse; opened?: OpenedSession }> => {
    const connection = await site.hub.connect();
    const challenge = await connection.post('/v1/session', { project: site.world.project });
    assert.equal(challenge.status, 200, challenge.text);
    const body = challenge.json<{ hub: string; challenge: string }>();
    const answer = buildSessionAnswer(key.signer, { hub: body.hub, project: site.world.project, challenge: body.challenge, keying: connection.keying(), features: KNOWN_REPLICA_FEATURES, certificateEntry: certificate.entry, now: new Date(site.hub.now()) });
    const response = await connection.post('/v1/session', { answer });
    if (response.status !== 200) return { response };
    const opened = response.json<{ project: string; token: string; expiresAt: string }>();
    return { response, opened: { connection, token: opened.token, project: opened.project, expiresAt: opened.expiresAt } };
  };
  const first = await openKeySession();
  assert.equal(first.response.status, 200, first.response.text);
  const keySession = first.opened as OpenedSession;

  // The session key's own base-stream entry cites Sam's binding, which names Sam's device, not the session key.
  const sealKey = site.world.keyOf(site.world.project, 1);
  const credentials = [site.clearance, site.binding, site.role];
  const blobs = credentials.map((item) => sealBlob(sealKey, site.world.project, 1, Buffer.from(JSON.stringify(item.credential), 'utf8')));
  for (const blob of blobs) assert.ok([200, 201].includes((await keySession.connection.put(`/v1/blobs/${blob.hash}`, Buffer.from(blob.bytes, 'base64url'), keySession.token)).status));
  const written = site.world.write(key, { kind: 'posting.accept', data: evidenceOf(site), at: ENTRY_AT, seq: 0, prev: GENESIS_PREV });
  const cited = await keySession.connection.post(`/v1/projects/${site.world.project}/append`, { entries: [written.entry], blobRefs: blobs.map((blob) => ({ entry: written.hash, blob: blob.hash })) }, keySession.token);
  assert.deepEqual(cited.json<{ refused: unknown[] }>().refused, [], cited.text);
  assert.ok(site.hub.trust.citedOf(site.world.project, site.sam.member).length > 0, 'the citation is kept for Sam');

  const heads = `/v1/projects/${site.world.project}/heads`;
  assert.equal((await keySession.connection.get(heads, keySession.token)).status, 200);
  const revoked = await list(site.trust.world.revocationKey, REVOCATIONS, 'revocation', [site.clearance.revocationIndex], { version: 2, validFrom: '2026-11-24T10:05:00Z' });
  await putList(site, REVOCATION_ROUTE, revoked);
  const refused = await keySession.connection.get(heads, keySession.token);
  assert.equal(refused.status, 403, refused.text);
  assert.equal(refused.json<{ reason: string }>().reason, 'access-under-review');
  const again = await openKeySession();
  assert.equal(again.response.status, 403, again.response.text);
  assert.equal(again.response.json<{ reason: string }>().reason, 'access-under-review');
  assert.equal((await site.lead.connection.get(heads, site.lead.token)).status, 200, 'other members are unaffected');
}));
