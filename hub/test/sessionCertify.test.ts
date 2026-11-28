import assert from 'node:assert/strict';
import test from 'node:test';
import { KNOWN_REPLICA_FEATURES } from '@ext/domain/replica/features';
import { buildSessionAnswer } from '@ext/domain/replica/hubFile';
import type { SealedEntry } from '@ext/domain/replica/entry';
import { SESSION_REFUSALS as FOLD_REFUSALS, sessionCertifyData } from '@ext/domain/replica/sessionKeys';
import { APPEND_REFUSALS } from '../src/append/checks';
import { LIMITS } from '../src/limits';
import { AUTH_REFUSALS, SESSION_REFUSALS } from '../src/http/session';
import { withHub } from './helpers/hubHarness';
import type { Hub, OpenedSession } from './helpers/hubHarness';
import type { HubResponse } from './helpers/hubClient';
import { NOW_MS, createHubWorld } from './helpers/hubWorld';
import type { HubWorld, WorldDevice, Written } from './helpers/hubWorld';

// Phase 33, plan 22 (D-60, D-62): your organization's server takes a person's session key, certified by that person's own device, for sessions and
// appends while the certificate is before its notAfter by the hub's clock and the device still stands; it refuses an expired key, a person-key kind
// and a fifth live certificate of one device. All names and data are fictional.

const SLOT = 7;
const HOUR = 60 * 60 * 1000;
const NOT_AFTER = new Date(NOW_MS + 11 * HOUR).toISOString();

interface Setup { world: HubWorld; pat: WorldDevice; cell: string }

/** The project with Pat (slot 7) and a label cell Pat and the lead hold, enrolled on the hub. */
async function enrolled(hub: Hub): Promise<Setup> {
  const world = createHubWorld();
  world.admitHub(hub.identity);
  const pat = world.device('PAT-LAPTOP', 'mbr-pat');
  world.admitMember(pat, { slot: SLOT });
  const { cell } = world.labelCell('internal', [world.lead, pat]);
  await hub.enrolProject(world, { direct: true });
  return { world, pat, cell };
}

/** Pat's laptop certifies a session key; the session key signs its binding. at is the entry's signed time. */
function certify(s: Setup, session: WorldDevice, options: { notAfter?: string; at?: string; by?: WorldDevice; member?: string } = {}): Written {
  const by = options.by ?? s.pat;
  const data = sessionCertifyData({ project: s.world.project, member: options.member ?? by.member, device: by.writer, sessionKey: session.publicKey, slot: SLOT, notAfter: options.notAfter ?? NOT_AFTER }, (bytes) => session.signer.sign(bytes));
  return s.world.write(by, { kind: 'session.certify', data, at: options.at ?? new Date(NOW_MS - 30 * 60 * 1000).toISOString() });
}

const typed = (s: Setup, session: WorldDevice, text = 'Fictional text'): Written =>
  s.world.write(session, { kind: 'doc.update', stream: s.cell, data: { product: 'intel-estimate', update: Buffer.from(text).toString('base64url') } });

const appendPath = (world: HubWorld): string => `/v1/projects/${world.project}/append`;

async function append(world: HubWorld, by: OpenedSession, entries: readonly Written[]): Promise<{ status: number; accepted: string[]; refused: Array<{ hash?: string; reason: string; message: string }> }> {
  const answer = await by.connection.post(appendPath(world), { entries: entries.map((item) => item.entry) }, by.token);
  const body = answer.json<{ accepted?: string[]; refused?: Array<{ hash?: string; reason: string; message: string }> }>();
  return { status: answer.status, accepted: body.accepted ?? [], refused: body.refused ?? [] };
}

const reasonOf = (answer: { refused: Array<{ hash?: string; reason: string }> }, hash: string): string | undefined => answer.refused.find((item) => item.hash === hash)?.reason;

/** A session opened by a session key, naming and carrying its certificate. */
async function sessionKeySession(hub: Hub, world: HubWorld, session: WorldDevice, certificate: SealedEntry): Promise<{ response: HubResponse; opened?: OpenedSession }> {
  const connection = await hub.connect();
  const challenge = await connection.post('/v1/session', { project: world.project });
  assert.equal(challenge.status, 200, challenge.text);
  const body = challenge.json<{ hub: string; challenge: string }>();
  const answer = buildSessionAnswer(session.signer, { hub: body.hub, project: world.project, challenge: body.challenge, keying: connection.keying(), features: KNOWN_REPLICA_FEATURES, certificateEntry: certificate, now: new Date(hub.now()) });
  const response = await connection.post('/v1/session', { answer });
  if (response.status !== 200) return { response };
  const opened = response.json<{ project: string; token: string; expiresAt: string }>();
  return { response, opened: { connection, token: opened.token, project: opened.project, expiresAt: opened.expiresAt } };
}

function refusedWith(response: HubResponse, reason: keyof typeof SESSION_REFUSALS): void {
  assert.equal(response.status, 403, response.text);
  assert.deepEqual(response.json(), { error: 'session-refused', reason, message: SESSION_REFUSALS[reason] });
}

// ---- Task 1 ---------------------------------------------------------------------------------------------------------------------------------------

test('tracer: a session key\'s certificate and then its doc.update, in one batch, are both appended, and another member reads the session\'s entry', () =>
  withHub({}, async (hub) => {
    const s = await enrolled(hub);
    const session = s.world.device('PAT-SESSION', s.pat.member);
    const certificate = certify(s, session);
    const update = typed(s, session);
    const pat = await hub.openSession(s.pat, s.world.project);
    const answer = await append(s.world, pat, [certificate, update]);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.accepted, [certificate.hash, update.hash]);
    assert.deepEqual(answer.refused, []);
    assert.equal((await hub.cache.get(s.world.project)).sessionOf(session.writer)?.hash, certificate.hash);
    const lead = await hub.openSession(s.world.lead, s.world.project);
    const read = await lead.connection.get(`/v1/projects/${s.world.project}/entries?stream=${s.cell}&writer=${session.writer}&from=0`, lead.token);
    assert.equal(read.status, 200, read.text);
    assert.deepEqual(read.json<{ entries: Array<{ header: { writer: string } }> }>().entries.map((entry) => entry.header.writer), [session.writer]);
  }));

test('a session key\'s doc.update without a known certificate is refused not-admitted, as for any writer the hub does not know', () =>
  withHub({}, async (hub) => {
    const s = await enrolled(hub);
    const session = s.world.device('PAT-SESSION', s.pat.member);
    const update = typed(s, session);
    const pat = await hub.openSession(s.pat, s.world.project);
    const answer = await append(s.world, pat, [update]);
    assert.deepEqual(answer.accepted, []);
    assert.equal(reasonOf(answer, update.hash), 'not-admitted');
  }));

test('with the hub clock past notAfter, the session key\'s next entry is refused session-expired with its sentence', () =>
  withHub({}, async (hub) => {
    const s = await enrolled(hub);
    const session = s.world.device('PAT-SESSION', s.pat.member);
    const certificate = certify(s, session);
    const pat = await hub.openSession(s.pat, s.world.project);
    assert.deepEqual((await append(s.world, pat, [certificate, typed(s, session)])).refused, []);
    hub.advance(12 * HOUR);
    const late = typed(s, session, 'Too late');
    const again = await hub.openSession(s.pat, s.world.project);
    const answer = await append(s.world, again, [late]);
    assert.equal(reasonOf(answer, late.hash), 'session-expired');
    assert.equal(answer.refused[0]?.message, 'Your session key has ended. Sign in again.');
    assert.equal(APPEND_REFUSALS['session-expired'], 'Your session key has ended. Sign in again.');
  }));

// ---- Task 2 ---------------------------------------------------------------------------------------------------------------------------------------

test('a session key opens a session by naming and carrying its certificate, before its first push stores it; its token ends at notAfter', () =>
  withHub({}, async (hub) => {
    const s = await enrolled(hub);
    const session = s.world.device('PAT-SESSION', s.pat.member);
    const soon = new Date(NOW_MS + 10 * 60 * 1000).toISOString();
    const certificate = certify(s, session, { notAfter: soon });
    const { response, opened } = await sessionKeySession(hub, s.world, session, certificate.entry);
    assert.equal(response.status, 200, response.text);
    assert.ok(opened !== undefined);
    assert.equal(opened.expiresAt, soon, 'the token never outlives the certificate');
    assert.equal((await hub.cache.get(s.world.project)).sessionOf(session.writer), undefined, 'the session call stores nothing');
    // The first push carries the certificate before the session key's own entry.
    const update = typed(s, session);
    const answer = await append(s.world, opened, [certificate, update]);
    assert.deepEqual(answer.accepted, [certificate.hash, update.hash]);
    assert.equal((await opened.connection.get(`/v1/projects/${s.world.project}/heads`, opened.token)).status, 200);
    // At notAfter the token is gone, and a new session for the key is refused session-expired.
    hub.advance(10 * 60 * 1000);
    const expired = await opened.connection.get(`/v1/projects/${s.world.project}/heads`, opened.token);
    assert.equal(expired.status, 401);
    assert.deepEqual(expired.json(), { error: 'unauthenticated', reason: 'token-expired', message: AUTH_REFUSALS['token-expired'] });
    refusedWith((await sessionKeySession(hub, s.world, session, certificate.entry)).response, 'session-expired');
  }));

test('a session key with an expired, unknown or another member\'s certificate gets no session', () =>
  withHub({}, async (hub) => {
    const s = await enrolled(hub);
    const expiredKey = s.world.device('PAT-SESSION-OLD', s.pat.member);
    const expired = certify(s, expiredKey, { notAfter: new Date(NOW_MS - 60 * 1000).toISOString(), at: new Date(NOW_MS - 2 * HOUR).toISOString() });
    refusedWith((await sessionKeySession(hub, s.world, expiredKey, expired.entry)).response, 'session-expired');
    // A certificate the fold refuses (Pat's laptop naming the lead's member) vouches for nothing.
    const borrowed = s.world.device('PAT-SESSION-BORROWED', s.pat.member);
    const wrongMember = certify(s, borrowed, { member: s.world.lead.member });
    refusedWith((await sessionKeySession(hub, s.world, borrowed, wrongMember.entry)).response, 'not-admitted');
    // A session key answering without its certificate is a writer the hub does not know.
    const plain = await hub.connect();
    const challenge = (await plain.post('/v1/session', { project: s.world.project })).json<{ hub: string; challenge: string }>();
    const answer = buildSessionAnswer(borrowed.signer, { hub: challenge.hub, project: s.world.project, challenge: challenge.challenge, keying: plain.keying(), features: KNOWN_REPLICA_FEATURES, now: new Date(hub.now()) });
    refusedWith(await plain.post('/v1/session', { answer }), 'not-admitted');
    // Another key's certificate does not open a session for this key.
    const other = s.world.device('PAT-SESSION-OTHER', s.pat.member);
    const theirs = certify(s, other);
    refusedWith((await sessionKeySession(hub, s.world, borrowed, theirs.entry)).response, 'not-admitted');
  }));

test('a session key appending a roster kind or a decision the hub can read is refused person-key-required; the batch\'s other entries are judged on their own', () =>
  withHub({}, async (hub) => {
    const s = await enrolled(hub);
    const session = s.world.device('PAT-SESSION', s.pat.member);
    const second = s.world.device('PAT-SESSION-2', s.pat.member);
    const certificates = [certify(s, session), certify(s, second)];
    const pat = await hub.openSession(s.pat, s.world.project);
    assert.deepEqual((await append(s.world, pat, certificates)).refused, []);
    const { opened } = await sessionKeySession(hub, s.world, session, certificates[0].entry);
    assert.ok(opened !== undefined);
    const update = typed(s, session);
    const rosterChange = s.world.write(session, { kind: 'member.update', data: { member: s.pat.member, name: 'Pat Senior', rosterPrev: s.world.head } });
    const decision = s.world.write(second, { kind: 'version.decide', data: { product: 'intel-estimate', hash: 'c'.repeat(64), outcome: 'approve', reasons: [], decisionsSeen: [] } });
    const answer = await append(s.world, opened, [update, rosterChange, decision]);
    assert.deepEqual(answer.accepted, [update.hash]);
    assert.equal(reasonOf(answer, rosterChange.hash), 'person-key-required');
    assert.equal(reasonOf(answer, decision.hash), 'person-key-required');
    assert.equal(APPEND_REFUSALS['person-key-required'], FOLD_REFUSALS['person-key-required']);
  }));

test('after the roster revokes Pat\'s laptop, the session key\'s token, a new session and its appends are refused revoked', () =>
  withHub({}, async (hub) => {
    const s = await enrolled(hub);
    const session = s.world.device('PAT-SESSION', s.pat.member);
    const certificate = certify(s, session);
    const pat = await hub.openSession(s.pat, s.world.project);
    assert.deepEqual((await append(s.world, pat, [certificate])).refused, []);
    const { opened } = await sessionKeySession(hub, s.world, session, certificate.entry);
    assert.ok(opened !== undefined);
    const lead = await hub.openSession(s.world.lead, s.world.project);
    const revoke = s.world.rosterEntry(s.world.lead, 'device.revoke', { member: s.pat.member, writer: s.pat.writer });
    assert.deepEqual((await append(s.world, lead, [revoke])).accepted, [revoke.hash]);
    const after = await opened.connection.get(`/v1/projects/${s.world.project}/heads`, opened.token);
    assert.equal(after.status, 401);
    assert.equal(after.json<{ reason: string }>().reason, 'revoked');
    refusedWith((await sessionKeySession(hub, s.world, session, certificate.entry)).response, 'revoked');
    const update = typed(s, session);
    assert.equal(reasonOf(await append(s.world, lead, [update]), update.hash), 'revoked');
  }));

test('a fifth live certificate of one device is refused too-many-sessions; certificates past notAfter do not count', () =>
  withHub({}, async (hub) => {
    const s = await enrolled(hub);
    assert.equal(LIMITS.liveSessionKeysPerDevice, 4);
    const pat = await hub.openSession(s.pat, s.world.project);
    const inAnHour = new Date(NOW_MS + HOUR).toISOString();
    const four = [1, 2, 3, 4].map((index) => certify(s, s.world.device(`PAT-SESSION-${index}`, s.pat.member), { notAfter: inAnHour }));
    assert.deepEqual((await append(s.world, pat, four)).accepted, four.map((item) => item.hash));
    const fifth = certify(s, s.world.device('PAT-SESSION-5', s.pat.member), { notAfter: new Date(NOW_MS + 4 * HOUR).toISOString() });
    const refused = await append(s.world, pat, [fifth]);
    assert.equal(reasonOf(refused, fifth.hash), 'too-many-sessions');
    // Two hours on, the four have ended: the same fifth certificate is taken.
    hub.advance(2 * HOUR);
    const later = await hub.openSession(s.pat, s.world.project);
    assert.deepEqual((await append(s.world, later, [fifth])).accepted, [fifth.hash]);
    assert.equal((await hub.cache.get(s.world.project)).liveSessionsOf(s.pat.writer, hub.now()), 1);
  }));

// ---- 33-27: the join desk for a lead in a hosted session --------------------------------------------------------------------------------------

test('a session key the lead\'s device certified registers an invitation and reads join requests; a member\'s session key is refused forbidden', () =>
  withHub({}, async (hub) => {
    const s = await enrolled(hub);
    const leadSession = s.world.device('LEAD-SESSION', s.world.lead.member);
    const leadData = sessionCertifyData({ project: s.world.project, member: s.world.lead.member, device: s.world.lead.writer, sessionKey: leadSession.publicKey, slot: 1, notAfter: NOT_AFTER }, (bytes) => leadSession.signer.sign(bytes));
    const leadCertificate = s.world.write(s.world.lead, { kind: 'session.certify', data: leadData, at: new Date(NOW_MS - 30 * 60 * 1000).toISOString() });
    const lead = (await sessionKeySession(hub, s.world, leadSession, leadCertificate.entry)).opened;
    assert.ok(lead !== undefined);
    assert.deepEqual((await append(s.world, lead, [leadCertificate])).accepted, [leadCertificate.hash], 'the certificate is stored');
    const invitesPath = `/v1/projects/${s.world.project}/invites`;
    const registration = { invite: 'inv-0011223344aa', expiresAt: new Date(hub.now() + 24 * HOUR).toISOString(), checkKey: Buffer.alloc(32, 3).toString('base64url') };
    const registered = await lead.connection.post(invitesPath, registration, lead.token);
    assert.equal(registered.status, 201, registered.text);
    const listed = await lead.connection.get(`/v1/projects/${s.world.project}/join-requests`, lead.token);
    assert.equal(listed.status, 200, listed.text);

    const patSession = s.world.device('PAT-SESSION', s.pat.member);
    const patCertificate = certify(s, patSession);
    const pat = (await sessionKeySession(hub, s.world, patSession, patCertificate.entry)).opened;
    assert.ok(pat !== undefined);
    assert.deepEqual((await append(s.world, pat, [patCertificate])).accepted, [patCertificate.hash]);
    const refused = await pat.connection.post(invitesPath, { ...registration, invite: 'inv-0011223344bb' }, pat.token);
    assert.equal(refused.status, 403, refused.text);
    assert.equal((await pat.connection.get(`/v1/projects/${s.world.project}/join-requests`, pat.token)).status, 403);
  }));
