import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { KNOWN_REPLICA_FEATURES } from '@ext/domain/replica/features';
import { SESSION_VERSION, buildSessionAnswer, certPinOf, readSessionAnswer } from '@ext/domain/replica/hubFile';
import { signPayload } from '@ext/domain/team/signedPayload';
import type { PayloadSigner } from '@ext/domain/team/signedPayload';
import { AUTH_REFUSALS, SESSION_REFUSALS, TOKENS_PER_DEVICE } from '../src/http/session';
import type { HubConnection, HubResponse } from './helpers/hubClient';
import { issueHubFile } from '../src/enrol';
import { withHub } from './helpers/hubHarness';
import { slowUpload } from './helpers/slowUpload';
import type { Hub } from './helpers/hubHarness';
import { createHubWorld, streamOf } from './helpers/hubWorld';
import type { HubWorld, WorldDevice } from './helpers/hubWorld';

// Phase 32, plan 20 (D-35, D-39, D-58): every session state, allowed and forbidden. A session answer works only on the TLS connection it was made
// on, for this hub, this project and this socket's one open challenge, and only for a person's device the roster admits at its head; a token works
// only on its own connection, for 15 minutes, for its project, and only while its device stays admitted and not quarantined. All data is fictional.

interface Setup {
  world: HubWorld;
  analyst: WorldDevice;
}

/** The world's project with one member besides the lead, enrolled on the hub directly. prepare runs before enrolment. */
async function enrolled(hub: Hub, prepare?: (world: HubWorld, analyst: WorldDevice) => void): Promise<Setup> {
  const world = createHubWorld();
  world.admitHub(hub.identity);
  const analyst = world.device('ANALYST', 'mbr-analyst');
  world.admitMember(analyst);
  prepare?.(world, analyst);
  await hub.enrolProject(world, { direct: true });
  return { world, analyst };
}

async function challengeOn(connection: HubConnection, project: string): Promise<{ hub: string; challenge: string }> {
  const answer = await connection.post('/v1/session', { project });
  assert.equal(answer.status, 200, answer.text);
  return answer.json<{ hub: string; challenge: string }>();
}

function signAnswer(hub: Hub, signer: PayloadSigner, fields: { hub: string; project: string; challenge: string; keying: Buffer }): unknown {
  return buildSessionAnswer(signer, { ...fields, now: new Date(hub.now()) });
}

/** The answer is refused 403 session-refused with exactly this reason and the reason's own sentence. */
function refusedWith(response: HubResponse, reason: keyof typeof SESSION_REFUSALS): void {
  assert.equal(response.status, 403, response.text);
  assert.deepEqual(response.json(), { error: 'session-refused', reason, message: SESSION_REFUSALS[reason] });
}

function unauthorised(response: HubResponse, reason: keyof typeof AUTH_REFUSALS): void {
  assert.equal(response.status, reason === 'wrong-project' ? 403 : 401, response.text);
  assert.deepEqual(response.json(), { error: reason === 'wrong-project' ? 'forbidden' : 'unauthenticated', reason, message: AUTH_REFUSALS[reason] });
}

const headsOf = (project: string): string => `/v1/projects/${project}/heads`;

// ---- Opening a session ----

test('a challenge is 32 fresh bytes for this project, named with the hub writer id, never stored or cached', () =>
  withHub({}, async (hub) => {
    const { world } = await enrolled(hub);
    const connection = await hub.connect();
    const first = await connection.post('/v1/session', { project: world.project });
    assert.equal(first.status, 200);
    assert.equal(first.headers['cache-control'], 'no-store');
    const body = first.json<{ project: string; hub: string; challenge: string }>();
    assert.deepEqual(Object.keys(body).sort(), ['challenge', 'hub', 'project']);
    assert.equal(body.project, world.project);
    assert.equal(body.hub, hub.identity.writer);
    assert.equal(Buffer.from(body.challenge, 'base64url').length, 32);
    const second = (await challengeOn(connection, world.project)).challenge;
    assert.notEqual(second, body.challenge);
  }));

test('unknown-project: a challenge for a project the hub does not hold is refused', () =>
  withHub({}, async (hub) => {
    await enrolled(hub);
    const connection = await hub.connect();
    refusedWith(await connection.post('/v1/session', { project: streamOf('nowhere') }), 'unknown-project');
    refusedWith(await connection.post('/v1/session', { project: 'not-a-project' }), 'unknown-project');
  }));

test('not-admitted: a device the roster does not have gets no session', () =>
  withHub({}, async (hub) => {
    const { world } = await enrolled(hub);
    const stranger = world.device('STRANGER', 'mbr-stranger');
    const connection = await hub.connect();
    const { challenge } = await challengeOn(connection, world.project);
    refusedWith(await connection.post('/v1/session', { answer: signAnswer(hub, stranger.signer, { hub: hub.identity.writer, project: world.project, challenge, keying: connection.keying() }) }), 'not-admitted');
  }));

test('not-a-person-device: the hub-kind device admitted with hub.admit gets no session', () =>
  withHub({}, async (hub) => {
    const { world } = await enrolled(hub);
    const connection = await hub.connect();
    const { challenge } = await challengeOn(connection, world.project);
    refusedWith(await connection.post('/v1/session', { answer: signAnswer(hub, hub.identity.signer, { hub: hub.identity.writer, project: world.project, challenge, keying: connection.keying() }) }), 'not-a-person-device');
  }));

test('quarantined: a device the roster quarantined gets no session', () =>
  withHub({}, async (hub) => {
    const { world, analyst } = await enrolled(hub, (w, a) => {
      w.rosterEntry(w.lead, 'device.quarantine', { writer: a.writer, stream: w.project, seq: 0 });
    });
    const connection = await hub.connect();
    const { challenge } = await challengeOn(connection, world.project);
    refusedWith(await connection.post('/v1/session', { answer: signAnswer(hub, analyst.signer, { hub: hub.identity.writer, project: world.project, challenge, keying: connection.keying() }) }), 'quarantined');
  }));

test('wrong-hub: an answer naming another hub is refused', () =>
  withHub({}, async (hub) => {
    const { world } = await enrolled(hub);
    const connection = await hub.connect();
    const { challenge } = await challengeOn(connection, world.project);
    refusedWith(await connection.post('/v1/session', { answer: signAnswer(hub, world.lead.signer, { hub: 'e'.repeat(64), project: world.project, challenge, keying: connection.keying() }) }), 'wrong-hub');
  }));

test('wrong-project: an answer naming another project than its challenge is refused', () =>
  withHub({}, async (hub) => {
    const { world } = await enrolled(hub);
    const connection = await hub.connect();
    const { challenge } = await challengeOn(connection, world.project);
    refusedWith(await connection.post('/v1/session', { answer: signAnswer(hub, world.lead.signer, { hub: hub.identity.writer, project: streamOf('elsewhere'), challenge, keying: connection.keying() }) }), 'wrong-project');
  }));

test('wrong-challenge: an older challenge of the same socket is refused once a newer one was given', () =>
  withHub({}, async (hub) => {
    const { world } = await enrolled(hub);
    const connection = await hub.connect();
    const old = await challengeOn(connection, world.project);
    await challengeOn(connection, world.project);
    refusedWith(await connection.post('/v1/session', { answer: signAnswer(hub, world.lead.signer, { hub: hub.identity.writer, project: world.project, challenge: old.challenge, keying: connection.keying() }) }), 'wrong-challenge');
  }));

test('wrong-challenge: another socket\'s challenge is refused on this socket', () =>
  withHub({}, async (hub) => {
    const { world } = await enrolled(hub);
    const mine = await hub.connect();
    const other = await hub.connect();
    const theirs = await challengeOn(other, world.project);
    await challengeOn(mine, world.project);
    refusedWith(await mine.post('/v1/session', { answer: signAnswer(hub, world.lead.signer, { hub: hub.identity.writer, project: world.project, challenge: theirs.challenge, keying: mine.keying() }) }), 'wrong-challenge');
    // A socket with no open challenge refuses any answer the same way.
    const fresh = await hub.connect();
    refusedWith(await fresh.post('/v1/session', { answer: signAnswer(hub, world.lead.signer, { hub: hub.identity.writer, project: world.project, challenge: theirs.challenge, keying: fresh.keying() }) }), 'wrong-challenge');
  }));

test('wrong-challenge: an answer that already opened a session cannot be used again', () =>
  withHub({}, async (hub) => {
    const { world } = await enrolled(hub);
    const connection = await hub.connect();
    const { challenge } = await challengeOn(connection, world.project);
    const answer = signAnswer(hub, world.lead.signer, { hub: hub.identity.writer, project: world.project, challenge, keying: connection.keying() });
    assert.equal((await connection.post('/v1/session', { answer })).status, 200);
    refusedWith(await connection.post('/v1/session', { answer }), 'wrong-challenge');
  }));

test('wrong-connection: an answer signed over another connection\'s keying material is refused', () =>
  withHub({}, async (hub) => {
    const { world } = await enrolled(hub);
    const connection = await hub.connect();
    const other = await hub.connect();
    assert.equal(connection.keying().equals(other.keying()), false, 'two connections must export different keying material');
    const { challenge } = await challengeOn(connection, world.project);
    refusedWith(await connection.post('/v1/session', { answer: signAnswer(hub, world.lead.signer, { hub: hub.identity.writer, project: world.project, challenge, keying: other.keying() }) }), 'wrong-connection');
  }));

test('bad-signature: an answer whose content was changed after signing is refused', () =>
  withHub({}, async (hub) => {
    const { world } = await enrolled(hub);
    const connection = await hub.connect();
    const { challenge } = await challengeOn(connection, world.project);
    const signed = signAnswer(hub, world.lead.signer, { hub: hub.identity.writer, project: world.project, challenge, keying: connection.keying() }) as { sig: string };
    const flipped = Buffer.from(signed.sig, 'base64url');
    flipped[0] = (flipped[0] as number) ^ 1;
    refusedWith(await connection.post('/v1/session', { answer: { ...signed, sig: flipped.toString('base64url') } }), 'bad-signature');
  }));

// ---- The features a device announces (POST-01, D-07, 33-18): the hub compiles the extension's one feature registry and reads them from the answer. ----

test('features: an answer announcing the registry the hub compiles opens a session, and the hub\'s own reader gives the features back', () =>
  withHub({}, async (hub) => {
    const { world } = await enrolled(hub);
    assert.equal(SESSION_VERSION, 2);
    assert.deepEqual([...KNOWN_REPLICA_FEATURES], ['cells@1', 'hub@1', 'positions@1', 'replica@2', 'require@1', 'verified-clearance@1']);
    const connection = await hub.connect();
    const { challenge } = await challengeOn(connection, world.project);
    const answer = buildSessionAnswer(world.lead.signer, { hub: hub.identity.writer, project: world.project, challenge, keying: connection.keying(), features: KNOWN_REPLICA_FEATURES, now: new Date(hub.now()) });
    const read = readSessionAnswer(answer, { hub: hub.identity.writer, project: world.project, challenge, keying: connection.keying() });
    assert.deepEqual(read.ok ? read.features : read.reason, [...KNOWN_REPLICA_FEATURES]);
    const opened = await connection.post('/v1/session', { answer });
    assert.equal(opened.status, 200, opened.text);
  }));

test('features: a version 1 answer, or an answer whose features are unsorted or not name@N, is 400 malformed at the hub', () =>
  withHub({}, async (hub) => {
    const { world } = await enrolled(hub);
    const connection = await hub.connect();
    const fields = (challenge: string): Record<string, unknown> => ({ ...(signAnswer(hub, world.lead.signer, { hub: hub.identity.writer, project: world.project, challenge, keying: connection.keying() }) as { payload: Record<string, unknown> }).payload });
    const versionOne = (payload: Record<string, unknown>): Record<string, unknown> => {
      const copy: Record<string, unknown> = { ...payload, v: 1 };
      delete copy.features;
      return copy;
    };
    for (const change of [versionOne, (p: Record<string, unknown>) => ({ ...p, features: ['require@1', 'replica@2'] }), (p: Record<string, unknown>) => ({ ...p, features: ['Require@1'] })]) {
      const { challenge } = await challengeOn(connection, world.project);
      const answer = signPayload(world.lead.signer, 'staff-hub-session', change(fields(challenge)), { now: () => new Date(hub.now()) });
      const response = await connection.post('/v1/session', { answer });
      assert.equal(response.status, 400, response.text);
      assert.equal(response.json().error, 'malformed');
    }
  }));

test('challenge-expired: an answer 61 seconds after its challenge is refused, and one at 59 seconds opens a session', () =>
  withHub({}, async (hub) => {
    const { world } = await enrolled(hub);
    const connection = await hub.connect();
    const late = await challengeOn(connection, world.project);
    hub.advance(61_000);
    refusedWith(await connection.post('/v1/session', { answer: signAnswer(hub, world.lead.signer, { hub: hub.identity.writer, project: world.project, challenge: late.challenge, keying: connection.keying() }) }), 'challenge-expired');
    const inTime = await challengeOn(connection, world.project);
    hub.advance(59_000);
    const opened = await connection.post('/v1/session', { answer: signAnswer(hub, world.lead.signer, { hub: hub.identity.writer, project: world.project, challenge: inTime.challenge, keying: connection.keying() }) });
    assert.equal(opened.status, 200, opened.text);
  }));

test('a session call that is neither {project} nor {answer}, or an answer that is not a signed payload, is 400 malformed', () =>
  withHub({}, async (hub) => {
    const { world } = await enrolled(hub);
    const connection = await hub.connect();
    for (const body of [{}, { project: world.project, extra: 1 }, [world.project], 'text']) {
      const response = await connection.post('/v1/session', body);
      assert.equal(response.status, 400);
      assert.equal(response.json().error, 'malformed');
    }
    await challengeOn(connection, world.project);
    const response = await connection.post('/v1/session', { answer: { payload: 'nothing' } });
    assert.equal(response.status, 400);
  }));

// ---- Using a token ----

test('a token works on its own connection: heads answers 200 and the session names its project and expiry', () =>
  withHub({}, async (hub) => {
    const { world } = await enrolled(hub);
    const session = await hub.openSession(world.lead, world.project);
    assert.equal(session.project, world.project);
    assert.equal(Date.parse(session.expiresAt), hub.now() + 15 * 60_000);
    const heads = await session.connection.get(headsOf(world.project), session.token);
    assert.equal(heads.status, 200, heads.text);
    assert.equal(heads.json().project, world.project);
  }));

test('other-connection: a token copied to a second connection is refused there and still works on its own', () =>
  withHub({}, async (hub) => {
    const { world } = await enrolled(hub);
    const session = await hub.openSession(world.lead, world.project);
    const thief = await hub.connect();
    unauthorised(await thief.get(headsOf(world.project), session.token), 'other-connection');
    assert.equal((await session.connection.get(headsOf(world.project), session.token)).status, 200);
  }));

test('token-expired: a token works at 14 minutes 59 seconds and is refused at 15 minutes', () =>
  withHub({}, async (hub) => {
    const { world } = await enrolled(hub);
    const session = await hub.openSession(world.lead, world.project);
    hub.advance(15 * 60_000 - 1000);
    assert.equal((await session.connection.get(headsOf(world.project), session.token)).status, 200);
    hub.advance(1000);
    unauthorised(await session.connection.get(headsOf(world.project), session.token), 'token-expired');
    // Gone for good: the next call does not know it at all.
    unauthorised(await session.connection.get(headsOf(world.project), session.token), 'unknown-token');
  }));

test('wrong-project: a token for one enrolled project is refused 403 on another enrolled project', () =>
  withHub({}, async (hub) => {
    const { world } = await enrolled(hub);
    const other = createHubWorld({ projectLabel: 'harbour' });
    other.admitHub(hub.identity);
    await hub.enrolProject(other, { direct: true });
    const session = await hub.openSession(world.lead, world.project);
    unauthorised(await session.connection.get(headsOf(other.project), session.token), 'wrong-project');
  }));

test('revoked: after the roster records device.revoke, the device\'s token is refused and a new session is not-admitted', () =>
  withHub({}, async (hub) => {
    const { world, analyst } = await enrolled(hub);
    const member = await hub.openSession(analyst, world.project);
    assert.equal((await member.connection.get(headsOf(world.project), member.token)).status, 200);
    const lead = await hub.openSession(world.lead, world.project);
    const revoke = world.rosterEntry(world.lead, 'device.revoke', { member: analyst.member, writer: analyst.writer });
    const appended = await lead.connection.post(`/v1/projects/${world.project}/append`, { entries: [revoke.entry] }, lead.token);
    assert.deepEqual(appended.json().accepted, [revoke.hash]);
    unauthorised(await member.connection.get(headsOf(world.project), member.token), 'revoked');
    const connection = await hub.connect();
    const { challenge } = await challengeOn(connection, world.project);
    refusedWith(await connection.post('/v1/session', { answer: signAnswer(hub, analyst.signer, { hub: hub.identity.writer, project: world.project, challenge, keying: connection.keying() }) }), 'not-admitted');
  }));

test('quarantined: after the device signs two entries at one place, its token is refused', () =>
  withHub({}, async (hub) => {
    const { world, analyst } = await enrolled(hub);
    const member = await hub.openSession(analyst, world.project);
    const first = world.write(analyst, { kind: 'note.add', data: { text: 'First fictional note' } });
    const second = world.write(analyst, { kind: 'note.add', data: { text: 'Second fictional note' }, seq: first.seq });
    const path = `/v1/projects/${world.project}/append`;
    assert.deepEqual((await member.connection.post(path, { entries: [first.entry] }, member.token)).json().accepted, [first.hash]);
    const forked = await member.connection.post(path, { entries: [second.entry] }, member.token);
    assert.equal(forked.status, 200);
    assert.deepEqual(forked.json<{ refused: Array<{ reason: string }> }>().refused.map((item) => item.reason), ['equivocation']);
    assert.equal(hub.equivocations.length, 1, 'the equivocation hook ran after COMMIT');
    unauthorised(await member.connection.get(headsOf(world.project), member.token), 'quarantined');
  }));

test('unknown-token and no-token: a made-up token and a call without one are refused', () =>
  withHub({}, async (hub) => {
    const { world } = await enrolled(hub);
    const session = await hub.openSession(world.lead, world.project);
    unauthorised(await session.connection.get(headsOf(world.project), Buffer.alloc(32, 7).toString('base64url')), 'unknown-token');
    unauthorised(await session.connection.get(headsOf(world.project), 'short'), 'unknown-token');
    unauthorised(await session.connection.get(headsOf(world.project)), 'no-token');
    unauthorised(await session.connection.call('GET', headsOf(world.project), { headers: { authorization: `Basic ${session.token}` } }), 'no-token');
  }));

test('a device holds at most 8 tokens: the ninth session drops the oldest token', () =>
  withHub({}, async (hub) => {
    const { world } = await enrolled(hub);
    const connection = await hub.connect();
    const tokens: string[] = [];
    for (let index = 0; index <= TOKENS_PER_DEVICE; index += 1) tokens.push((await hub.openSession(world.lead, world.project, connection)).token);
    assert.equal(hub.sessions.size, TOKENS_PER_DEVICE);
    unauthorised(await connection.get(headsOf(world.project), tokens[0]), 'unknown-token');
    assert.equal((await connection.get(headsOf(world.project), tokens[1])).status, 200);
  }));

/** A second project on the same hub with the same analyst device (device keys follow their label) as a member. */
async function secondProject(hub: Hub, analyst: WorldDevice): Promise<HubWorld> {
  const world = createHubWorld({ projectLabel: 'eastwind' });
  world.admitHub(hub.identity);
  const same = world.device('ANALYST', 'mbr-analyst');
  assert.equal(same.writer, analyst.writer, 'the analyst is one device in both projects');
  world.admitMember(same);
  await hub.enrolProject(world, { direct: true });
  return world;
}

test('revoked in one project: the device\'s token for another project it still belongs to keeps working', () =>
  withHub({}, async (hub) => {
    const { world, analyst } = await enrolled(hub);
    const other = await secondProject(hub, analyst);
    const inOther = await hub.openSession(analyst, other.project);
    const inFirst = await hub.openSession(analyst, world.project);
    const lead = await hub.openSession(world.lead, world.project);
    const revoke = world.rosterEntry(world.lead, 'device.revoke', { member: analyst.member, writer: analyst.writer });
    const appended = await lead.connection.post(`/v1/projects/${world.project}/append`, { entries: [revoke.entry] }, lead.token);
    assert.deepEqual(appended.json().accepted, [revoke.hash]);
    unauthorised(await inFirst.connection.get(headsOf(world.project), inFirst.token), 'revoked');
    const stillThere = await inOther.connection.get(headsOf(other.project), inOther.token);
    assert.equal(stillThere.status, 200, stillThere.text);
  }));

test('the 8 tokens a device holds are counted per project: a session in one project never drops a token of another', () =>
  withHub({}, async (hub) => {
    const { world, analyst } = await enrolled(hub);
    const other = await secondProject(hub, analyst);
    const connection = await hub.connect();
    const tokens: string[] = [];
    for (let index = 0; index < TOKENS_PER_DEVICE; index += 1) tokens.push((await hub.openSession(analyst, other.project, connection)).token);
    await hub.openSession(analyst, world.project);
    assert.equal(hub.sessions.size, TOKENS_PER_DEVICE + 1);
    const oldest = await connection.get(headsOf(other.project), tokens[0]);
    assert.equal(oldest.status, 200, oldest.text);
  }));

// ---- The authentication deadline (D-35) ----

test('deadline: a connection that sends nothing is closed when the deadline passes', () =>
  withHub({ deadlineMs: 200 }, async (hub) => {
    await enrolled(hub);
    const idle = await hub.connect();
    assert.equal(await idle.closesWithin(2000), true, 'the silent connection stayed open past the deadline');
  }));

test('deadline: a connection that opened a session stays open past the deadline', () =>
  withHub({ deadlineMs: 200 }, async (hub) => {
    const { world } = await enrolled(hub);
    const session = await hub.openSession(world.lead, world.project);
    assert.equal(await session.connection.closesWithin(600), false, 'the authenticated connection was closed');
    assert.equal((await session.connection.get(headsOf(world.project), session.token)).status, 200);
  }));

test('deadline: GET /healthz answers on a connection that has not authenticated, inside the deadline', () =>
  withHub({ deadlineMs: 200 }, async (hub) => {
    const connection = await hub.connect();
    const health = await connection.get('/healthz');
    assert.equal(health.status, 200);
    assert.equal(health.json().store, 'ok');
    assert.equal(await connection.closesWithin(2000), true);
  }));

test('deadline: an enrolment still uploading when the deadline passes is answered, and the connection closes after the answer', () =>
  withHub({ deadlineMs: 200 }, async (hub) => {
    const world = createHubWorld();
    world.admitHub(hub.identity);
    const issued = issueHubFile(hub.store, hub.identity, { days: 7, now: new Date(hub.now()) });
    assert.ok(issued.ok, issued.ok ? '' : issued.message);
    const body = Buffer.from(JSON.stringify(world.enrolRequest(issued.file.payload)), 'utf8');
    // About a second of upload on a connection that never opens a session: the deadline passes while the body is still arriving.
    const upload = await slowUpload(hub.port, { method: 'POST', path: '/v1/enrol', body, chunkBytes: Math.ceil(body.length / 10), everyMs: 100, headers: { 'content-type': 'application/json' } });
    assert.equal(upload.status, 201, `answered ${String(upload.status)} after ${upload.elapsedMs} ms having sent ${upload.sent} of ${body.length} bytes`);
    assert.ok(upload.elapsedMs > 200, 'the upload finished inside the deadline, so it did not test the deadline');
    assert.equal(await upload.closesWithin(2000), true, 'a connection without a session stayed open after its deadline');
  }));

test('keep-alive: a session\'s connection idle for 6 seconds is still open and its token still works, so a device does not open a session per exchange', { timeout: 20_000 }, () =>
  withHub({}, async (hub) => {
    const { world } = await enrolled(hub);
    const session = await hub.openSession(world.lead, world.project);
    assert.equal((await session.connection.get(headsOf(world.project), session.token)).status, 200);
    assert.equal(await session.connection.closesWithin(6000), false, 'the hub closed an idle authenticated connection within 6 seconds');
    assert.equal((await session.connection.get(headsOf(world.project), session.token)).status, 200);
  }));

// ---- Limits before signatures (D-39, Pitfall 7) ----

test('429: the eleventh session call from one address inside a minute is refused with Retry-After before the answer is checked', () =>
  // Five sessions a minute: ten calls, two for each session.
  withHub({ limits: { sessionPerMinute: 5 } }, async (hub) => {
    const { world } = await enrolled(hub);
    const connection = await hub.connect();
    let challenge = '';
    for (let call = 0; call < 10; call += 1) challenge = (await challengeOn(connection, world.project)).challenge;
    const answer = signAnswer(hub, world.lead.signer, { hub: hub.identity.writer, project: world.project, challenge, keying: connection.keying() });
    const refused = await connection.post('/v1/session', { answer });
    assert.equal(refused.status, 429);
    assert.equal(refused.json().error, 'rate-limited');
    assert.ok(Number(refused.headers['retry-after']) >= 1, 'a 429 carries Retry-After');
    assert.equal(hub.answerChecks(), 0, 'the answer was verified although the bucket was empty');
    // A minute later the bucket has refilled and the same socket can open a session.
    hub.advance(60_000);
    const fresh = await challengeOn(connection, world.project);
    const opened = await connection.post('/v1/session', { answer: signAnswer(hub, world.lead.signer, { hub: hub.identity.writer, project: world.project, challenge: fresh.challenge, keying: connection.keying() }) });
    assert.equal(opened.status, 200, opened.text);
    assert.equal(hub.answerChecks(), 1);
  }));

// ---- The certificate pin (D-29, Pitfall 6) ----

test('a certificate renewed with the same key keeps its certPinOf, and a certificate with a new key changes it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'near-ai-hub-pin-'));
  try {
    const openssl = (args: string[]): void => {
      const run = spawnSync('openssl', args, { encoding: 'utf8' });
      assert.equal(run.status, 0, `openssl ${args[0]} failed: ${run.stderr}`);
    };
    const key = path.join(dir, 'key.pem');
    const newKey = path.join(dir, 'new-key.pem');
    openssl(['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', key]);
    openssl(['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', newKey]);
    const cert = (keyFile: string, name: string, days: string): string => {
      const out = path.join(dir, `${name}.pem`);
      openssl(['req', '-x509', '-new', '-key', keyFile, '-out', out, '-days', days, '-subj', `/CN=${name}`]);
      return readFileSync(out, 'utf8');
    };
    const first = cert(key, 'hub-first', '1');
    const renewed = cert(key, 'hub-renewed', '30');
    const rekeyed = cert(newKey, 'hub-rekeyed', '1');
    assert.notEqual(first, renewed, 'the renewed certificate is a different certificate');
    assert.equal(certPinOf(renewed), certPinOf(first));
    assert.notEqual(certPinOf(rekeyed), certPinOf(first));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
