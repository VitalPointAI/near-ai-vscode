// The live replicator in full (Phase 33, 33-09; D-06, D-09, D-12 to D-14, D-32, D-42; Pitfalls 9, 12, 13) on a manual clock, against a scripted
// server whose every answer and frame the test chooses, over a small in-memory replica. Each state the replicator reaches here is left again: by a
// timer, an action, the lead or an update. All names and data are fictional.
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkpointHash, signCheckpoint } from '../domain/replica/checkpoint';
import type { Checkpoint, SignedCheckpoint } from '../domain/replica/checkpoint';
import { GENESIS_PREV, buildEntry, entryHash } from '../domain/replica/entry';
import type { SealedEntry } from '../domain/replica/entry';
import { createWitness, witnessCheckpoint } from '../domain/replica/hubWitness';
import type { WitnessState } from '../domain/replica/hubWitness';
import { staticRosterView } from '../domain/replica/rosterView';
import type { RosterView } from '../domain/replica/rosterView';
import type { HubMemory, SyncLocal } from '../staff/replica/hubSync';
import { HubTransportError } from '../staff/replica/hubTransport';
import type { AppendAnswer, AppendBatch, EventReader, EventReport, HubHeads } from '../staff/replica/hubTransport';
import { COALESCE_MS, ESCALATING_FINDINGS, LEAD_PROBE_MS, LiveReplicator, RESUME_GAP_MS, TICK_MS } from '../staff/replica/liveReplicator';
import type { LiveReplicatorOptions, LiveTransport } from '../staff/replica/liveReplicator';
import { FakeTimers, settle } from './helpers/liveWorld';
import { epochKey, fixedSigner, streamId } from './helpers/replicaWorld';

const PROJECT = streamId('live-replicator/project');
const ROSTER = 'e'.repeat(64);
const HUB = fixedSigner('live-replicator/hub');
const ME = fixedSigner('live-replicator/me');
const HUB_MEMBER = 'hub-main';
const KEY = epochKey('live-replicator/base');
const CELL = streamId('live-replicator/cell');

function rosterWith(readmits: string[] = []): RosterView {
  const view = staticRosterView({
    rosters: [{
      hash: ROSTER,
      checkpointSigners: [HUB.writer],
      members: [
        { member: 'mbr-me', name: 'Avery Lead', roles: ['member'], devices: [{ writer: ME.writer, publicKey: ME.publicKey }] },
        { member: HUB_MEMBER, name: 'Sync hub', roles: ['member'], devices: [{ writer: HUB.writer, publicKey: HUB.publicKey }] }
      ]
    }]
  });
  return { ...view, hubReadmits: (hub) => (hub === HUB_MEMBER ? readmits : []) };
}

function myLog(count: number, label = 'note'): SealedEntry[] {
  const log: SealedEntry[] = [];
  let prev = GENESIS_PREV;
  for (let seq = 0; seq < count; seq += 1) {
    const built = buildEntry({ signer: ME.signer, key: KEY, stream: PROJECT, seq, prev, epoch: 1, body: { deps: [], roster: ROSTER, lamport: seq + 1, at: '2026-11-24T10:00:00.000Z', actor: { kind: 'person' }, kind: 'note.add', data: { text: `Fictional ${label} ${seq}` } } });
    log.push(built.entry);
    prev = built.hash;
  }
  return log;
}

function checkpointAt(log: readonly SealedEntry[], seq: number): SignedCheckpoint {
  const head = log[seq] as SealedEntry;
  const value: Checkpoint = { type: 'checkpoint', v: 2, project: PROJECT, signer: HUB.writer, rosterHead: ROSTER, streams: [{ stream: PROJECT, heads: [{ writer: ME.writer, seq, hash: entryHash(head.header), lamport: seq + 1, roster: ROSTER }], count: seq + 1, orderTip: '1'.repeat(64) }] };
  return signCheckpoint(HUB.signer, value);
}

interface Local extends SyncLocal { stored: SealedEntry[]; fail?: unknown }

function memoryLocal(roster: () => RosterView, own: readonly SealedEntry[] = []): Local {
  const stored: SealedEntry[] = [...own];
  const logOf = (writer: string): SealedEntry[] => stored.filter((entry) => entry.header.writer === writer).sort((a, b) => a.header.seq - b.header.seq);
  const local: Local = {
    project: PROJECT,
    writer: ME.writer,
    stored,
    roster: () => (local.fail === undefined ? Promise.resolve(roster()) : Promise.reject(local.fail)),
    heads: () => Promise.resolve(stored.length === 0 ? [] : [{ stream: PROJECT, heads: [{ writer: ME.writer, seq: (logOf(ME.writer).at(-1) as SealedEntry).header.seq, hash: entryHash((logOf(ME.writer).at(-1) as SealedEntry).header) }] }]),
    head: (_stream, writer) => { const last = logOf(writer).at(-1); return Promise.resolve(last === undefined ? undefined : { seq: last.header.seq, hash: entryHash(last.header) }); },
    holds: (hashes) => Promise.resolve(new Set(hashes.filter((hash) => stored.some((entry) => entryHash(entry.header) === hash)))),
    entriesAfter: (_stream, writer, seq) => Promise.resolve(logOf(writer).filter((entry) => entry.header.seq > seq)),
    blob: () => Promise.resolve(undefined),
    wantedBlobs: () => Promise.resolve([]),
    blobsCitedBy: () => Promise.resolve([]),
    grants: () => Promise.resolve([]),
    ingest: () => Promise.resolve({ added: 0, notStored: 0 }),
    putGrants: () => Promise.resolve(),
    checkpoints: () => Promise.resolve([]),
    putCheckpoint: () => Promise.resolve()
  };
  return local;
}

function memoryOf(initial?: WitnessState): HubMemory {
  let saved = initial;
  return { load: (hub, project) => Promise.resolve(saved ?? createWitness(hub, project)), save: (state) => { saved = state; return Promise.resolve(); } };
}

/** A server the test scripts: heads, append and the grant answer, and a frame queue per event stream. */
interface Server {
  open: () => LiveTransport;
  opened: number;
  /** Delivers a frame to every open event stream. */
  frame(event: string, data: Record<string, unknown>): void;
  heads: () => HubHeads;
  append: (batch: AppendBatch) => AppendAnswer;
  grant: (hash: string) => { kind: 'missing' | 'refused'; hash: string; reason?: string };
  appends: AppendBatch[];
  /** The checkpoint the hub hands back to an ask, if any (as it does to the device whose own ask made it sign). */
  asked?: SignedCheckpoint;
}

function scriptedServer(): Server {
  const queues: Array<{ push(report: EventReport): void; close(): void }> = [];
  const server: Server = {
    opened: 0,
    appends: [],
    heads: () => ({ project: PROJECT, rosterHead: ROSTER, streams: [], grants: [] }),
    append: (batch) => ({ project: PROJECT, accepted: batch.entries.map((entry) => entryHash(entry.header)), refused: [], grantsRefused: [], rosterHead: ROSTER, blobsPut: false }),
    grant: (hash) => ({ kind: 'missing', hash }),
    frame(event, data) {
      for (const queue of queues) queue.push({ kind: 'frame', event: event as never, id: 1, data });
    },
    open() {
      server.opened += 1;
      let closed = false;
      const transport = {
        project: PROJECT,
        hub: HUB.writer,
        hubHeads: () => (closed ? Promise.reject(new HubTransportError('unreachable')) : Promise.resolve().then(() => server.heads())),
        entries: (stream: string, writer: string) => Promise.resolve({ project: PROJECT, stream, writer, entries: [], more: false, head: null }),
        append: (batch: AppendBatch) => Promise.resolve().then(() => { server.appends.push(batch); return server.append(batch); }),
        getBlob: (hash: string) => Promise.resolve({ kind: 'missing' as const, hash }),
        grant: (hash: string) => Promise.resolve(server.grant(hash)),
        askCheckpoint: () => Promise.resolve({ project: PROJECT, kept: 0, ...(server.asked === undefined ? {} : { checkpoint: server.asked }) }),
        events: (): Promise<EventReader> => {
          const waiting: EventReport[] = [];
          let wake: (() => void) | undefined;
          let done = false;
          const queue = { push: (report: EventReport) => { waiting.push(report); wake?.(); }, close: () => { done = true; wake?.(); } };
          queues.push(queue);
          const reader: EventReader = {
            retryMs: undefined,
            close: () => queue.close(),
            async *[Symbol.asyncIterator]() {
              for (;;) {
                if (waiting.length > 0) { yield waiting.shift() as EventReport; continue; }
                if (done) return;
                await new Promise<void>((resolve) => { wake = resolve; });
                wake = undefined;
              }
            }
          };
          return Promise.resolve(reader);
        },
        close: () => { closed = true; for (const queue of queues.splice(0)) queue.close(); }
      };
      return transport as unknown as LiveTransport;
    }
  };
  return server;
}

interface Rig { replicator: LiveReplicator; timers: FakeTimers; server: Server; local: Local; log: string[]; jump(ms: number): void }

async function rig(extra: Partial<LiveReplicatorOptions> & { local?: Local; memory?: HubMemory } = {}): Promise<Rig> {
  const timers = new FakeTimers();
  let offset = 0;
  const server = scriptedServer();
  const local = extra.local ?? memoryLocal(() => rosterWith());
  const log: string[] = [];
  const replicator = new LiveReplicator({
    local, memory: extra.memory ?? memoryOf(), hub: { id: HUB_MEMBER, writer: HUB.writer, certPin: 'f'.repeat(64) },
    address: () => Promise.resolve('127.0.0.1:9'), signer: ME.signer, open: server.open, timers, now: () => new Date(timers.now() + offset),
    log: (line) => log.push(line), ...extra
  });
  await replicator.start();
  await settle();
  return { replicator, timers, server, local, log, jump: (ms) => { offset += ms; } };
}

async function done(r: Rig): Promise<void> {
  await r.replicator.stop();
  assert.equal(r.timers.pending, 0, 'stop leaves no timer');
}

// ---- frames ----------------------------------------------------------------------------------------------------------------------------------

test('a live replicator reads the event stream: heads frames coalesce into one exchange after COALESCE_MS', async () => {
  const r = await rig();
  assert.equal(r.replicator.status.state, 'live');
  await r.timers.advance(COALESCE_MS);
  const before = r.log.filter((line) => line === 'exchange heads').length;
  for (let index = 0; index < 3; index += 1) r.server.frame('heads', { project: PROJECT, stream: PROJECT, heads: [] });
  await settle();
  await r.timers.advance(COALESCE_MS);
  assert.equal(r.log.filter((line) => line === 'exchange heads').length, before + 1);
  await done(r);
});

test('frames are read strictly: another project\'s frame and a malformed one are dropped and wake nothing', async () => {
  const r = await rig();
  await r.timers.advance(COALESCE_MS);
  r.server.frame('heads', { project: streamId('other'), stream: PROJECT, heads: [] });
  r.server.frame('heads', { project: PROJECT, stream: PROJECT, heads: 'none' });
  await settle();
  await r.timers.advance(COALESCE_MS);
  assert.ok(r.log.includes('frame heads wrong-project') && r.log.includes('frame heads malformed'), r.log.join('\n'));
  assert.equal(r.log.includes('exchange heads'), false);
  await done(r);
});

test('a join-request frame reaches onJoinRequest with the invitation on a lead device, and not on a member device', async () => {
  for (const lead of [true, false]) {
    const seen: Array<string | undefined> = [];
    const r = await rig({ isLeadDevice: () => lead, onJoinRequest: (invite) => seen.push(invite) });
    r.server.frame('join-request', { project: PROJECT, invite: 'inv-jo' });
    await settle();
    assert.deepEqual(seen, lead ? ['inv-jo'] : []);
    await done(r);
  }
});

test('a presence frame reaches onPresence as { project, cell, devices, left }, rebuilt from the checked frame', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const r = await rig({ onPresence: (frame) => seen.push(frame) });
  const writer = 'a'.repeat(64);
  r.server.frame('presence', { project: PROJECT, cell: CELL, devices: [{ writer, sealed: 'c2VhbGVk' }], left: ['b'.repeat(64)] });
  await settle();
  assert.deepEqual(seen, [{ project: PROJECT, cell: CELL, devices: [{ writer, sealed: 'c2VhbGVk' }], left: ['b'.repeat(64)] }]);
  await done(r);
});

test('checkpoint and equivocation frames each run one exchange', async () => {
  const r = await rig();
  await r.timers.advance(COALESCE_MS);
  r.server.frame('checkpoint', { project: PROJECT, checkpoint: { v: 1 } });
  await settle();
  await r.timers.advance(COALESCE_MS);
  r.server.frame('equivocation', { project: PROJECT, stream: PROJECT, writer: ME.writer, seq: 1, proof: {} });
  await settle();
  await r.timers.advance(COALESCE_MS);
  assert.ok(r.log.includes('exchange checkpoint') && r.log.includes('exchange equivocation'), r.log.join('\n'));
  await done(r);
});

// Found in 33-14 over a real hub: onCheckpoint ran on the frame, before the exchange that reads the checkpoint, and the device whose own ask made
// the hub sign hears no frame, so the compactor never saw the newest checkpoint.
test('onCheckpoint runs once after an exchange makes a newer checkpoint the trusted newest one, and not for a frame that brings nothing newer', async () => {
  const log = myLog(6);
  const calls: Array<Record<string, unknown>> = [];
  const r = await rig({ local: memoryLocal(() => rosterWith(), log), onCheckpoint: (frame) => calls.push(frame) });
  assert.deepEqual(calls, [], 'no checkpoint yet');
  const signed = checkpointAt(log, 5);
  r.server.asked = signed;
  r.replicator.syncNow();
  await settle();
  await r.timers.advance(COALESCE_MS);
  assert.deepEqual(calls, [{ project: PROJECT, checkpoint: checkpointHash(signed) }], r.log.join('\n'));
  r.server.frame('checkpoint', { project: PROJECT, checkpoint: { v: 1 } });
  await settle();
  await r.timers.advance(COALESCE_MS);
  assert.ok(r.log.includes('exchange checkpoint'), r.log.join('\n'));
  assert.equal(calls.length, 1, 'the same newest checkpoint calls nothing again');
  await done(r);
});

// ---- states and their ways out ---------------------------------------------------------------------------------------------------------------

test('restoring: the push meets restore mode, so the state is offline with reason restoring, the retry follows the server\'s wait, and it becomes live once the mode ends', async () => {
  const server = { restoring: true };
  const local = memoryLocal(() => rosterWith(), myLog(1));
  const r = await rig({ local });
  // The scripted server of this rig answers the push with restore mode until told otherwise.
  r.server.append = (batch) => { if (server.restoring) throw new HubTransportError('hub-error', { status: 503, reason: 'restoring', retryAfterSeconds: 30 }); return { project: PROJECT, accepted: batch.entries.map((entry) => entryHash(entry.header)), refused: [], grantsRefused: [], rosterHead: ROSTER, blobsPut: false }; };
  r.replicator.syncNow();
  await settle();
  await r.timers.advance(0);
  assert.deepEqual([r.replicator.status.state, r.replicator.status.reason], ['offline', 'restoring']);
  assert.equal(r.replicator.status.retryAt, r.timers.now() + 30_000, 'the server\'s own wait');
  server.restoring = false;
  await r.timers.advance(30_000);
  assert.equal(r.replicator.status.state, 'live');
  assert.equal(local.stored.length, 1, 'the change stayed here and was pushed, never lost');
  await done(r);
});

test('needs-update from the session: the replicator stops in needs-update, opens nothing more however long it waits, and only updated() connects again', async () => {
  const s = await rig();
  s.server.heads = () => { throw new HubTransportError('session-refused', { status: 403, reason: 'needs-update' }); };
  s.replicator.syncNow();
  await settle();
  await s.timers.advance(COALESCE_MS);
  // A live replicator meets the requirement on its next exchange.
  assert.equal(s.replicator.status.state, 'needs-update');
  const opened = s.server.opened;
  await s.timers.advance(10 * 60_000);
  assert.equal(s.replicator.status.state, 'needs-update');
  assert.equal(s.server.opened, opened, 'nothing is tried until the update');
  s.server.heads = () => ({ project: PROJECT, rosterHead: ROSTER, streams: [], grants: [] });
  s.replicator.updated();
  await settle();
  assert.equal(s.replicator.status.state, 'live');
  await done(s);
});

test('needs-update from the local fold: a ReplicaProjectError needs-update from the replica is needs-update, never attention', async () => {
  const local = memoryLocal(() => rosterWith());
  local.fail = Object.assign(new Error('needs update'), { refusal: { refused: 'needs-update', message: 'This shared work needs a newer version of Sterling. Ask your administrator to update it.' } });
  const r = await rig({ local });
  assert.deepEqual([r.replicator.status.state, r.replicator.status.reason], ['needs-update', 'needs-update']);
  await done(r);
});

test('refused shows the session reason (revoked), and the replicator looks again for the lead every LEAD_PROBE_MS', async () => {
  const timers = new FakeTimers();
  const server = scriptedServer();
  server.heads = () => { throw new HubTransportError('session-refused', { status: 401, reason: 'revoked' }); };
  const replicator = new LiveReplicator({ local: memoryLocal(() => rosterWith()), memory: memoryOf(), hub: { id: HUB_MEMBER, writer: HUB.writer, certPin: 'f'.repeat(64) }, address: () => Promise.resolve('127.0.0.1:9'), signer: ME.signer, open: server.open, timers, now: () => timers.date() });
  await replicator.start();
  await settle();
  assert.deepEqual([replicator.status.state, replicator.status.reason], ['refused', 'revoked']);
  const opened = server.opened;
  server.heads = () => ({ project: PROJECT, rosterHead: ROSTER, streams: [], grants: [] });
  await timers.advance(LEAD_PROBE_MS);
  assert.equal(server.opened, opened + 1, 'looked again');
  assert.equal(replicator.status.state, 'live', 'the lead admitted this device again');
  await replicator.stop();
});

test('session-expired (Phase 33 D-62): a person\'s ended session key shows refused with that reason, and the replicator does not look again', async () => {
  const timers = new FakeTimers();
  const server = scriptedServer();
  server.heads = () => { throw new HubTransportError('session-refused', { status: 403, reason: 'session-expired' }); };
  const replicator = new LiveReplicator({ local: memoryLocal(() => rosterWith()), memory: memoryOf(), hub: { id: HUB_MEMBER, writer: HUB.writer, certPin: 'f'.repeat(64) }, address: () => Promise.resolve('127.0.0.1:9'), signer: ME.signer, open: server.open, timers, now: () => timers.date() });
  await replicator.start();
  await settle();
  assert.deepEqual([replicator.status.state, replicator.status.reason], ['refused', 'session-expired']);
  const opened = server.opened;
  await timers.advance(LEAD_PROBE_MS * 3);
  assert.equal(server.opened, opened, 'an ended session key is never tried again; the person signs in again');
  assert.equal(replicator.status.state, 'refused');
  await replicator.stop();
});

test('quarantined: a session refused quarantined shows refused with reason quarantined', async () => {
  const timers = new FakeTimers();
  const server = scriptedServer();
  server.heads = () => { throw new HubTransportError('session-refused', { status: 403, reason: 'quarantined' }); };
  const replicator = new LiveReplicator({ local: memoryLocal(() => rosterWith()), memory: memoryOf(), hub: { id: HUB_MEMBER, writer: HUB.writer, certPin: 'f'.repeat(64) }, address: () => Promise.resolve('127.0.0.1:9'), signer: ME.signer, open: server.open, timers, now: () => timers.date() });
  await replicator.start();
  await settle();
  assert.deepEqual([replicator.status.state, replicator.status.reason], ['refused', 'quarantined']);
  await replicator.stop();
});

test('findings: an injected change or a corrupt attachment in a synced exchange is attention; delayed and replayed are not escalated', async () => {
  assert.deepEqual([...ESCALATING_FINDINGS].sort(), ['corrupt-blob', 'injected', 'withheld']);
  for (const [reason, state, finding] of [['bad-signature', 'attention', 'injected'], ['corrupt-blob', 'attention', 'corrupt-blob']] as const) {
    const timers = new FakeTimers();
    const server = scriptedServer();
    server.heads = () => ({ project: PROJECT, rosterHead: ROSTER, streams: [], grants: ['c'.repeat(64)] });
    server.grant = (hash) => ({ kind: 'refused', hash, reason });
    const replicator = new LiveReplicator({ local: memoryLocal(() => rosterWith()), memory: memoryOf(), hub: { id: HUB_MEMBER, writer: HUB.writer, certPin: 'f'.repeat(64) }, address: () => Promise.resolve('127.0.0.1:9'), signer: ME.signer, open: server.open, timers, now: () => timers.date() });
    await replicator.start();
    await settle();
    assert.deepEqual([replicator.status.state, replicator.status.reason], [state, finding], reason);
    assert.ok(replicator.status.findings.includes(finding));
    await replicator.stop();
  }
  assert.equal(ESCALATING_FINDINGS.has('delayed') || ESCALATING_FINDINGS.has('replayed'), false, 'delayed and replayed stay live with a detail line');
});

test('readmit: a forked view is attention; after the lead\'s hub.readmit folds, the next look clears it and the replicator returns to live', async () => {
  const log = myLog(6);
  let state = witnessCheckpoint(createWitness(HUB.writer, PROJECT), checkpointAt(log, 3), rosterWith()).state;
  state = witnessCheckpoint(state, checkpointAt(myLog(6, 'other branch'), 3), rosterWith()).state;
  assert.equal(state.distrusted, true);
  const readmits: string[] = [];
  const timers = new FakeTimers();
  const server = scriptedServer();
  server.heads = () => ({ project: PROJECT, rosterHead: ROSTER, streams: [], grants: [], checkpoint: checkpointAt(log, 5) });
  const replicator = new LiveReplicator({ local: memoryLocal(() => rosterWith(readmits)), memory: memoryOf(state), hub: { id: HUB_MEMBER, writer: HUB.writer, certPin: 'f'.repeat(64) }, address: () => Promise.resolve('127.0.0.1:9'), signer: ME.signer, open: server.open, timers, now: () => timers.date() });
  await replicator.start();
  await settle();
  assert.deepEqual([replicator.status.state, replicator.status.reason], ['attention', 'forked-view']);
  readmits.push('a'.repeat(64));
  await timers.advance(LEAD_PROBE_MS);
  assert.equal(replicator.status.state, 'live');
  await replicator.stop();
});

test('resume: a gap of more than RESUME_GAP_MS between ticks (sleep, a hidden tab) closes the link and reconnects at once', async () => {
  const r = await rig();
  assert.equal(r.replicator.status.state, 'live');
  const opened = r.server.opened;
  r.jump(RESUME_GAP_MS + 1000);
  await r.timers.advance(TICK_MS);
  assert.ok(r.log.some((line) => line.startsWith('resume gap')), r.log.join('\n'));
  assert.equal(r.server.opened, opened + 1, 'a new connection at once');
  assert.equal(r.replicator.status.state, 'live');
  await done(r);
});

test('network: when the networkProbe answer changes, an offline project tries again at once with the attempts reset', async () => {
  let network = 'net-a';
  const r = await rig({ networkProbe: () => network });
  r.server.heads = () => { throw new HubTransportError('rate-limited', { status: 429, retryAfterSeconds: 120 }); };
  r.replicator.syncNow();
  await settle();
  await r.timers.advance(COALESCE_MS);
  assert.equal(r.replicator.status.state, 'offline');
  const retryAt = r.replicator.status.retryAt as number;
  assert.ok(retryAt - r.timers.now() > TICK_MS);
  r.server.heads = () => ({ project: PROJECT, rosterHead: ROSTER, streams: [], grants: [] });
  network = 'net-b';
  await r.timers.advance(TICK_MS);
  assert.ok(r.log.includes('network changed'));
  assert.equal(r.replicator.status.state, 'live', 'tried again before the back-off time');
  await done(r);
});

test('local first: a push that fails keeps the change queued, and the next exchange pushes it', async () => {
  const local = memoryLocal(() => rosterWith(), myLog(2));
  const r = await rig({ local });
  r.server.appends.length = 0;
  let failing = true;
  r.server.append = (batch) => { if (failing) throw new HubTransportError('unreachable'); return { project: PROJECT, accepted: batch.entries.map((entry) => entryHash(entry.header)), refused: [], grantsRefused: [], rosterHead: ROSTER, blobsPut: false }; };
  r.replicator.syncNow();
  await settle();
  await r.timers.advance(0);
  assert.equal(r.replicator.status.state, 'offline');
  failing = false;
  await r.timers.advance(1000);
  assert.equal(r.replicator.status.state, 'live');
  assert.ok(r.server.appends.some((batch) => batch.entries.length === 2), 'both changes went in the retry');
  await done(r);
});
