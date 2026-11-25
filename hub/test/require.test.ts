import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { KNOWN_REPLICA_FEATURES, UPDATE_SENTENCE } from '@ext/domain/replica/features';
import { buildSessionAnswer } from '@ext/domain/replica/hubFile';
import { APPEND_REFUSALS } from '../src/append/checks';
import { SESSION_REFUSALS } from '../src/http/session';
import { withHub } from './helpers/hubHarness';
import type { Hub } from './helpers/hubHarness';
import type { HubConnection } from './helpers/hubClient';
import { createHubWorld } from './helpers/hubWorld';
import type { HubWorld, Written } from './helpers/hubWorld';

// Phase 33, plan 07 (POST-01, D-07): your organization's server obeys roster.require. A project that requires a feature this hub does not fold takes
// no append, though reads go on; and a session is refused when the device's signed features do not cover what the project requires, so a client
// too old to know roster.require cannot write through the hub. All names and data are fictional.

const note = (world: HubWorld, text = 'Fictional note'): Written => world.write(world.lead, { kind: 'note.add', data: { text } });

/** The world's project, enrolled, with the roster.require entries given written before enrolment. */
async function enrolled(hub: Hub, required: readonly string[][] = []): Promise<HubWorld> {
  const world = createHubWorld();
  world.admitHub(hub.identity);
  for (const features of required) world.rosterEntry(world.lead, 'roster.require', { features });
  const answer = await hub.enrolProject(world);
  assert.equal(answer?.status, 201, answer?.text ?? 'no answer');
  return world;
}

/** Opens a session announcing the features given; the answer as the hub sent it. */
async function sessionWith(hub: Hub, world: HubWorld, features: readonly string[]): Promise<{ status: number; body: Record<string, unknown> }> {
  const connection: HubConnection = await hub.connect();
  const challenge = await connection.post('/v1/session', { project: world.project });
  assert.equal(challenge.status, 200, challenge.text);
  const body = challenge.json<{ hub: string; challenge: string }>();
  const answer = buildSessionAnswer(world.lead.signer, { hub: body.hub, project: world.project, challenge: body.challenge, keying: connection.keying(), features, now: new Date(hub.now()) });
  const opened = await connection.post('/v1/session', { answer });
  return { status: opened.status, body: opened.json<Record<string, unknown>>() };
}

test('tracer: once the project requires a feature this hub lacks, appends are refused 403 needs-update and nothing is stored, while heads, entries and blobs still answer', () =>
  withHub({}, async (hub) => {
    const world = await enrolled(hub, [['require@1']]);
    const lead = await hub.openSession(world.lead, world.project);
    const appendPath = `/v1/projects/${world.project}/append`;
    const bytes = Buffer.from('fictional sealed blob bytes');
    const blobHash = createHash('sha256').update(bytes).digest('hex');
    assert.equal((await lead.connection.put(`/v1/blobs/${blobHash}`, bytes, lead.token)).status, 201);
    // A newer lead requires positions@1, which this hub does not fold. That entry is the last the hub takes.
    const requires = world.rosterEntry(world.lead, 'roster.require', { features: ['positions@1'] });
    const taken = await lead.connection.post(appendPath, { entries: [requires.entry] }, lead.token);
    assert.equal(taken.status, 200, taken.text);
    const before = hub.store.heads(world.project);
    const after = note(world);
    const refused = await lead.connection.post(appendPath, { entries: [after.entry] }, lead.token);
    assert.equal(refused.status, 403);
    assert.deepEqual(refused.json(), { error: 'needs-update', message: APPEND_REFUSALS['needs-update'] });
    assert.deepEqual(hub.store.heads(world.project), before, 'nothing was stored');
    assert.doesNotMatch(APPEND_REFUSALS['needs-update'], /project/i);
    // Reads go on with the same session.
    assert.equal((await lead.connection.get(`/v1/projects/${world.project}/heads`, lead.token)).status, 200);
    const entries = await lead.connection.get(`/v1/projects/${world.project}/entries?stream=${world.project}&writer=${world.lead.writer}&from=0`, lead.token);
    assert.equal(entries.status, 200);
    assert.ok(entries.json<{ entries: unknown[] }>().entries.length > 0);
    assert.equal((await lead.connection.get(`/v1/blobs/${blobHash}`, lead.token)).status, 200);
  }));

test('a project that requires only features this hub folds takes appends as before', () =>
  withHub({}, async (hub) => {
    const world = await enrolled(hub, [['require@1'], ['cells@1', 'hub@1']]);
    const lead = await hub.openSession(world.lead, world.project);
    const written = note(world);
    const answer = await lead.connection.post(`/v1/projects/${world.project}/append`, { entries: [written.entry] }, lead.token);
    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual(answer.json<{ accepted: string[] }>().accepted, [written.hash]);
  }));

test('a session announcing no features for a project that requires require@1 is refused needs-update with the update sentence', () =>
  withHub({}, async (hub) => {
    const world = await enrolled(hub, [['require@1']]);
    const old = await sessionWith(hub, world, []);
    assert.equal(old.status, 403);
    assert.deepEqual(old.body, { error: 'session-refused', reason: 'needs-update', message: UPDATE_SENTENCE });
    assert.equal(SESSION_REFUSALS['needs-update'], UPDATE_SENTENCE);
  }));

test('a session announcing this build\'s features for a require@1 project opens', () =>
  withHub({}, async (hub) => {
    const world = await enrolled(hub, [['require@1']]);
    const current = await sessionWith(hub, world, KNOWN_REPLICA_FEATURES);
    assert.equal(current.status, 200, JSON.stringify(current.body));
    assert.equal(typeof current.body.token, 'string');
  }));

test('a project that requires nothing accepts a session announcing no features (the 0.4.35 preview shape)', () =>
  withHub({}, async (hub) => {
    const world = await enrolled(hub);
    const old = await sessionWith(hub, world, []);
    assert.equal(old.status, 200, JSON.stringify(old.body));
  }));

test('a session announcing a feature this hub does not fold never covers it: a project requiring positions@1 refuses even a device that claims it', () =>
  withHub({}, async (hub) => {
    const world = await enrolled(hub, [['positions@1', 'require@1']]);
    const claimed = await sessionWith(hub, world, [...KNOWN_REPLICA_FEATURES, 'positions@1'].sort());
    assert.equal(claimed.status, 403);
    assert.equal(claimed.body.reason, 'needs-update');
  }));
