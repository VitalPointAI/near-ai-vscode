import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readGrant } from '@ext/domain/replica/cellKeys';
import { entryHash } from '@ext/domain/replica/entry';
import type { EntryHeader } from '@ext/domain/replica/entry';
import { buildSessionAnswer, certPinOf, readHubFile } from '@ext/domain/replica/hubFile';
import { SERVER_WORD_COUNT, serverPinWords } from '@ext/domain/replica/serverWords';
import { canonicalize } from '@ext/domain/team/canonical';
import { hubIdentityOf, issueHubFile } from '../src/enrol';
import { generateKeyFile, readEncryptionKey, readSigningKey } from '../src/keys';
import { LIMITS } from '../src/limits';
import { HubConnection } from './helpers/hubClient';
import type { HubResponse } from './helpers/hubClient';
import { withHub } from './helpers/hubHarness';
import type { Hub, OpenedSession } from './helpers/hubHarness';
import { launchHub, startHubProcess, within } from './helpers/hubProcess';
import { HUB_ADDRESS, createHubWorld } from './helpers/hubWorld';
import type { HubWorld, WorldDevice, Written } from './helpers/hubWorld';
import { makeTlsFixture } from './helpers/tlsFixture';

// Phase 32, plan 20 (D-34 to D-36, D-39, D-41, D-44, D-69): the hub's HTTP protocol, first half. A lead enrols a project over HTTPS, opens a session
// bound to its own TLS connection, appends, catches up, and moves blobs; every limit and access rule is checked through the real routes on a real
// TLS server. All names and data are fictional.

const note = (world: HubWorld, device: WorldDevice, extra: { stream?: string; text?: string } = {}): Written =>
  world.write(device, { kind: 'note.add', data: { text: extra.text ?? 'Fictional note' }, ...(extra.stream === undefined ? {} : { stream: extra.stream }) });

test('tracer: the lead enrols over HTTPS, opens a session bound to its connection, appends one entry and reads it back', () =>
  withHub({}, async (hub) => {
    const world = createHubWorld();
    world.admitHub(hub.identity);

    const enrolled = await hub.enrolProject(world);
    assert.ok(enrolled !== undefined);
    assert.equal(enrolled.status, 201, enrolled.text);
    assert.deepEqual(enrolled.json(), { project: world.project, rosterHead: world.head, hub: hub.identity.hub });

    // The client refuses a hub whose certificate pin is not the one it expects.
    await assert.rejects(HubConnection.open(hub.port, '0'.repeat(64)), /pin/);

    const session = await hub.openSession(world.lead, world.project);
    assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(session.project, world.project);

    const written = note(world, world.lead);
    const appended = await session.connection.post(`/v1/projects/${world.project}/append`, { entries: [written.entry] }, session.token);
    assert.equal(appended.status, 200, appended.text);
    assert.deepEqual(appended.json(), { project: world.project, accepted: [written.hash], refused: [], rosterHead: world.head });

    const heads = await session.connection.get(`/v1/projects/${world.project}/heads`, session.token);
    assert.equal(heads.status, 200, heads.text);
    const headBody = heads.json<{ project: string; rosterHead: string; streams: Array<{ stream: string; heads: Array<{ writer: string; seq: number; hash: string }> }>; grants: string[] }>();
    assert.equal(headBody.project, world.project);
    assert.equal(headBody.rosterHead, world.head);
    const base = headBody.streams.find((item) => item.stream === world.project);
    assert.ok(base !== undefined);
    assert.deepEqual(base.heads.find((item) => item.writer === world.lead.writer), { writer: world.lead.writer, seq: written.seq, hash: written.hash });

    const from = written.seq;
    const read = await session.connection.get(`/v1/projects/${world.project}/entries?stream=${world.project}&writer=${world.lead.writer}&from=${from}`, session.token);
    assert.equal(read.status, 200, read.text);
    const page = read.json<{ project: string; stream: string; writer: string; entries: unknown[]; more: boolean; head: unknown }>();
    assert.equal(page.project, world.project);
    assert.equal(page.stream, world.project);
    assert.equal(page.writer, world.lead.writer);
    assert.deepEqual(page.entries, [written.entry]);
    assert.equal(page.more, false);
    assert.deepEqual(page.head, { seq: written.seq, hash: written.hash });

    // The hook for 32-21 ran after COMMIT with the accepted entry.
    assert.deepEqual(hub.accepted, [{ project: world.project, accepted: [written.hash], rosterChanged: false }]);
  }));



// ---- Task 3: catch-up, appends, blobs, enrolment and errors over HTTP ----

const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

interface Staffed {
  world: HubWorld;
  /** A member granted only the base cell. */
  analyst: WorldDevice;
  /** A member granted the base cell and the operations label cell. */
  officer: WorldDevice;
  ops: { cell: string; grant: unknown };
}

/** The world's project with an analyst (base cell only) and an officer who also holds the label cell ops, enrolled over HTTPS. */
async function staffed(hub: Hub): Promise<Staffed> {
  const world = createHubWorld();
  world.admitHub(hub.identity);
  const analyst = world.device('ANALYST', 'mbr-analyst');
  const officer = world.device('OFFICER', 'mbr-officer');
  world.admitMember(analyst);
  world.admitMember(officer);
  const ops = world.labelCell('ops', [world.lead, officer]);
  const enrolled = await hub.enrolProject(world);
  assert.equal(enrolled?.status, 201, enrolled?.text ?? 'no answer');
  return { world, analyst, officer, ops: { cell: ops.cell, grant: ops.grant } };
}

/** Puts entries straight into the store, for catch-up tests that need more entries than one append carries. */
function seed(hub: Hub, project: string, written: readonly Written[]): void {
  hub.store.commitAppend(project, { entries: written.map((item) => ({ header: canonicalize(item.entry.header), body: item.entry.body, receivedAt: hub.now() })), at: hub.now() });
}

const entriesPath = (project: string, stream: string, writer: string, from: number): string => `/v1/projects/${project}/entries?stream=${stream}&writer=${writer}&from=${from}`;

interface Page {
  project: string;
  stream: string;
  writer: string;
  entries: Array<{ header: { seq: number }; body: string }>;
  more: boolean;
  head: { seq: number; hash: string } | null;
}

test('heads: a member sees only the streams and grant hashes of the cells it holds; a member of the label cell sees both', () =>
  withHub({}, async (hub) => {
    const { world, analyst, officer, ops } = await staffed(hub);
    const lead = await hub.openSession(world.lead, world.project);
    const inOps = note(world, world.lead, { stream: ops.cell });
    assert.deepEqual((await lead.connection.post(`/v1/projects/${world.project}/append`, { entries: [inOps.entry] }, lead.token)).json().accepted, [inOps.hash]);
    const opsGrant = createHash('sha256').update(canonicalize(ops.grant)).digest('hex');

    const headsFor = async (device: WorldDevice): Promise<{ streams: string[]; grants: string[]; rosterHead: string }> => {
      const session = await hub.openSession(device, world.project);
      const answer = await session.connection.get(`/v1/projects/${world.project}/heads`, session.token);
      assert.equal(answer.status, 200, answer.text);
      const body = answer.json<{ streams: Array<{ stream: string }>; grants: string[]; rosterHead: string }>();
      return { streams: body.streams.map((item) => item.stream), grants: body.grants, rosterHead: body.rosterHead };
    };
    const seenByAnalyst = await headsFor(analyst);
    assert.deepEqual(seenByAnalyst.streams, [world.project]);
    assert.equal(seenByAnalyst.grants.includes(opsGrant), false, 'the label cell grant is listed to a member outside it');
    assert.ok(seenByAnalyst.grants.length > 0, 'the base cell grants are listed');
    assert.equal(seenByAnalyst.rosterHead, world.head);
    const seenByOfficer = await headsFor(officer);
    assert.deepEqual([...seenByOfficer.streams].sort(), [world.project, ops.cell].sort());
    assert.ok(seenByOfficer.grants.includes(opsGrant));
  }));

test('entries: 1,200 entries of one writer come back as 1,000 with more true and head seq 999, then 200 with more false', () =>
  withHub({}, async (hub) => {
    const { world, ops } = await staffed(hub);
    const written: Written[] = [];
    for (let index = 0; index < 1200; index += 1) written.push(note(world, world.lead, { stream: ops.cell, text: `Fictional entry ${index}` }));
    seed(hub, world.project, written);
    const lead = await hub.openSession(world.lead, world.project);
    const first = await lead.connection.get(entriesPath(world.project, ops.cell, world.lead.writer, 0), lead.token);
    assert.equal(first.status, 200);
    const page = first.json<Page>();
    assert.deepEqual([page.project, page.stream, page.writer], [world.project, ops.cell, world.lead.writer]);
    assert.equal(page.entries.length, 1000);
    assert.deepEqual(page.entries.map((entry) => entry.header.seq), [...Array(1000).keys()]);
    assert.equal(page.more, true);
    assert.deepEqual(page.head, { seq: 999, hash: written[999]?.hash });
    const second = (await lead.connection.get(entriesPath(world.project, ops.cell, world.lead.writer, 1000), lead.token)).json<Page>();
    assert.deepEqual([second.project, second.stream, second.writer], [world.project, ops.cell, world.lead.writer]);
    assert.equal(second.entries.length, 200);
    assert.equal(second.entries[0]?.header.seq, 1000);
    assert.equal(second.more, false);
    assert.deepEqual(second.head, { seq: 1199, hash: written[1199]?.hash });
  }));

test('entries: a page of large inline bodies stops at the 4 MiB cap with more true and the head it reached', () =>
  withHub({}, async (hub) => {
    const { world, ops } = await staffed(hub);
    const written: Written[] = [];
    // Each body is close to the 16 KiB inline limit, the largest an entry holds inline; 250 of them are well past 4 MiB.
    for (let index = 0; index < 250; index += 1) written.push(note(world, world.lead, { stream: ops.cell, text: `${index}`.padEnd(15_000, 'x') }));
    assert.ok(written.every((item) => item.blobs.length === 0), 'the bodies stayed inline');
    seed(hub, world.project, written);
    const lead = await hub.openSession(world.lead, world.project);
    const answer = await lead.connection.get(entriesPath(world.project, ops.cell, world.lead.writer, 0), lead.token);
    const page = answer.json<Page>();
    assert.equal(page.more, true);
    assert.ok(page.entries.length > 100 && page.entries.length < 250, `${page.entries.length} entries in one page`);
    const size = page.entries.reduce((total, entry) => total + canonicalize(entry.header).length + entry.body.length, 0);
    assert.ok(size <= LIMITS.catchUpBytes, `the page carried ${size} bytes of entries`);
    const last = written[page.entries.length - 1] as Written;
    assert.deepEqual(page.head, { seq: last.seq, hash: last.hash });
  }));

test('entries: from beyond the head gives no entries, more false and the writer head at the hub', () =>
  withHub({}, async (hub) => {
    const { world } = await staffed(hub);
    const lead = await hub.openSession(world.lead, world.project);
    const head = hub.store.headOf(world.project, world.project, world.lead.writer);
    assert.ok(head !== undefined);
    const page = (await lead.connection.get(entriesPath(world.project, world.project, world.lead.writer, head.seq + 5), lead.token)).json<Page>();
    assert.deepEqual(page.entries, []);
    assert.equal(page.more, false);
    assert.deepEqual(page.head, head);
    assert.deepEqual([page.project, page.stream, page.writer], [world.project, world.project, world.lead.writer]);
    // A writer the hub holds nothing from: no entries and no head.
    const none = (await lead.connection.get(entriesPath(world.project, world.project, 'c'.repeat(64), 0), lead.token)).json<Page>();
    assert.deepEqual([none.entries, none.more, none.head], [[], false, null]);
  }));

test('entries: an unknown stream and a stream the device may not read are the same 404; a bad query is 400', () =>
  withHub({}, async (hub) => {
    const { world, analyst, ops } = await staffed(hub);
    const lead = await hub.openSession(world.lead, world.project);
    const inOps = note(world, world.lead, { stream: ops.cell });
    await lead.connection.post(`/v1/projects/${world.project}/append`, { entries: [inOps.entry] }, lead.token);
    const member = await hub.openSession(analyst, world.project);
    const denied = await member.connection.get(entriesPath(world.project, ops.cell, world.lead.writer, 0), member.token);
    const unknown = await member.connection.get(entriesPath(world.project, 'd'.repeat(32), world.lead.writer, 0), member.token);
    assert.equal(denied.status, 404);
    assert.equal(unknown.status, 404);
    assert.equal(denied.text, unknown.text);
    assert.deepEqual(denied.json(), { error: 'not-found', message: 'There is nothing at this address on the hub.' });
    for (const query of ['stream=xyz&writer=' + world.lead.writer, `stream=${world.project}`, `stream=${world.project}&writer=${world.lead.writer}&from=-1`]) {
      assert.equal((await member.connection.get(`/v1/projects/${world.project}/entries?${query}`, member.token)).status, 400);
    }
  }));

test('append over HTTP: every outcome comes back with its id, index and hash, and is answered only after COMMIT', () =>
  withHub({}, async (hub) => {
    const { world, analyst, ops } = await staffed(hub);
    const lead = await hub.openSession(world.lead, world.project);
    const member = await hub.openSession(analyst, world.project);
    const appendPath = `/v1/projects/${world.project}/append`;
    const kept = note(world, analyst);
    const gap = world.write(analyst, { kind: 'note.add', data: { text: 'Gap' }, seq: kept.seq + 5, prev: kept.hash });
    const notMine = note(world, analyst, { stream: ops.cell });
    const answer = await member.connection.post(appendPath, { entries: [kept.entry, gap.entry, notMine.entry] }, member.token);
    assert.equal(answer.status, 200, answer.text);
    const body = answer.json<{ project: string; accepted: string[]; refused: Array<{ index: number; hash?: string; reason: string; message: string }>; rosterHead: string }>();
    assert.equal(body.project, world.project);
    assert.deepEqual(body.accepted, [kept.hash]);
    assert.deepEqual(body.refused.map((item) => [item.index, item.hash, item.reason]), [[1, gap.hash, 'seq-gap'], [2, notMine.hash, 'not-on-access-list']]);
    assert.ok(body.refused.every((item) => typeof item.message === 'string' && item.message.length > 0));
    assert.equal(body.rosterHead, world.head);
    assert.equal(hub.store.entryByHash(world.project, kept.hash)?.hash, kept.hash, 'the accepted entry is on disk');
    // The same entry again is held: listed as accepted, refused nothing.
    const again = (await member.connection.post(appendPath, { entries: [kept.entry] }, member.token)).json<{ accepted: string[]; refused: unknown[] }>();
    assert.deepEqual([again.accepted, again.refused], [[kept.hash], []]);
    // The lead's roster entry moves the roster head the answer names.
    const invite = world.rosterEntry(world.lead, 'member.invite', { invite: 'inv-http', name: 'Analyst Two', seat: 'j2-analyst', roles: ['member'], clearance: { scale: 'demo', level: 'OFFICIAL', compartments: [], releasability: [] }, expiresAt: '2026-11-26T11:00:00.000Z', secretHash: 'a'.repeat(64) });
    const moved = (await lead.connection.post(appendPath, { entries: [invite.entry] }, lead.token)).json<{ rosterHead: string }>();
    assert.equal(moved.rosterHead, invite.hash);
  }));

test('append over HTTP: 201 entries is 413, a missing blob is a 200 refusing that entry blob-missing (Phase 33 D-28), and a burst past the bucket is 429 with Retry-After', () =>
  withHub({ limits: { writerBurst: 5, writerPerSecond: 1 } }, async (hub) => {
    const { world } = await staffed(hub);
    const lead = await hub.openSession(world.lead, world.project);
    const appendPath = `/v1/projects/${world.project}/append`;
    const many = Array.from({ length: LIMITS.appendEntries + 1 }, () => ({ header: {}, body: '' }));
    const tooMany = await lead.connection.post(appendPath, { entries: many }, lead.token);
    assert.equal(tooMany.status, 413);
    assert.equal(tooMany.json().error, 'batch-too-large');
    const one = note(world, world.lead);
    const missing = await lead.connection.post(appendPath, { entries: [one.entry], blobRefs: [{ entry: one.hash, blob: 'b'.repeat(64) }] }, lead.token);
    // Per entry since Phase 33 D-28: the batch is answered 200 and only the entry naming the missing blob is refused.
    assert.equal(missing.status, 200);
    assert.deepEqual(missing.json<{ refused: Array<{ hash: string; reason: string }> }>().refused.map((item) => [item.hash, item.reason]), [[one.hash, 'blob-missing']]);
    // The bucket holds 5: the refused blob-missing batch took 1 (the bucket runs first), these 4 take the rest, and the next entry is refused.
    const burst = Array.from({ length: 4 }, () => note(world, world.lead));
    assert.equal((await lead.connection.post(appendPath, { entries: [one.entry, ...burst.slice(0, 3).map((item) => item.entry)] }, lead.token)).status, 200);
    const limited = await lead.connection.post(appendPath, { entries: [burst[3]?.entry] }, lead.token);
    assert.equal(limited.status, 429);
    assert.equal(limited.json().error, 'rate-limited');
    assert.ok(Number(limited.headers['retry-after']) >= 1);
    const malformed = await lead.connection.post(appendPath, { entries: 'none' }, lead.token);
    assert.equal(malformed.status, 400);
  }));

test('blobs: a wrong hash is 400 blob-mismatch, the same blob twice is 201 then 200, and over 8 MiB is 413 before the body is read', () =>
  withHub({}, async (hub) => {
    const { world } = await staffed(hub);
    const lead = await hub.openSession(world.lead, world.project);
    const bytes = randomBytes(4096);
    const hash = sha256Hex(bytes);
    const mismatch = await lead.connection.put(`/v1/blobs/${'0'.repeat(64)}`, bytes, lead.token);
    assert.equal(mismatch.status, 400);
    assert.deepEqual(mismatch.json().error, 'blob-mismatch');
    const first = await lead.connection.put(`/v1/blobs/${hash}`, bytes, lead.token);
    assert.equal(first.status, 201, first.text);
    assert.deepEqual(first.json(), { project: world.project, hash });
    const again = await lead.connection.put(`/v1/blobs/${hash}`, bytes, lead.token);
    assert.equal(again.status, 200);
    assert.deepEqual(again.json(), { project: world.project, hash });
    // Only the headers are sent: the hub answers 413 without waiting for a single byte of the body.
    const other = await hub.openSession(world.lead, world.project);
    const huge = await other.connection.call('PUT', `/v1/blobs/${hash}`, { token: other.token, declaredLength: LIMITS.blobBytes + 1, headers: { 'content-type': 'application/octet-stream' } });
    assert.equal(huge.status, 413);
    assert.equal(huge.json().error, 'too-large');
  }));

test('blobs: a device that may not read the referencing stream, another project\'s token and an unknown hash all get the same 404', () =>
  withHub({}, async (hub) => {
    const { world, analyst, officer, ops } = await staffed(hub);
    const lead = await hub.openSession(world.lead, world.project);
    const bytes = randomBytes(2048);
    const hash = sha256Hex(bytes);
    assert.equal((await lead.connection.put(`/v1/blobs/${hash}`, bytes, lead.token)).status, 201);
    const uses = note(world, world.lead, { stream: ops.cell });
    const appended = await lead.connection.post(`/v1/projects/${world.project}/append`, { entries: [uses.entry], blobRefs: [{ entry: uses.hash, blob: hash }] }, lead.token);
    assert.deepEqual(appended.json().accepted, [uses.hash]);

    const reader = await hub.openSession(officer, world.project);
    const allowed = await reader.connection.get(`/v1/blobs/${hash}`, reader.token);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers['x-near-ai-project'], world.project);
    assert.ok(allowed.body.equals(bytes));

    const outsider = await hub.openSession(analyst, world.project);
    const denied = await outsider.connection.get(`/v1/blobs/${hash}`, outsider.token);
    const harbour = createHubWorld({ projectLabel: 'harbour', leadLabel: 'HARBOUR-LEAD' });
    harbour.admitHub(hub.identity);
    assert.equal((await hub.enrolProject(harbour))?.status, 201);
    const foreign = await hub.openSession(harbour.lead, harbour.project);
    const otherProject = await foreign.connection.get(`/v1/blobs/${hash}`, foreign.token);
    const unknown = await outsider.connection.get(`/v1/blobs/${'f'.repeat(64)}`, outsider.token);
    for (const answer of [denied, otherProject, unknown]) {
      assert.equal(answer.status, 404);
      assert.equal(answer.text, denied.text);
      assert.equal(answer.headers['x-near-ai-project'], undefined);
    }
    assert.deepEqual(denied.json(), { error: 'not-found', message: 'There is nothing at this address on the hub.' });
  }));

test('blobs: a grant hash listed in heads is served as bytes whose sha256 is that hash and that readGrant accepts; an unlisted one is 404', () =>
  withHub({}, async (hub) => {
    const { world, analyst, ops } = await staffed(hub);
    const member = await hub.openSession(analyst, world.project);
    const heads = (await member.connection.get(`/v1/projects/${world.project}/heads`, member.token)).json<{ grants: string[] }>();
    assert.ok(heads.grants.length > 0);
    for (const hash of heads.grants) {
      const answer = await member.connection.get(`/v1/blobs/${hash}`, member.token);
      assert.equal(answer.status, 200);
      assert.equal(sha256Hex(answer.body), hash);
      const read = readGrant(JSON.parse(answer.text) as unknown);
      assert.ok(read.ok);
      assert.equal(read.hash, hash);
    }
    const opsGrant = createHash('sha256').update(canonicalize(ops.grant)).digest('hex');
    assert.equal((await member.connection.get(`/v1/blobs/${opsGrant}`, member.token)).status, 404);
  }));

test('blobs: the sweep removes an upload no entry referenced within 24 hours and keeps a referenced one', () =>
  withHub({}, async (hub) => {
    const { world } = await staffed(hub);
    const lead = await hub.openSession(world.lead, world.project);
    const abandoned = randomBytes(1024);
    const used = randomBytes(1024);
    await lead.connection.put(`/v1/blobs/${sha256Hex(abandoned)}`, abandoned, lead.token);
    await lead.connection.put(`/v1/blobs/${sha256Hex(used)}`, used, lead.token);
    const uses = note(world, world.lead);
    await lead.connection.post(`/v1/projects/${world.project}/append`, { entries: [uses.entry], blobRefs: [{ entry: uses.hash, blob: sha256Hex(used) }] }, lead.token);
    hub.advance(24 * 60 * 60 * 1000 - 1000);
    assert.equal(await hub.sweep(), 0, 'nothing is swept before 24 hours');
    hub.advance(1000);
    assert.equal(await hub.sweep(), 1);
    assert.equal(hub.store.blobInfo(world.project, sha256Hex(abandoned)), undefined);
    const later = await hub.openSession(world.lead, world.project);
    assert.equal((await later.connection.get(`/v1/blobs/${sha256Hex(abandoned)}`, later.token)).status, 404);
    const kept = await later.connection.get(`/v1/blobs/${sha256Hex(used)}`, later.token);
    assert.ok(kept.body.equals(used));
  }));

test('enrol over HTTP: refusals come back with their ids, a used hub file and a held project are refused, and nothing else creates a project', () =>
  withHub({}, async (hub) => {
    const world = createHubWorld();
    world.admitHub(hub.identity);
    const connection = await hub.connect();
    const malformed = await connection.post('/v1/enrol', { project: world.project });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.json().error, 'malformed');
    const issued = issueHubFile(hub.store, hub.identity, { days: 7, now: new Date(hub.now()) });
    assert.ok(issued.ok);
    const badMac = await connection.post('/v1/enrol', world.enrolRequest(issued.file.payload, { mac: 'A'.repeat(43) }));
    assert.equal(badMac.status, 403);
    assert.equal(badMac.json().error, 'bad-mac');
    assert.equal(hub.store.project(world.project), undefined);
    const created = await connection.post('/v1/enrol', world.enrolRequest(issued.file.payload));
    assert.equal(created.status, 201, created.text);
    const used = await connection.post('/v1/enrol', world.enrolRequest(issued.file.payload));
    assert.equal(used.status, 403);
    assert.equal(used.json().error, 'enrolment-used');
    const second = issueHubFile(hub.store, hub.identity, { days: 7, now: new Date(hub.now()) });
    assert.ok(second.ok);
    const held = await connection.post('/v1/enrol', world.enrolRequest(second.file.payload));
    assert.equal(held.status, 409);
    assert.equal(held.json().error, 'project-exists');
    // Without enrolment no route creates a project: a session for an unknown project is refused and an append to it gets no further than 401.
    const stranger = createHubWorld({ projectLabel: 'unenrolled' });
    const challenge = await connection.post('/v1/session', { project: stranger.project });
    assert.equal(challenge.status, 403);
    const append = await connection.post(`/v1/projects/${stranger.project}/append`, { entries: [] });
    assert.equal(append.status, 401);
    assert.equal(hub.store.project(stranger.project), undefined);
  }));

test('enrol over HTTP: the eleventh enrolment from one address inside a minute is 429 with Retry-After before the body is read', () =>
  withHub({}, async (hub) => {
    const connection = await hub.connect();
    for (let call = 0; call < LIMITS.enrolPerMinute; call += 1) assert.equal((await connection.post('/v1/enrol', {})).status, 400);
    const limited = await connection.post('/v1/enrol', {});
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers['retry-after']) >= 1);
  }));

test('errors: unknown paths are 404, wrong methods are 405 with allow, and no error body holds the token, the challenge or the path', () =>
  withHub({}, async (hub) => {
    const { world } = await staffed(hub);
    const session: OpenedSession = await hub.openSession(world.lead, world.project);
    const challenge = (await session.connection.post('/v1/session', { project: world.project })).json<{ challenge: string }>().challenge;
    const answers: HubResponse[] = [];
    const call = async (method: string, target: string, status: number, allow?: string): Promise<void> => {
      const answer = await session.connection.call(method, target, { token: session.token });
      assert.equal(answer.status, status, `${method} ${target}`);
      if (allow !== undefined) assert.equal(answer.headers.allow, allow);
      answers.push(answer);
    };
    await call('GET', '/v1/nothing-here-secret-path', 404);
    await call('POST', '/v1/projects/NOT-HEX/append', 404);
    await call('GET', `/v1/projects/${world.project}/nothing`, 404);
    await call('GET', `/v1/blobs/short`, 404);
    await call('GET', '/v1/session', 405, 'POST');
    await call('DELETE', `/v1/blobs/${'a'.repeat(64)}`, 405, 'PUT, GET');
    await call('POST', `/v1/projects/${world.project}/heads`, 405, 'GET');
    await call('PUT', `/v1/projects/${world.project}/entries`, 405, 'GET');
    answers.push(await session.connection.get(`/v1/projects/${world.project}/heads`, 'A'.repeat(43)));
    answers.push(await session.connection.post('/v1/session', { answer: { challenge } }));
    for (const answer of answers) {
      assert.match(String(answer.headers['content-type']), /^application\/json/);
      assert.equal(answer.headers['cache-control'], 'no-store');
      const body = answer.json<{ error: string; message: string }>();
      assert.equal(typeof body.error, 'string');
      assert.equal(typeof body.message, 'string');
      for (const secret of [session.token, challenge, 'nothing-here-secret-path', 'NOT-HEX', 'A'.repeat(43)]) assert.equal(answer.text.includes(secret), false, `an error body echoed ${secret.slice(0, 8)}`);
    }
  }));

// ---- The built binary: --hub-file and a hard kill (D-41, D-26) ----

test('hub-file: --hub-file 7 with the four secret files and HUB_PUBLIC_ADDRESS prints exactly one hub file and nothing else', async () => {
  const run = launchHub({ args: ['--hub-file', '7'], env: { HUB_PUBLIC_ADDRESS: HUB_ADDRESS } });
  try {
    const exit = await within(run.exited, 20_000, 'the hub file');
    assert.deepEqual(exit, { code: 0, signal: null }, run.stdout());
    const out = run.stdout();
    assert.equal(out.endsWith('\n'), true);
    assert.equal(out.split('\n').length, 2, 'stdout holds one line');
    const read = readHubFile(out.trim(), new Date());
    assert.ok(read.ok, read.ok ? '' : read.message);
    assert.equal(read.hubFile.address, HUB_ADDRESS);
    assert.equal(read.hubFile.certPin, certPinOf(run.tls.certPem));
    const days = (Date.parse(read.hubFile.expiresAt) - Date.now()) / 86_400_000;
    assert.ok(days > 6.9 && days <= 7, `the file lasts ${days} days`);
    assert.equal(run.stderr(), '');
  } finally {
    run.cleanup();
  }
});

test('hub-file: without HUB_PUBLIC_ADDRESS it exits 1 naming that setting, and --hub-file 0 or a word exits 1', async () => {
  for (const [args, env, needle] of [
    [['--hub-file', '7'], {}, 'HUB_PUBLIC_ADDRESS'],
    [['--hub-file', '0'], { HUB_PUBLIC_ADDRESS: HUB_ADDRESS }, '1 to 30 days'],
    [['--hub-file', 'seven'], { HUB_PUBLIC_ADDRESS: HUB_ADDRESS }, 'usage'],
  ] as const) {
    const run = launchHub({ args: [...args], env: { ...env } });
    try {
      const exit = await within(run.exited, 20_000, 'the refused hub file');
      assert.equal(exit.code, 1);
      const lines = run.logs();
      assert.deepEqual(lines.map((line) => line.event), ['hub.start_refused']);
      assert.ok(String(lines[0]?.detail).includes(needle), String(lines[0]?.detail));
      assert.equal(run.stdout().includes('staff-hub-file'), false);
    } finally {
      run.cleanup();
    }
  }
});

// ---- The built binary: --pin-words (G541) ----

/** The certificate pin worked out with openssl, the way relay/README.md prints it, so the test does not lean on the hub's own pin code. */
function opensslPin(certFile: string): string {
  const pubkey = spawnSync('openssl', ['x509', '-in', certFile, '-noout', '-pubkey'], { encoding: 'utf8' });
  assert.equal(pubkey.status, 0, pubkey.stderr);
  const der = spawnSync('openssl', ['pkey', '-pubin', '-outform', 'DER'], { input: pubkey.stdout });
  assert.equal(der.status, 0, der.stderr.toString());
  return createHash('sha256').update(der.stdout).digest('hex');
}

test('pin-words: --pin-words prints one line, the twelve words SovAI shows for the certificate pin', async () => {
  // Only the TLS pair: the words need no hub key, no settings and no state folder.
  const run = launchHub({ args: ['--pin-words'], secrets: { HUB_SIGNING_KEY: null, HUB_ENCRYPTION_KEY: null }, env: { HUB_PORT: 'not-a-port' } });
  try {
    const exit = await within(run.exited, 20_000, 'the pin words');
    assert.deepEqual(exit, { code: 0, signal: null }, run.stdout());
    const out = run.stdout();
    assert.equal(out.endsWith('\n'), true);
    assert.equal(out.split('\n').length, 2, 'stdout holds one line');
    const pin = opensslPin(run.tls.certFile);
    assert.equal(pin, certPinOf(run.tls.certPem));
    // The words in SovAI's order, space separated: the form staffHubReadmit.test.ts shows a lead's computer accepts before it writes hub.readmit.
    assert.equal(out.trim(), serverPinWords(pin).join(' '));
    assert.equal(out.trim().split(' ').length, SERVER_WORD_COUNT);
    assert.equal(run.stderr(), '');
    assert.equal(existsSync(run.stateDir), false, 'it touches no state folder');
  } finally {
    run.cleanup();
  }
});

test('pin-words: without the certificate, with a key of another certificate, or with an extra word it exits 1 with one refusal and no words', async () => {
  const other = makeTlsFixture();
  try {
    for (const [args, secrets, reason] of [
      [['--pin-words'], { HUB_TLS_CERT: null }, 'secrets'],
      [['--pin-words'], { HUB_TLS_KEY: other.keyPem }, 'tls'],
      [['--pin-words', 'extra'], {}, 'config'],
    ] as const) {
      const run = launchHub({ args: [...args], secrets: { ...secrets } });
      try {
        const exit = await within(run.exited, 20_000, 'the refused pin words');
        assert.equal(exit.code, 1);
        const lines = run.logs();
        assert.deepEqual(lines.map((line) => line.event), ['hub.start_refused']);
        assert.equal(lines[0]?.reason, reason, String(lines[0]?.detail));
        assert.equal(run.stdout().split('\n').length, 2, 'stdout holds the refusal only');
      } finally {
        run.cleanup();
      }
    }
  } finally {
    other.cleanup();
  }
});

test('SIGKILL: the built hub killed after 20 acknowledged appends restarts on its state directory with all 20', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-hub-kill-'));
  const tlsFixture = makeTlsFixture();
  const signingLine = generateKeyFile('signing');
  const encryptionLine = generateKeyFile('encryption');
  const secrets = { HUB_TLS_CERT: tlsFixture.certPem, HUB_TLS_KEY: tlsFixture.keyPem, HUB_SIGNING_KEY: `${signingLine}\n`, HUB_ENCRYPTION_KEY: `${encryptionLine}\n` };
  const stateDir = path.join(root, 'state');
  const signing = readSigningKey(signingLine);
  const identity = hubIdentityOf(signing, readEncryptionKey(encryptionLine, signing), tlsFixture.certPem, HUB_ADDRESS);
  const runs: Array<{ cleanup(): void }> = [];
  try {
    const issue = launchHub({ args: ['--hub-file', '7'], secrets, stateDir, env: { HUB_PUBLIC_ADDRESS: HUB_ADDRESS } });
    runs.push(issue);
    assert.equal((await within(issue.exited, 20_000, 'the hub file')).code, 0, issue.stdout());
    const file = readHubFile(issue.stdout().trim(), new Date());
    assert.ok(file.ok);

    const first = await startHubProcess({ secrets, stateDir });
    runs.push(first);
    const world = createHubWorld();
    world.admitHub(identity);
    const enrol = await HubConnection.open(first.port, identity.certPin);
    const enrolled = await enrol.post('/v1/enrol', world.enrolRequest(file.hubFile));
    assert.equal(enrolled.status, 201, enrolled.text);
    enrol.close();

    const open = async (port: number): Promise<{ connection: HubConnection; token: string }> => {
      const connection = await HubConnection.open(port, identity.certPin);
      const challenge = (await connection.post('/v1/session', { project: world.project })).json<{ hub: string; challenge: string }>();
      const answer = buildSessionAnswer(world.lead.signer, { hub: challenge.hub, project: world.project, challenge: challenge.challenge, keying: connection.keying(), now: new Date() });
      const opened = await connection.post('/v1/session', { answer });
      assert.equal(opened.status, 200, opened.text);
      return { connection, token: opened.json<{ token: string }>().token };
    };
    const session = await open(first.port);
    const acknowledged: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const written = note(world, world.lead, { text: `Fictional log line ${index}` });
      const answer = await session.connection.post(`/v1/projects/${world.project}/append`, { entries: [written.entry] }, session.token);
      assert.deepEqual(answer.json().accepted, [written.hash]);
      acknowledged.push(written.hash);
    }
    session.connection.close();
    const killed = await within(first.kill('SIGKILL'), 10_000, 'the hard kill');
    assert.equal(killed.signal, 'SIGKILL');

    const second = await startHubProcess({ secrets, stateDir });
    runs.push(second);
    const again = await open(second.port);
    const page = (await again.connection.get(entriesPath(world.project, world.project, world.lead.writer, 0), again.token)).json<Page>();
    assert.equal(page.more, false);
    const held = new Set(page.entries.map((entry) => entryHash(entry.header as unknown as EntryHeader)));
    for (const hash of acknowledged) assert.ok(held.has(hash), 'an acknowledged append was lost');
    again.connection.close();
    const probe = await HubConnection.open(second.port, identity.certPin);
    assert.equal((await probe.get('/healthz')).json().store, 'ok');
    probe.close();
  } finally {
    for (const run of runs) run.cleanup();
    tlsFixture.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
