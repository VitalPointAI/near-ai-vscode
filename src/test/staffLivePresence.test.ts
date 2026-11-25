// Live presence (Phase 33, 33-12 Tasks 1 and 2; D-18, D-21, D-35; Pitfall 10): heartbeats sealed per cell through the replicator's transport, the
// people list from this device's roster, last seen after the time to live or a leave, and no product name below its cell. The transport is a
// recorder that hands each post to the other devices as the hub's presence frame would. Fictional people and data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createWitness } from '../domain/replica/hubWitness';
import { openPresence } from '../domain/replica/presence';
import type { SyncLocal } from '../staff/replica/hubSync';
import { LiveReplicator } from '../staff/replica/liveReplicator';
import type { LiveTransport } from '../staff/replica/liveReplicator';
import { presenceText } from '../domain/staff/liveSentences';
import { CURSOR_MAX_PER_SECOND, HEARTBEAT_MS, LivePresence, PRESENCE_TTL_MS } from '../staff/replica/livePresence';
import type { LivePresenceOptions, PresencePerson, PresenceRoster } from '../staff/replica/livePresence';
import { FakeTimers, settle } from './helpers/liveWorld';
import { epochKey, streamId } from './helpers/replicaWorld';

const BASE = streamId('live-presence/base');
const CELL = streamId('live-presence/plans');
const PRODUCT = 'operations-plan';
const A = { writer: 'a'.repeat(64), member: 'mbr-avery' };
const B = { writer: 'b'.repeat(64), member: 'mbr-blake' };
const D = { writer: 'd'.repeat(64), member: 'mbr-dana' };
const KEYS = new Map([[`${BASE}/1`, epochKey('live-presence/base')], [`${CELL}/1`, epochKey('live-presence/plans')]]);

const roster: PresenceRoster = {
  memberOf: (writer) => [A, B, D].find((item) => item.writer === writer)?.member,
  person: (member) => ({ 'mbr-avery': { name: 'Avery Lead', position: 'J2 lead' }, 'mbr-blake': { name: 'Blake Rivers', position: 'J2 analyst' }, 'mbr-dana': { name: 'Dana Moss', position: 'J4 planner' } } as Record<string, { name: string; position: string }>)[member]
};

interface Post { cell: string; sealed?: string; leave?: boolean; from: string }

/** A small hub: every post is kept and relayed as a presence frame to the devices that hold the cell. */
function relay(): { posts: Post[]; devices: Map<string, { presence: LivePresence; cells: string[]; frames: Array<Record<string, unknown>> }>; deliver(): void } {
  const posts: Post[] = [];
  const devices = new Map<string, { presence: LivePresence; cells: string[]; frames: Array<Record<string, unknown>> }>();
  return {
    posts,
    devices,
    deliver() {
      for (const post of posts.splice(0)) {
        for (const [writer, device] of devices) {
          if (writer === post.from || !device.cells.includes(post.cell)) continue;
          const frame = { project: BASE, cell: post.cell, devices: post.sealed === undefined ? [] : [{ writer: post.from, sealed: post.sealed }], left: post.leave === true ? [post.from] : [] };
          device.frames.push(frame);
          device.presence.receive(frame);
        }
      }
    }
  };
}

function device(hub: ReturnType<typeof relay>, who: { writer: string; member: string }, cells: string[], timers: FakeTimers, extra: Partial<LivePresenceOptions> = {}): { presence: LivePresence; people: PresencePerson[][] } {
  const people: PresencePerson[][] = [];
  const presence = new LivePresence({
    send: {
      postPresence: (cell, sealed) => { hub.posts.push({ cell, sealed, from: who.writer }); return Promise.resolve(); },
      leavePresence: (cell) => { hub.posts.push({ cell, leave: true, from: who.writer }); return Promise.resolve(); }
    },
    writer: who.writer,
    member: who.member,
    baseCell: BASE,
    position: () => roster.person(who.member)?.position,
    cells: () => cells.map((cell) => ({ cell, epoch: 1 })),
    keyFor: (cell, epoch) => (cells.includes(cell) ? KEYS.get(`${cell}/${epoch}`) : undefined),
    roster: () => roster,
    setPeople: (rows) => people.push(rows),
    now: () => timers.now(),
    timers,
    ...extra
  });
  hub.devices.set(who.writer, { presence, cells, frames: [] });
  return { presence, people };
}

const lastOf = <T>(rows: readonly T[]): T => rows[rows.length - 1] as T;

test('tracer: A\'s sealed heartbeat reaches B, who lists A live with the name and position from B\'s roster; A leaving shows last seen', async () => {
  const timers = new FakeTimers();
  const hub = relay();
  const a = device(hub, A, [BASE], timers);
  const b = device(hub, B, [BASE], timers);
  a.presence.start();
  await settle();
  hub.deliver();
  assert.deepEqual(lastOf(b.people), [{ member: A.member, name: 'Avery Lead', position: 'J2 lead', live: true, lastSeen: timers.now() }]);
  await a.presence.stop();
  timers.advance(1000);
  hub.deliver();
  const after = lastOf(b.people)[0] as PresencePerson;
  assert.deepEqual([after.live, after.lastSeen], [false, timers.now()]);
});

test('a heartbeat goes every HEARTBEAT_MS, and a person not heard from for the time to live shows last seen', async () => {
  const timers = new FakeTimers();
  const hub = relay();
  const a = device(hub, A, [BASE], timers);
  const b = device(hub, B, [BASE], timers);
  a.presence.start();
  b.presence.start();
  await settle();
  hub.deliver();
  const seenAt = timers.now();
  const before = hub.posts.length;
  await timers.advance(HEARTBEAT_MS);
  assert.ok(hub.posts.length > before, 'a second heartbeat');
  hub.posts.length = 0;
  // A goes quiet (its heartbeats are lost); B's own heartbeat keeps checking the time to live.
  await a.presence.stop();
  hub.posts.length = 0;
  await timers.advance(PRESENCE_TTL_MS);
  const row = lastOf(b.people).find((item) => item.member === A.member) as PresencePerson;
  assert.deepEqual([row.live, row.lastSeen], [false, seenAt]);
  await b.presence.stop();
});

test('a frame whose member is not the roster\'s member of the sending device is dropped', () => {
  const timers = new FakeTimers();
  const hub = relay();
  const b = device(hub, B, [BASE], timers);
  // D's device claims to be Avery.
  const liar = device(hub, { writer: D.writer, member: A.member }, [BASE], timers);
  liar.presence.start();
  hub.deliver();
  assert.deepEqual(b.people, []);
});

test('a frame this device cannot open (no key for that cell) is dropped silently', async () => {
  const timers = new FakeTimers();
  const hub = relay();
  const a = device(hub, A, [BASE, CELL], timers);
  const b = device(hub, B, [BASE], timers);
  // The relay shows B the frames of CELL, though B holds no key for it.
  const record = hub.devices.get(B.writer);
  if (record !== undefined) record.cells = [BASE, CELL];
  a.presence.cursor(CELL, PRODUCT, 'AAEC', 'AAED');
  await settle();
  hub.deliver();
  assert.deepEqual(b.people, []);
  void b;
});

test('base cell: A works in P of cell C; B, who holds C, sees "Working on P"; D, who holds only the base cell, sees A live with no product, and no plaintext D opens names P', async () => {
  const timers = new FakeTimers();
  const hub = relay();
  const a = device(hub, A, [BASE, CELL], timers, { runningAgents: () => 2 });
  const b = device(hub, B, [BASE, CELL], timers);
  const d = device(hub, D, [BASE], timers);
  a.presence.cursor(CELL, PRODUCT, 'AAEC', 'AAED');
  a.presence.start();
  await settle();
  hub.deliver();
  const seenByB = lastOf(b.people).find((row) => row.member === A.member) as PresencePerson;
  assert.deepEqual([seenByB.product, seenByB.runs, seenByB.cursor], [PRODUCT, 2, { anchor: 'AAEC', head: 'AAED' }]);
  const seenByD = lastOf(d.people).find((row) => row.member === A.member) as PresencePerson;
  assert.deepEqual([seenByD.live, seenByD.product, seenByD.runs], [true, undefined, undefined]);
  const dFrames = hub.devices.get(D.writer)?.frames ?? [];
  assert.ok(dFrames.length > 0);
  for (const frame of dFrames) {
    for (const item of frame.devices as Array<{ writer: string; sealed: string }>) {
      const opened = openPresence((cell, epoch) => (cell === BASE ? KEYS.get(`${cell}/${epoch}`) : undefined), { cell: frame.cell as string, writer: item.writer }, item.sealed);
      assert.ok(opened !== undefined, 'D opens the base cell heartbeat');
      assert.equal(JSON.stringify(opened).includes(PRODUCT), false);
    }
  }
  await a.presence.stop();
});

test('with "Show others what I am working on" off, A sends heartbeats only, in every cell', async () => {
  const timers = new FakeTimers();
  const hub = relay();
  const a = device(hub, A, [BASE, CELL], timers, { showWork: () => false, runningAgents: () => 3 });
  const b = device(hub, B, [BASE, CELL], timers);
  a.presence.cursor(CELL, PRODUCT, 'AAEC', 'AAED');
  a.presence.start();
  await settle();
  hub.deliver();
  const row = lastOf(b.people).find((item) => item.member === A.member) as PresencePerson;
  assert.deepEqual([row.live, row.product, row.runs, row.cursor], [true, undefined, undefined, undefined]);
  await a.presence.stop();
});

test('cursor changes go at most CURSOR_MAX_PER_SECOND times a second', () => {
  const timers = new FakeTimers();
  const hub = relay();
  const a = device(hub, A, [BASE, CELL], timers);
  for (let index = 0; index < 25; index += 1) a.presence.cursor(CELL, PRODUCT, 'AAEC', `AAE${index % 10}`);
  assert.equal(hub.posts.length, CURSOR_MAX_PER_SECOND);
  timers.advance(1000);
  a.presence.cursor(CELL, PRODUCT, 'AAEC', 'AAED');
  assert.equal(hub.posts.length, CURSOR_MAX_PER_SECOND + 1, 'the next second allows more');
});

test('the people list keeps each person\'s newest message: an older sequence number never replaces a newer one', async () => {
  const timers = new FakeTimers();
  const hub = relay();
  const a = device(hub, A, [BASE, CELL], timers);
  const b = device(hub, B, [BASE, CELL], timers);
  a.presence.cursor(CELL, PRODUCT, 'AAEC', 'AAED');
  const first = hub.posts.splice(0);
  a.presence.idle();
  a.presence.start();
  await settle();
  hub.deliver();
  hub.posts.push(...first);
  hub.deliver();
  const row = lastOf(b.people).find((item) => item.member === A.member) as PresencePerson;
  assert.equal(row.cursor, undefined, 'the older cursor message was not taken');
  await a.presence.stop();
});

test('stop leaves every cell this device holds and forgets the people list; nothing is written to disk (the file has no write call)', async () => {
  const timers = new FakeTimers();
  const hub = relay();
  const a = device(hub, A, [BASE, CELL], timers);
  a.presence.start();
  await settle();
  hub.posts.length = 0;
  await a.presence.stop();
  assert.deepEqual(hub.posts.map((post) => [post.cell, post.leave]), [[BASE, true], [CELL, true]]);
  assert.equal(timers.pending, 0, 'no timer left');
  assert.deepEqual(a.presence.people(), []);
});

test('a message from a device the roster does not know is dropped', () => {
  const timers = new FakeTimers();
  const hub = relay();
  const b = device(hub, B, [BASE], timers);
  const stranger = device(hub, { writer: 'e'.repeat(64), member: 'mbr-stranger' }, [BASE], timers);
  stranger.presence.start();
  hub.deliver();
  assert.deepEqual(b.people, []);
});

test('the replicator passes presence through its one transport while live, and does nothing otherwise (33-12)', async () => {
  const posted: string[] = [];
  const project = BASE;
  const hubWriter = 'f'.repeat(64);
  const transport = {
    project, hub: hubWriter,
    hubHeads: () => Promise.resolve({ project, rosterHead: 'e'.repeat(64), streams: [], grants: [] }),
    entries: (stream: string, writer: string) => Promise.resolve({ project, stream, writer, entries: [], more: false, head: null }),
    append: () => Promise.reject(new Error('nothing to push')),
    getBlob: (hash: string) => Promise.resolve({ kind: 'missing', hash }),
    grant: (hash: string) => Promise.resolve({ kind: 'missing', hash }),
    askCheckpoint: () => Promise.resolve({ project, kept: 0 }),
    // A stream that stays open until the replicator closes it.
    events: () => {
      let end: () => void = () => undefined;
      const ended = new Promise<void>((resolve) => { end = resolve; });
      return Promise.resolve({ retryMs: undefined, close: () => end(), async *[Symbol.asyncIterator]() { await ended; } });
    },
    postPresence: (cell: string, sealed: string) => { posted.push(`post ${cell} ${sealed}`); return Promise.resolve(); },
    leavePresence: (cell: string) => { posted.push(`leave ${cell}`); return Promise.resolve(); },
    close: () => undefined
  };
  const view = { hasRoster: () => true, rosterPosition: () => 0, deviceKey: () => undefined, isAdmitted: () => true, memberName: () => undefined, hasRole: () => false, roleWithdrawnBy: () => undefined, chosenBranch: () => undefined, checkpointSigner: () => false };
  const local: SyncLocal = {
    project, writer: A.writer,
    roster: () => Promise.resolve(view),
    heads: () => Promise.resolve([]), head: () => Promise.resolve(undefined), holds: () => Promise.resolve(new Set<string>()), entriesAfter: () => Promise.resolve([]),
    blob: () => Promise.resolve(undefined), wantedBlobs: () => Promise.resolve([]), blobsCitedBy: () => Promise.resolve([]), grants: () => Promise.resolve([]),
    ingest: () => Promise.resolve({ added: 0, notStored: 0 }), putGrants: () => Promise.resolve(), checkpoints: () => Promise.resolve([]), putCheckpoint: () => Promise.resolve()
  };
  const timers = new FakeTimers();
  const replicator = new LiveReplicator({
    local, memory: { load: (hub, p) => Promise.resolve(createWitness(hub, p)), save: () => Promise.resolve() },
    hub: { id: 'hub-main', writer: hubWriter, certPin: 'c'.repeat(64) }, address: () => Promise.resolve('127.0.0.1:9'), signer: { fingerprint: 'x', publicKey: 'y', sign: () => 'z' },
    open: () => transport as unknown as LiveTransport, timers, now: () => timers.date()
  });
  await replicator.postPresence(CELL, 'AAAA');
  assert.deepEqual(posted, [], 'not started: nothing is sent');
  await replicator.start();
  await settle();
  assert.equal(replicator.status.state, 'live');
  await replicator.postPresence(CELL, 'AAAA');
  await replicator.leavePresence(CELL);
  assert.deepEqual(posted, [`post ${CELL} AAAA`, `leave ${CELL}`]);
  await replicator.stop();
  await replicator.postPresence(CELL, 'BBBB');
  assert.equal(posted.length, 2, 'stopped: nothing more is sent');
});

test('the people list reads "Working on {product}. Running {n} agents." while live, "Live" with no product, and "Last seen HH:MM" once gone', () => {
  const title = (product: string): string => (product === PRODUCT ? 'the operations plan' : product);
  assert.equal(presenceText({ live: true, lastSeen: 0, product: PRODUCT, runs: 2 }, title), 'Working on the operations plan. Running 2 agents.');
  assert.equal(presenceText({ live: true, lastSeen: 0, product: PRODUCT, runs: 1 }, title), 'Working on the operations plan. Running 1 agent.');
  assert.equal(presenceText({ live: true, lastSeen: 0, product: PRODUCT }, title), 'Working on the operations plan.');
  assert.equal(presenceText({ live: true, lastSeen: 0 }), 'Live');
  assert.equal(presenceText({ live: false, lastSeen: Date.parse('2026-11-24T14:02:00.000Z') }), 'Last seen 14:02');
});
