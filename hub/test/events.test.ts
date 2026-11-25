import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { checkpointHash, signCheckpoint } from '@ext/domain/replica/checkpoint';
import type { Checkpoint, SignedCheckpoint } from '@ext/domain/replica/checkpoint';
import type { PayloadSigner } from '@ext/domain/team/signedPayload';
import { canonicalize } from '@ext/domain/team/canonical';
import { TOKEN_TTL_MS } from '../src/http/session';
import { EVENT_BUDGET_BYTES, EVENT_TIMING } from '../src/live/events';
import { LIMITS } from '../src/limits';
import { withHub } from './helpers/hubHarness';
import type { Hub, StartOptions } from './helpers/hubHarness';
import { createHubWorld, streamOf } from './helpers/hubWorld';
import type { HubWorld, WorldDevice, Written } from './helpers/hubWorld';
import { EventClient, ManualScheduler, callOn } from './helpers/sseReader';
import type { EventStream, Frame } from './helpers/sseReader';

// Phase 32, plan 21 (D-35, D-37, D-43, D-46, D-58): the hub's event streams. A device holding a session keeps one stream per project open on its
// session's connection and hears at once when heads move, when the roster changes and when a device equivocates, each only if it may see that part
// of the project. Every state a stream can be in is tested through the real routes on a real TLS server. All names and data are fictional.

const note = (world: HubWorld, device: WorldDevice, extra: { stream?: string; text?: string; seq?: number } = {}): Written =>
  world.write(device, {
    kind: 'note.add',
    data: { text: extra.text ?? 'Fictional note' },
    ...(extra.stream === undefined ? {} : { stream: extra.stream }),
    ...(extra.seq === undefined ? {} : { seq: extra.seq }),
  });

interface Team {
  world: HubWorld;
  /** A member granted the base cell only. */
  analyst: WorldDevice;
  /** A member granted the base cell and the ops label cell. */
  officer: WorldDevice;
  ops: string;
}

/** The world's project with an analyst and an officer (the officer also holds the ops label cell), enrolled over HTTPS. */
async function team(hub: Hub, setup?: (world: HubWorld) => void): Promise<Team> {
  const world = createHubWorld();
  world.admitHub(hub.identity);
  const analyst = world.device('ANALYST', 'mbr-analyst');
  const officer = world.device('OFFICER', 'mbr-officer');
  world.admitMember(analyst);
  world.admitMember(officer);
  const ops = world.labelCell('ops', [world.lead, officer]);
  setup?.(world);
  const enrolled = await hub.enrolProject(world);
  assert.equal(enrolled?.status, 201, enrolled?.text ?? 'no answer');
  return { world, analyst, officer, ops: ops.cell };
}

/** Appends entries over a fresh session of the pushing device and checks they were accepted. */
async function append(hub: Hub, world: HubWorld, device: WorldDevice, written: readonly Written[]): Promise<Record<string, unknown>> {
  const session = await hub.openSession(device, world.project);
  try {
    const answer = await session.connection.post(`/v1/projects/${world.project}/append`, { entries: written.map((item) => item.entry) }, session.token);
    assert.equal(answer.status, 200, answer.text);
    return answer.json();
  } finally {
    session.connection.close();
  }
}

const withLive = (options: StartOptions, body: (hub: Hub, scheduler: ManualScheduler) => Promise<void>): Promise<void> => {
  const scheduler = new ManualScheduler();
  return withHub({ ...options, scheduler }, async (hub) => {
    scheduler.onAdvance = (ms) => hub.advance(ms);
    await body(hub, scheduler);
  });
};

test('tracer: one append by device B reaches device A as a heads event with id 1 on a stream that opened with a jittered retry line', () =>
  withLive({}, async (hub) => {
    const { world, analyst } = await team(hub);
    const reader = await EventClient.open(hub, world.lead, world.project);
    const stream = await reader.events();
    assert.equal(stream.status, 200);
    assert.match(String(stream.headers['content-type']), /^text\/event-stream/);
    assert.equal(stream.headers['cache-control'], 'no-store');
    await stream.until((item) => item.retries.length === 1, 'the retry line');
    const retry = stream.retries[0] as number;
    assert.ok(Number.isInteger(retry) && retry >= 2000 && retry < 4000, `retry ${retry}`);

    const written = note(world, analyst);
    const answer = await append(hub, world, analyst, [written]);
    assert.deepEqual(answer.accepted, [written.hash]);

    const frame = await stream.frame(1);
    assert.deepEqual(frame, {
      event: 'heads',
      id: '1',
      data: { project: world.project, stream: world.project, heads: [{ writer: analyst.writer, seq: written.seq, hash: written.hash }] },
    });
    assert.equal(stream.frames.length, 1);
    assert.equal(stream.ended, false);
  }));

test('tracer: the pushing device hears nothing of its own append, and an append with no stream open anywhere is no error', () =>
  withLive({}, async (hub) => {
    const { world, analyst, officer } = await team(hub);
    // Nobody has a stream open: the append is answered as always.
    const first = note(world, officer);
    assert.deepEqual((await append(hub, world, officer, [first])).accepted, [first.hash]);

    // The officer opens a stream and appends: the lead's stream (opened later) gets the analyst's head only.
    const officerReader = await EventClient.open(hub, officer, world.project);
    const officerStream = await officerReader.events();
    const leadReader = await EventClient.open(hub, world.lead, world.project);
    const leadStream = await leadReader.events();
    const own = note(world, officer);
    assert.deepEqual((await append(hub, world, officer, [own])).accepted, [own.hash]);
    const theirs = note(world, analyst);
    assert.deepEqual((await append(hub, world, analyst, [theirs])).accepted, [theirs.hash]);

    const toLead = await leadStream.frame(2);
    assert.equal((leadStream.frames[0]?.data as { heads: Array<{ writer: string }> }).heads[0]?.writer, officer.writer);
    assert.equal((toLead.data as { heads: Array<{ writer: string }> }).heads[0]?.writer, analyst.writer);
    const toOfficer = await officerStream.frame(1);
    assert.deepEqual(toOfficer.data, { project: world.project, stream: world.project, heads: [{ writer: analyst.writer, seq: theirs.seq, hash: theirs.hash }] });
    assert.equal(officerStream.frames.length, 1, 'the officer heard of its own append');
  }));


// ---- Task 2: every stream state and audience, limits, 204, budget and resync, the checkpoint ask route ----

/** Waits (real time) until the condition holds. */
async function eventually(condition: () => boolean, what: string, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!condition()) {
    assert.ok(Date.now() < until, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const framesOf = (stream: EventStream, event: string): Frame[] => stream.frames.filter((frame) => frame.event === event);

test('open: frames on one connection are numbered 1, 2, 3 with no gap, a reconnect starts again at 1, and Last-Event-ID changes nothing', () =>
  withLive({}, async (hub) => {
    const { world, analyst } = await team(hub);
    const first = await EventClient.open(hub, world.lead, world.project);
    const stream = await first.events({ headers: { 'last-event-id': '99' } });
    assert.equal(stream.status, 200);
    for (let index = 0; index < 3; index += 1) await append(hub, world, analyst, [note(world, analyst)]);
    await stream.frame(3);
    assert.deepEqual(stream.frames.map((frame) => frame.id), ['1', '2', '3']);
    assert.deepEqual(stream.frames.map((frame) => frame.event), ['heads', 'heads', 'heads']);
    first.close();
    await eventually(() => hub.events.size === 0, 'the closed stream to leave the registry');

    const again = await EventClient.open(hub, world.lead, world.project);
    const reopened = await again.events({ headers: { 'last-event-id': '3' } });
    const next = note(world, analyst);
    await append(hub, world, analyst, [next]);
    const frame = await reopened.frame(1);
    assert.equal(frame.id, '1');
    assert.deepEqual(frame.data, { project: world.project, stream: world.project, heads: [{ writer: analyst.writer, seq: next.seq, hash: next.hash }] });
  }));

test('replaced: a second stream for the same device and project ends the first, which receives no further frame', () =>
  withLive({}, async (hub) => {
    const { world, analyst } = await team(hub);
    const older = await (await EventClient.open(hub, world.lead, world.project)).events();
    assert.equal(older.status, 200);
    const newer = await (await EventClient.open(hub, world.lead, world.project)).events();
    assert.equal(newer.status, 200);
    await older.end();
    assert.equal(hub.events.size, 1);
    const written = note(world, analyst);
    await append(hub, world, analyst, [written]);
    const frame = await newer.frame(1);
    assert.equal(frame.id, '1');
    assert.equal(older.frames.length, 0, 'the replaced stream received a frame');
  }));

test('429: a fifth stream of one device across projects is refused with Retry-After, while replacing one of its four is still allowed', () =>
  withLive({}, async (hub) => {
    const worlds: HubWorld[] = [];
    for (let index = 0; index < 5; index += 1) {
      // The same lead label in every world: one device, five projects.
      const world = createHubWorld({ projectLabel: `northwind-${index}` });
      world.admitHub(hub.identity);
      assert.equal((await hub.enrolProject(world))?.status, 201);
      worlds.push(world);
    }
    const streams: EventStream[] = [];
    for (const world of worlds.slice(0, LIMITS.eventStreamsPerDevice)) {
      const stream = await (await EventClient.open(hub, world.lead, world.project)).events();
      assert.equal(stream.status, 200);
      streams.push(stream);
    }
    const fifth = worlds[4] as HubWorld;
    const refused = await (await EventClient.open(hub, fifth.lead, fifth.project)).events();
    assert.equal(refused.status, 429);
    assert.equal(refused.headers['retry-after'], String(EVENT_TIMING.retryAfterSeconds));
    await refused.end();
    assert.equal(JSON.parse(refused.body).error, 'too-many-streams');
    assert.equal(hub.events.size, 4);

    const firstWorld = worlds[0] as HubWorld;
    const replacing = await (await EventClient.open(hub, firstWorld.lead, firstWorld.project)).events();
    assert.equal(replacing.status, 200);
    await (streams[0] as EventStream).end();
    assert.equal(hub.events.size, 4);
  }));

// The cap per address is 300 (LIMITS); this test sets it to D-37's 32 so a whole cap of streams stays cheap to open.
const ADDRESS_CAP = 32;

test('429: a stream past the address\'s cap (32 here) is refused with Retry-After', () =>
  withLive({ eventStreamsPerAddress: ADDRESS_CAP }, async (hub) => {
    const world = createHubWorld();
    world.admitHub(hub.identity);
    const members: WorldDevice[] = [];
    for (let index = 0; index < ADDRESS_CAP; index += 1) {
      const member = world.device(`MEMBER-${index}`, `mbr-member-${index}`);
      world.admitMember(member);
      members.push(member);
    }
    assert.equal((await hub.enrolProject(world))?.status, 201);
    const devices = [world.lead, ...members];
    for (const device of devices.slice(0, ADDRESS_CAP)) {
      const stream = await (await EventClient.open(hub, device, world.project)).events();
      assert.equal(stream.status, 200);
    }
    assert.equal(hub.events.size, ADDRESS_CAP);
    const last = devices[ADDRESS_CAP] as WorldDevice;
    const refused = await (await EventClient.open(hub, last, world.project)).events();
    assert.equal(refused.status, 429);
    assert.equal(refused.headers['retry-after'], String(EVENT_TIMING.retryAfterSeconds));
    assert.equal(hub.events.size, ADDRESS_CAP);
  }));

test('a site behind one address: 40 devices each hold a stream with the hub\'s own limits, past the 32 of D-37 (DESIGN 10.9 targets 300)', () =>
  withLive({}, async (hub) => {
    assert.equal(LIMITS.eventStreamsPerAddress, 300);
    const world = createHubWorld();
    world.admitHub(hub.identity);
    const members: WorldDevice[] = [];
    for (let index = 0; index < 39; index += 1) {
      const member = world.device(`SITE-${index}`, `mbr-site-${index}`);
      world.admitMember(member);
      members.push(member);
    }
    assert.equal((await hub.enrolProject(world))?.status, 201);
    for (const device of [world.lead, ...members]) {
      const stream = await (await EventClient.open(hub, device, world.project)).events();
      assert.equal(stream.status, 200, `stream ${hub.events.size + 1} from the one address was refused`);
    }
    assert.equal(hub.events.size, 40);
  }));

/** A refused stream request: 204, no body, nothing in the registry. */
async function expect204(hub: Hub, stream: EventStream): Promise<void> {
  assert.equal(stream.status, 204);
  await stream.end();
  assert.equal(stream.body, '');
  assert.equal(stream.frames.length, 0);
  assert.equal(hub.events.size, 0);
}

test('204: an expired token gets 204 with no body', () =>
  withLive({}, async (hub) => {
    const { world } = await team(hub);
    const client = await EventClient.open(hub, world.lead, world.project);
    hub.advance(TOKEN_TTL_MS + 1);
    await expect204(hub, await client.events());
  }));

test('204: an unknown token gets 204 with no body, and no token at all is 401', () =>
  withLive({}, async (hub) => {
    const { world } = await team(hub);
    const client = await EventClient.open(hub, world.lead, world.project);
    await expect204(hub, await client.events({ token: 'A'.repeat(43) }));
    const bare = await callOn(client.connection, hub.port, 'GET', `/v1/projects/${world.project}/events`);
    assert.equal(bare.status, 401);
    assert.equal(bare.json().reason, 'no-token');
    assert.equal((await client.call('POST', `/v1/projects/${world.project}/events`)).status, 405);
  }));

test('204: a token from another TLS connection gets 204 with no body', () =>
  withLive({}, async (hub) => {
    const { world, analyst } = await team(hub);
    const owner = await EventClient.open(hub, world.lead, world.project);
    const other = await EventClient.open(hub, analyst, world.project);
    await expect204(hub, await other.events({ token: owner.token }));
  }));

test('204: a device the roster revoked since its session opened gets 204 with no body', () =>
  withLive({}, async (hub) => {
    const { world, analyst } = await team(hub);
    const client = await EventClient.open(hub, analyst, world.project);
    const revoke = world.rosterEntry(world.lead, 'device.revoke', { member: analyst.member, writer: analyst.writer });
    await append(hub, world, world.lead, [revoke]);
    await expect204(hub, await client.events());
  }));

test('204: a quarantined device gets 204 with no body', () =>
  withLive({}, async (hub) => {
    const { world, analyst } = await team(hub);
    const client = await EventClient.open(hub, analyst, world.project);
    await append(hub, world, analyst, [note(world, analyst)]);
    const fork = note(world, analyst, { seq: 0 });
    const forked = await append(hub, world, analyst, [fork]);
    assert.deepEqual((forked.refused as Array<{ reason: string }>).map((item) => item.reason), ['equivocation']);
    await expect204(hub, await client.events());
  }));

test('ended by the client: closing the connection takes the stream out of the registry, and later appends are answered as always', () =>
  withLive({}, async (hub) => {
    const { world, analyst } = await team(hub);
    const client = await EventClient.open(hub, world.lead, world.project);
    const stream = await client.events();
    assert.equal(stream.status, 200);
    assert.equal(hub.events.size, 1);
    stream.close();
    await eventually(() => hub.events.size === 0, 'the registry to drop the stream');
    const written = note(world, analyst);
    assert.deepEqual((await append(hub, world, analyst, [written])).accepted, [written.hash]);
  }));

test('ended on revoke: a roster entry revoking the device closes its open stream, and a new request on that connection gets 204', () =>
  withLive({}, async (hub) => {
    const { world, analyst } = await team(hub);
    const client = await EventClient.open(hub, analyst, world.project);
    const stream = await client.events();
    const lead = await (await EventClient.open(hub, world.lead, world.project)).events();
    const revoke = world.rosterEntry(world.lead, 'device.revoke', { member: analyst.member, writer: analyst.writer });
    await append(hub, world, world.lead, [revoke]);
    await stream.end();
    assert.equal(stream.frames.length, 0, 'the revoked device heard of its own revocation');
    await lead.until((item) => framesOf(item, 'roster').length === 1, 'the roster event to the lead');
    assert.equal(hub.events.size, 1);
    const again = await client.events();
    assert.equal(again.status, 204);
    await again.end();
    assert.equal(again.body, '');
  }));

test('ended on equivocation: the stream of a device that signs two entries at one place closes, and a new request gets 204', () =>
  withLive({}, async (hub) => {
    const { world, officer, ops } = await team(hub);
    const client = await EventClient.open(hub, officer, world.project);
    const stream = await client.events();
    const first = note(world, officer, { stream: ops });
    await append(hub, world, officer, [first]);
    const fork = note(world, officer, { stream: ops, seq: first.seq });
    await append(hub, world, officer, [fork]);
    await stream.end();
    assert.equal(framesOf(stream, 'equivocation').length, 0);
    const again = await client.events();
    assert.equal(again.status, 204);
    await again.end();
  }));

test('keep-alive: the stream receives a comment line every 15 seconds and nothing else', () =>
  withLive({}, async (hub, scheduler) => {
    const { world } = await team(hub);
    const stream = await (await EventClient.open(hub, world.lead, world.project)).events();
    await stream.until((item) => item.retries.length === 1, 'the retry line');
    scheduler.advance(EVENT_TIMING.keepAliveMs - 1);
    scheduler.advance(1);
    await stream.until((item) => item.comments.length === 1, 'the first comment');
    scheduler.advance(EVENT_TIMING.keepAliveMs);
    await stream.until((item) => item.comments.length === 2, 'the second comment');
    assert.ok(stream.comments.every((line) => line.startsWith(':')));
    assert.equal(stream.frames.length, 0);
    assert.equal(stream.retries.length, 1);
    assert.equal(stream.ended, false);
  }));

test('keep-alive: a stream whose session token has expired ends at the next keep-alive tick', () =>
  withLive({}, async (hub, scheduler) => {
    const { world } = await team(hub);
    const stream = await (await EventClient.open(hub, world.lead, world.project)).events();
    scheduler.advance(TOKEN_TTL_MS - EVENT_TIMING.keepAliveMs);
    assert.equal(stream.ended, false);
    scheduler.advance(EVENT_TIMING.keepAliveMs);
    await stream.end();
    assert.equal(hub.events.size, 0);
  }));

test('keep-alive: a stream whose roster is not held in memory checks the stored roster at the next tick and ends when the device was revoked', () =>
  withLive({}, async (hub, scheduler) => {
    const { world, analyst } = await team(hub);
    const stream = await (await EventClient.open(hub, analyst, world.project)).events();
    assert.equal(stream.status, 200);
    await stream.until((item) => item.retries.length === 1, 'the retry line');
    // The revoke reaches the store without the append route (which ends the stream itself), and the roster cache is dropped, as the append
    // checks do when a batch was checked against a roster that is no longer the cached one.
    const revoke = world.rosterEntry(world.lead, 'device.revoke', { member: analyst.member, writer: analyst.writer });
    hub.store.commitAppend(world.project, { entries: [{ header: canonicalize(revoke.entry.header), body: revoke.entry.body, receivedAt: hub.now() }], at: hub.now() });
    hub.cache.invalidate(world.project);
    assert.equal(hub.cache.peek(world.project), undefined);
    scheduler.advance(EVENT_TIMING.keepAliveMs);
    await stream.end(2000);
    assert.equal(hub.events.size, 0);
  }));

test('keep-alive: a stream whose roster is not held in memory stays open at the next tick when the device is still admitted', () =>
  withLive({}, async (hub, scheduler) => {
    const { world, analyst } = await team(hub);
    const stream = await (await EventClient.open(hub, analyst, world.project)).events();
    await stream.until((item) => item.retries.length === 1, 'the retry line');
    hub.cache.invalidate(world.project);
    scheduler.advance(EVENT_TIMING.keepAliveMs);
    await stream.until((item) => item.comments.length === 1, 'a keep-alive comment', 2000);
    assert.equal(stream.ended, false);
    assert.equal(hub.events.size, 1);
  }));

test('audience: a device off a label cell hears nothing of that cell\'s stream while a device on it does', () =>
  withLive({}, async (hub) => {
    const { world, analyst, officer, ops } = await team(hub);
    const analystStream = await (await EventClient.open(hub, analyst, world.project)).events();
    const officerStream = await (await EventClient.open(hub, officer, world.project)).events();
    const secret = note(world, world.lead, { stream: ops });
    await append(hub, world, world.lead, [secret]);
    const open = note(world, world.lead);
    await append(hub, world, world.lead, [open]);
    // The base-stream event is the marker: frames on one stream arrive in order, so nothing about ops came before it.
    await analystStream.frame(1);
    await officerStream.frame(2);
    assert.deepEqual(analystStream.frames.map((frame) => (frame.data as { stream: string }).stream), [world.project]);
    assert.deepEqual(officerStream.frames.map((frame) => (frame.data as { stream: string }).stream), [ops, world.project]);
    assert.deepEqual((officerStream.frames[0]?.data as { heads: unknown }).heads, [{ writer: world.lead.writer, seq: secret.seq, hash: secret.hash }]);
  }));

test('audience: a roster append sends roster {project, head} to every admitted device', () =>
  withLive({}, async (hub) => {
    const { world, analyst, officer } = await team(hub);
    const streams = [];
    for (const device of [world.lead, analyst, officer]) streams.push(await (await EventClient.open(hub, device, world.project)).events());
    const named = world.rosterEntry(world.lead, 'deputy.name', { member: officer.member });
    const answer = await append(hub, world, world.lead, [named]);
    assert.equal(answer.rosterHead, named.hash);
    for (const stream of streams) {
      await stream.until((item) => framesOf(item, 'roster').length === 1, 'the roster event');
      assert.deepEqual(framesOf(stream, 'roster')[0]?.data, { project: world.project, head: named.hash });
    }
  }));

test('audience: an equivocation goes to the stream\'s access list and the lead\'s and deputy\'s devices only, with both headers', () =>
  withLive({}, async (hub) => {
    let specialist: WorldDevice | undefined;
    let deputy: WorldDevice | undefined;
    let plans = '';
    const { world, analyst, officer } = await team(hub, (built) => {
      specialist = built.device('SPECIALIST', 'mbr-specialist');
      deputy = built.device('DEPUTY', 'mbr-deputy');
      built.admitMember(specialist);
      built.admitMember(deputy);
      built.rosterEntry(built.lead, 'deputy.name', { member: deputy.member });
      // The officer's device comes from its label alone, so this is the same device team() admitted.
      plans = built.labelCell('plans', [built.lead, built.device('OFFICER', 'mbr-officer'), specialist]).cell;
    });
    assert.ok(specialist !== undefined && deputy !== undefined);
    const listeners = new Map<string, EventStream>();
    for (const device of [world.lead, analyst, officer, specialist, deputy]) listeners.set(device.label, await (await EventClient.open(hub, device, world.project)).events());

    const first = note(world, officer, { stream: plans });
    await append(hub, world, officer, [first]);
    const fork = note(world, officer, { stream: plans, seq: first.seq });
    await append(hub, world, officer, [fork]);
    const marker = note(world, world.lead);
    await append(hub, world, world.lead, [marker]);

    for (const label of ['LEAD', 'SPECIALIST', 'DEPUTY']) {
      const stream = listeners.get(label) as EventStream;
      await stream.until((item) => framesOf(item, 'equivocation').length === 1, `the equivocation event to ${label}`);
      const data = framesOf(stream, 'equivocation')[0]?.data as { project: string; stream: string; writer: string; seq: number; proof: { a: unknown; b: unknown; publicKey: string } };
      assert.deepEqual({ project: data.project, stream: data.stream, writer: data.writer, seq: data.seq }, { project: world.project, stream: plans, writer: officer.writer, seq: first.seq });
      assert.deepEqual(new Set([JSON.stringify(data.proof.a), JSON.stringify(data.proof.b)]), new Set([JSON.stringify(first.entry.header), JSON.stringify(fork.entry.header)]));
      assert.equal(data.proof.publicKey, officer.publicKey);
    }
    const outside = listeners.get('ANALYST') as EventStream;
    await outside.until((item) => item.frames.some((frame) => (frame.data as { stream?: string }).stream === world.project && frame.event === 'heads'), 'the marker to the analyst');
    assert.equal(framesOf(outside, 'equivocation').length, 0, 'a device off the cell heard of the equivocation');
    await (listeners.get('OFFICER') as EventStream).end();
  }));

const FLOOD_DATA = (project: string): Record<string, unknown> => ({ project, stream: project, heads: [], pad: 'x'.repeat(8000) });

/**
 * Publishes bulky frames straight through the registry while the reader is paused. With yieldEvery the event loop runs between frames, so the
 * kernel's socket buffers (several MiB on loopback) fill first; without it every frame is published in one turn, as a burst of appends would be.
 * Stops after bytes, or with untilOverflow once the stream's budget has run out.
 */
async function flood(hub: Hub, project: string, options: { bytes: number; yieldEvery?: number; untilOverflow?: boolean }): Promise<{ count: number; frameBytes: number; peak: number }> {
  const data = FLOOD_DATA(project);
  const frameBytes = Buffer.byteLength(`event: heads\nid: 10000\ndata: ${JSON.stringify(data)}\n\n`);
  let count = 0;
  let peak = 0;
  while (count * frameBytes < options.bytes) {
    if (options.untilOverflow === true && hub.events.stats()[0]?.overflowed === true) break;
    hub.events.publish(project, () => true, 'heads', data);
    count += 1;
    peak = Math.max(peak, hub.events.unsentBytes());
    if (options.yieldEvery !== undefined && count % options.yieldEvery === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return { count, frameBytes, peak };
}

/**
 * Fills the kernel's socket buffers of a paused reader until they stop growing: frames are published while the hub holds less than half its
 * budget, and the fill ends once the unsent bytes have not moved for 300 ms (the send and receive buffers are full and no longer grow; TCP
 * autotuning can keep growing them for a while on some hosts, as on CI). Stays under the budget, so nothing overflows here. Gives up after 20 s.
 */
async function fillSocketBuffers(hub: Hub, project: string): Promise<void> {
  const data = FLOOD_DATA(project);
  const started = Date.now();
  let still = 0;
  let last = -1;
  while (still < 10 && Date.now() - started < 20_000) {
    while (hub.events.unsentBytes() < EVENT_BUDGET_BYTES / 2) hub.events.publish(project, () => true, 'heads', data);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const now = hub.events.unsentBytes();
    still = now === last ? still + 1 : 0;
    last = now;
  }
  assert.equal(hub.events.stats()[0]?.overflowed, false, 'the fill stays under the budget');
}

test('resync: a paused reader sent 2 MiB gets at most the 1 MiB budget plus one frame of queued data, then resync, then the end of the stream', () =>
  withLive({}, async (hub) => {
    const { world } = await team(hub);
    const stream = await (await EventClient.open(hub, world.lead, world.project)).events();
    await stream.until((item) => item.retries.length === 1, 'the retry line');
    stream.pause();
    const published = await flood(hub, world.project, { bytes: 2 * 1024 * 1024 });
    assert.ok(published.peak <= EVENT_BUDGET_BYTES + published.frameBytes, `unsent bytes reached ${published.peak}`);
    const [only] = hub.events.stats();
    assert.ok(only !== undefined);
    assert.equal(only.overflowed, true);
    assert.ok(only.queuedAtOverflow <= EVENT_BUDGET_BYTES + published.frameBytes, `${only.queuedAtOverflow} bytes were queued when the budget ran out`);

    // Real time passes while the reader is still paused: the hub hands the queue on as the socket takes it, and nothing more is queued.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(hub.events.peakUnsentBytes() <= EVENT_BUDGET_BYTES + published.frameBytes, `the peak was ${hub.events.peakUnsentBytes()}`);

    stream.resume();
    await stream.end(15_000);
    const last = stream.frames[stream.frames.length - 1];
    assert.deepEqual(last, { event: 'resync', id: String(stream.frames.length), data: { project: world.project } });
    assert.deepEqual(stream.frames.map((frame) => frame.id), stream.frames.map((_, index) => String(index + 1)), 'the ids have a gap');
    const heads = framesOf(stream, 'heads').length;
    assert.ok(heads < published.count, `all ${published.count} frames were delivered`);
    // What the reader got is what the hub had handed to the socket when the budget ran out, plus at most the budget and one frame.
    assert.ok(stream.bytes <= only.handedAtOverflow + EVENT_BUDGET_BYTES + published.frameBytes, `${stream.bytes} bytes arrived`);
    assert.equal(hub.events.size, 0);
  }));

test('resync: a reader that never reads again after its budget ran out is cut off 30 seconds later', () =>
  withLive({}, async (hub, scheduler) => {
    const { world } = await team(hub);
    const client = await EventClient.open(hub, world.lead, world.project);
    const stream = await client.events();
    await stream.until((item) => item.retries.length === 1, 'the retry line');
    stream.pause();
    // The kernel's buffers fill first, to where they stop growing, so the queue the budget ran out on stays with the hub.
    await fillSocketBuffers(hub, world.project);
    const published = await flood(hub, world.project, { bytes: 256 * 1024 * 1024, yieldEvery: 32, untilOverflow: true });
    assert.equal(hub.events.stats()[0]?.overflowed, true);
    assert.ok(hub.events.peakUnsentBytes() <= EVENT_BUDGET_BYTES + published.frameBytes);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok((hub.events.stats()[0]?.unsent ?? 0) > 0, 'the socket took the whole queue');
    scheduler.advance(EVENT_TIMING.stuckMs - 1);
    assert.equal(hub.events.size, 1);
    scheduler.advance(1);
    await eventually(() => hub.events.size === 0, 'the stuck stream to leave the registry');
    // A paused reader sees the close only once it reads again: what the socket held, then the end, and never the resync the hub still queued.
    stream.resume();
    assert.equal(await client.connection.closesWithin(15_000), true);
    assert.equal(framesOf(stream, 'resync').length, 0);
  }));

test('channel: every append that stores entries signals entries accepted for the project once; one that stores nothing does not', () =>
  withLive({}, async (hub) => {
    const { world, analyst } = await team(hub);
    const seen: string[] = [];
    const off = hub.events.channel.on('entries', (project) => seen.push(project));
    const written = note(world, analyst);
    await append(hub, world, analyst, [written]);
    assert.deepEqual(seen, [world.project]);
    await append(hub, world, analyst, [written]);
    assert.deepEqual(seen, [world.project]);
    off();
    await append(hub, world, analyst, [note(world, analyst)]);
    assert.deepEqual(seen, [world.project]);
  }));

const ORDER_TIP = 'ab'.repeat(32);

/** A version 2 checkpoint over the base stream naming the lead's head, signed by signer. */
function checkpointFor(world: HubWorld, signer: { signer: PayloadSigner; writer: string }, head: Written, count: number, project = world.project): SignedCheckpoint {
  const checkpoint: Checkpoint = {
    type: 'checkpoint',
    v: 2,
    project,
    signer: signer.writer,
    rosterHead: world.head,
    streams: [{ stream: world.project, heads: [{ writer: head.writer, seq: head.seq, hash: head.hash, lamport: count, roster: world.head }], count, orderTip: ORDER_TIP }],
  };
  return signCheckpoint(signer.signer, checkpoint);
}

test('checkpoint: one signed by this hub for this project that the store lacks is kept, the latest is returned, and the channel hears one ask per request', () =>
  withLive({}, async (hub) => {
    const { world } = await team(hub);
    const asks: string[] = [];
    hub.events.channel.on('checkpoint', (project) => asks.push(project));
    const head = note(world, world.lead);
    await append(hub, world, world.lead, [head]);
    const signed = checkpointFor(world, hub.identity, head, 7);
    const client = await EventClient.open(hub, world.lead, world.project);
    const answer = await client.call('POST', `/v1/projects/${world.project}/checkpoint`, { json: { known: [signed] } });
    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual(answer.json(), { project: world.project, kept: 1, checkpoint: signed });
    assert.deepEqual(hub.store.checkpoints(world.project).map((record) => record.hash), [checkpointHash(signed)]);
    assert.deepEqual(asks, [world.project]);

    // The same one again is held, not kept twice; an ask with nothing to hand back is answered with the latest.
    const again = await client.call('POST', `/v1/projects/${world.project}/checkpoint`, { json: { known: [signed] } });
    assert.deepEqual(again.json(), { project: world.project, kept: 0, checkpoint: signed });
    const bare = await client.call('POST', `/v1/projects/${world.project}/checkpoint`, { json: {} });
    assert.equal(bare.status, 200, bare.text);
    assert.equal(hub.store.checkpoints(world.project).length, 1);
    assert.deepEqual(asks, [world.project, world.project, world.project]);
  }));

test('checkpoint: one signed by another key or naming another project is 400 and nothing of the request is kept', () =>
  withLive({}, async (hub) => {
    const { world, analyst } = await team(hub);
    const asks: string[] = [];
    hub.events.channel.on('checkpoint', (project) => asks.push(project));
    const head = note(world, world.lead);
    await append(hub, world, world.lead, [head]);
    const good = checkpointFor(world, hub.identity, head, 3);
    const byLead = checkpointFor(world, world.lead, head, 4);
    const otherProject = checkpointFor(world, hub.identity, head, 5, streamOf('another-exercise'));
    const client = await EventClient.open(hub, analyst, world.project);
    for (const known of [[byLead], [otherProject], [good, byLead], [{ ...good, sig: byLead.sig }], ['not a checkpoint']]) {
      const answer = await client.call('POST', `/v1/projects/${world.project}/checkpoint`, { json: { known } });
      assert.equal(answer.status, 400, answer.text);
      assert.equal(answer.json().error, 'checkpoint-refused');
      assert.doesNotMatch(answer.text, new RegExp(byLead.sig));
    }
    const tooMany = await client.call('POST', `/v1/projects/${world.project}/checkpoint`, { json: { known: Array.from({ length: 17 }, () => good) } });
    assert.equal(tooMany.status, 413);
    assert.equal((await client.call('POST', `/v1/projects/${world.project}/checkpoint`, { json: { known: 'all' } })).status, 400);
    assert.deepEqual(hub.store.checkpoints(world.project), []);
    assert.deepEqual(asks, []);
  }));

test('checkpoint: a handed-back checkpoint covering less than one the hub holds is kept as evidence but never becomes the latest', () =>
  withLive({}, async (hub) => {
    const { world } = await team(hub);
    const head = note(world, world.lead);
    await append(hub, world, world.lead, [head]);
    const newer = checkpointFor(world, hub.identity, head, 10);
    const older = checkpointFor(world, hub.identity, head, 6);
    const client = await EventClient.open(hub, world.lead, world.project);
    assert.equal((await client.call('POST', `/v1/projects/${world.project}/checkpoint`, { json: { known: [newer] } })).json().kept, 1);
    hub.advance(60_000);
    const answer = await client.call('POST', `/v1/projects/${world.project}/checkpoint`, { json: { known: [older] } });
    assert.deepEqual(answer.json(), { project: world.project, kept: 1, checkpoint: newer });
    assert.equal(hub.store.checkpoints(world.project).length, 2);
    const heads = await client.call('GET', `/v1/projects/${world.project}/heads`);
    assert.deepEqual(heads.json().checkpoint, newer);
  }));
