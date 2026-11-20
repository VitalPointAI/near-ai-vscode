import assert from 'node:assert/strict';
import test from 'node:test';
import { withHub } from './helpers/hubHarness';
import type { Hub, StartOptions } from './helpers/hubHarness';
import { createHubWorld } from './helpers/hubWorld';
import type { HubWorld, WorldDevice, Written } from './helpers/hubWorld';
import { EventClient, ManualScheduler } from './helpers/sseReader';

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
