import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkpointConflict, checkpointHash, checkpointHeads, orderTipOf, readCheckpoint, recomputeCheckpoint, signCheckpoint, verifyCheckpoint } from '@ext/domain/replica/checkpoint';
import type { Checkpoint, CheckpointEntry, SignedCheckpoint } from '@ext/domain/replica/checkpoint';
import type { SealedEntry } from '@ext/domain/replica/entry';
import { readHubFile } from '@ext/domain/replica/hubFile';
import { totalOrder } from '@ext/domain/replica/order';
import { foldRoster, rosterView } from '@ext/domain/replica/roster';
import type { RosterView } from '@ext/domain/replica/rosterView';
import { verifyEntry } from '@ext/domain/replica/verify';
import { hubIdentityOf } from '../src/enrol';
import { generateKeyFile, readEncryptionKey, readSigningKey } from '../src/keys';
import { openHubStore } from '../src/store/hubStore';
import { HubConnection } from './helpers/hubClient';
import { withHub } from './helpers/hubHarness';
import type { Hub, StartOptions } from './helpers/hubHarness';
import { launchHub, startHubProcess, within } from './helpers/hubProcess';
import { HUB_ADDRESS, NOW_MS, createHubWorld } from './helpers/hubWorld';
import type { HubWorld, WorldDevice, Written } from './helpers/hubWorld';
import { EventClient, ManualScheduler } from './helpers/sseReader';
import type { EventStream } from './helpers/sseReader';
import { makeTlsFixture } from './helpers/tlsFixture';

// Phase 32, plan 22 (D-45, D-46, D-54, D-63): the hub signs checkpoints of what it can read. A client holding the same roster verifies them, and
// recomputes their counts and order hashes from its own entries with the hub's earlier checkpoints nested. Coverage is the largest causally closed
// set of entries in the base cell and the cells granted to the hub; timing is a 2 second debounce with a 60 second floor and asks at most every
// 10 seconds; handed-back checkpoints are nested after a restore; conflicts stop signing. The timing constants are written out here as the
// decision states them. All names and data are fictional.

const DEBOUNCE_MS = 2000;
const MIN_GAP_MS = 60_000;
const ASK_GAP_MS = 10_000;

const hubDevice = (hub: Hub): WorldDevice => ({ writer: hub.identity.writer, x25519: hub.identity.x25519 }) as WorldDevice;

const note = (world: HubWorld, device: WorldDevice, extra: { stream?: string; deps?: Written[]; lamport?: number } = {}): Written =>
  world.write(device, {
    kind: 'note.add',
    data: { text: 'Fictional note' },
    ...(extra.stream === undefined ? {} : { stream: extra.stream }),
    ...(extra.deps === undefined ? {} : { deps: extra.deps.map((dep) => ({ writer: dep.writer, seq: dep.seq, hash: dep.hash })) }),
    ...(extra.lamport === undefined ? {} : { lamport: extra.lamport }),
  });

interface Team {
  world: HubWorld;
  analyst: WorldDevice;
  officer: WorldDevice;
  /** A label cell of the lead and the officer, not granted to the hub unless the setup grants it. */
  ops: string;
}

/** The world (lamports one more than their past, as a client's chain stage requires) with an analyst and an officer, enrolled over HTTPS. */
async function team(hub: Hub, setup?: (team: Omit<Team, 'world'> & { world: HubWorld }) => void, projectLabel?: string): Promise<Team> {
  const world = createHubWorld({ causalLamport: true, ...(projectLabel === undefined ? {} : { projectLabel }) });
  world.admitHub(hub.identity);
  const analyst = world.device('ANALYST', 'mbr-analyst');
  const officer = world.device('OFFICER', 'mbr-officer');
  world.admitMember(analyst);
  world.admitMember(officer);
  const ops = world.labelCell('ops', [world.lead, officer]).cell;
  const made = { world, analyst, officer, ops };
  setup?.(made);
  const enrolled = await hub.enrolProject(world);
  assert.equal(enrolled?.status, 201, enrolled?.text ?? 'no answer');
  return made;
}

/** hub.grant for a cell, then the cell's epoch 1 key wrapped to the hub (D-64 for label cells). Returns the roster entry and the grant. */
function grantToHub(hub: Hub, world: HubWorld, cell: string): { entry: Written; grant: unknown } {
  const entry = world.rosterEntry(world.lead, 'hub.grant', { hub: hub.identity.hub, cell });
  const grant = world.grant(world.lead, { cell, roster: world.head, to: [hubDevice(hub)] });
  return { entry, grant };
}

async function append(hub: Hub, world: HubWorld, device: WorldDevice, written: readonly Written[], grants: readonly unknown[] = []): Promise<void> {
  const session = await hub.openSession(device, world.project);
  try {
    const body = { entries: written.map((item) => item.entry), ...(grants.length === 0 ? {} : { grants }) };
    const answer = await session.connection.post(`/v1/projects/${world.project}/append`, body, session.token);
    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual(answer.json().accepted, written.map((item) => item.hash));
  } finally {
    session.connection.close();
  }
}

/** POST /v1/projects/:p/checkpoint, handing back the checkpoints given. */
async function ask(hub: Hub, world: HubWorld, device: WorldDevice, known: readonly SignedCheckpoint[] = []): Promise<Record<string, unknown>> {
  const session = await hub.openSession(device, world.project);
  try {
    const answer = await session.connection.post(`/v1/projects/${world.project}/checkpoint`, known.length === 0 ? {} : { known }, session.token);
    assert.equal(answer.status, 200, answer.text);
    return answer.json();
  } finally {
    session.connection.close();
  }
}

async function headsOf(hub: Hub, world: HubWorld, device: WorldDevice): Promise<{ checkpoint?: SignedCheckpoint }> {
  const session = await hub.openSession(device, world.project);
  try {
    const answer = await session.connection.get(`/v1/projects/${world.project}/heads`, session.token);
    assert.equal(answer.status, 200, answer.text);
    return answer.json();
  } finally {
    session.connection.close();
  }
}

const stored = (hub: Hub, project: string): SignedCheckpoint[] => hub.store.checkpoints(project).map((record) => JSON.parse(record.body) as SignedCheckpoint);
const payloadOf = (signed: SignedCheckpoint): Checkpoint => readCheckpoint(signed.payload) as Checkpoint;
const streamsOf = (signed: SignedCheckpoint): string[] => payloadOf(signed).streams.map((stream) => stream.stream);

/** Lets every queued signing job finish (the hub signs asynchronously after a timer or an ask). */
const settle = async (hub: Hub): Promise<void> => {
  await hub.checkpoints?.settled();
};

/** Moves the injected clock and timers, then lets the signing jobs they started finish. */
async function advance(hub: Hub, scheduler: ManualScheduler, ms: number): Promise<void> {
  scheduler.advance(ms);
  await settle(hub);
}

const withSigning = (options: StartOptions, body: (hub: Hub, scheduler: ManualScheduler) => Promise<void>): Promise<void> => {
  const scheduler = new ManualScheduler();
  return withHub({ ...options, scheduler }, async (hub) => {
    scheduler.onAdvance = (ms) => hub.advance(ms);
    await body(hub, scheduler);
  });
};

/** The client's side: its own fold of the roster and its own opening of the entries, with every key of the world (a lead's view). */
function client(world: HubWorld): { view: RosterView; open(entries?: readonly SealedEntry[]): CheckpointEntry[] } {
  const keys = (stream: string, epoch: number): Buffer => world.keyOf(stream, epoch);
  const blobs = (hash: string) => world.blobs.get(hash);
  const now = new Date(NOW_MS);
  const state = foldRoster({ entries: world.entries.filter((entry) => entry.header.stream === world.project), anchor: world.anchor(), keys, blobs, grants: world.grants, now });
  const view = rosterView(state);
  return {
    view,
    open(entries = world.entries) {
      const opened: CheckpointEntry[] = [];
      for (const entry of entries) {
        const outcome = verifyEntry(entry, { roster: view, keys, blobs, now });
        assert.equal(outcome.status, 'verified', `an entry did not open on the client: ${outcome.status === 'verified' ? '' : outcome.reason}`);
        if (outcome.status === 'verified') opened.push(outcome.entry);
      }
      return opened;
    },
  };
}

/** A version 2 checkpoint this hub would sign over exactly these entries with no earlier checkpoint: what a test hands back as the hub's own. */
function honestCheckpoint(hub: Hub, world: HubWorld, view: RosterView, entries: readonly CheckpointEntry[]): SignedCheckpoint {
  const heads = checkpointHeads(entries, view);
  const ordered = totalOrder(entries);
  const streams = [...heads.keys()].sort().map((stream) => {
    const hashes = ordered.filter((entry) => entry.header.stream === stream).map((entry) => entry.hash);
    return { stream, heads: heads.get(stream) ?? [], count: hashes.length, orderTip: orderTipOf(hashes) };
  });
  return signCheckpoint(hub.identity.signer, { type: 'checkpoint', v: 2, project: world.project, signer: hub.identity.writer, rosterHead: world.head, streams });
}

// ---- Task 1: tracer ----

test('tracer: one append is signed 2 seconds later, kept in the store, sent as a checkpoint event and carried by the next heads response', () =>
  withSigning({}, async (hub, scheduler) => {
    const { world, analyst } = await team(hub);
    const reader = await EventClient.open(hub, world.lead, world.project);
    const stream = await reader.events();
    assert.equal(stream.status, 200);

    await append(hub, world, analyst, [note(world, analyst)]);
    await advance(hub, scheduler, DEBOUNCE_MS - 1);
    assert.equal(hub.store.checkpoints(world.project).length, 0, 'signed before the debounce ran out');
    await advance(hub, scheduler, 1);

    const kept = stored(hub, world.project);
    assert.equal(kept.length, 1);
    const signed = kept[0] as SignedCheckpoint;
    await stream.until((item) => item.frames.some((frame) => frame.event === 'checkpoint'), 'the checkpoint event');
    const frame = stream.frames.find((item) => item.event === 'checkpoint');
    assert.deepEqual(frame?.data, { project: world.project, checkpoint: signed });
    assert.deepEqual((await headsOf(hub, world, world.lead)).checkpoint, signed);
    assert.equal(hub.store.latestCheckpoint(world.project)?.hash, checkpointHash(signed));
  }));

test('tracer: the client verifies the checkpoint with its own roster and recomputes it from its own entries; version 2, the hub signs, no digest', () =>
  withSigning({}, async (hub, scheduler) => {
    const { world, analyst } = await team(hub);
    await append(hub, world, analyst, [note(world, analyst)]);
    await advance(hub, scheduler, DEBOUNCE_MS);
    const signed = stored(hub, world.project)[0] as SignedCheckpoint;
    assert.ok(signed, 'no checkpoint was signed');

    const mine = client(world);
    const verdict = verifyCheckpoint(signed, mine.view);
    assert.ok(verdict.ok, verdict.ok ? '' : verdict.reason);
    const payload = payloadOf(signed);
    assert.equal(payload.v, 2);
    assert.equal(payload.signer, hub.identity.writer);
    assert.equal(payload.rosterHead, world.head);
    assert.equal(payload.rosterHead, (await hub.cache.get(world.project)).head);
    assert.ok(payload.streams.every((stream) => !('digest' in stream)), 'a digest is left out in Phase 32');
    assert.deepEqual(streamsOf(signed), [world.project]);
    const check = recomputeCheckpoint(payload, mine.open());
    assert.deepEqual(check, { ok: true, mismatches: [] });
    // Every base cell entry is covered: the genesis, the roster entries and the note.
    assert.equal(payload.streams[0]?.count, world.entries.filter((entry) => entry.header.stream === world.project).length);
  }));

// ---- Task 2: coverage, nesting, timing, handed-back checkpoints, conflict and trimming ----

test('coverage: entries in an ungranted label cell are never covered and that stream is absent, while the base cell stream always is', () =>
  withSigning({}, async (hub, scheduler) => {
    const { world, officer, ops } = await team(hub);
    const inOps = [note(world, officer, { stream: ops }), note(world, world.lead, { stream: ops })];
    await append(hub, world, officer, [inOps[0] as Written]);
    await append(hub, world, world.lead, [inOps[1] as Written]);
    await append(hub, world, officer, [note(world, officer)]);
    await advance(hub, scheduler, DEBOUNCE_MS);
    const signed = stored(hub, world.project)[0] as SignedCheckpoint;
    assert.deepEqual(streamsOf(signed), [world.project]);
    const mine = client(world);
    assert.deepEqual(recomputeCheckpoint(payloadOf(signed), mine.open()), { ok: true, mismatches: [] });
  }));

test('coverage: once hub.grant and the grant to the hub device arrive, the ungranted cell is granted and its stream appears in the next checkpoint', () =>
  withSigning({}, async (hub, scheduler) => {
    const { world, officer, ops } = await team(hub);
    const earlier = note(world, officer, { stream: ops });
    await append(hub, world, officer, [earlier]);
    await append(hub, world, officer, [note(world, officer)]);
    await advance(hub, scheduler, DEBOUNCE_MS);
    assert.deepEqual(streamsOf(stored(hub, world.project)[0] as SignedCheckpoint), [world.project]);

    const granted = grantToHub(hub, world, ops);
    await append(hub, world, world.lead, [granted.entry], [granted.grant]);
    await advance(hub, scheduler, MIN_GAP_MS);
    const kept = stored(hub, world.project);
    assert.equal(kept.length, 2);
    const second = kept[1] as SignedCheckpoint;
    assert.deepEqual(streamsOf(second).sort(), [world.project, ops].sort());
    const opsStream = payloadOf(second).streams.find((stream) => stream.stream === ops);
    assert.deepEqual(opsStream?.heads.map((head) => head.hash), [earlier.hash]);
    const mine = client(world);
    assert.deepEqual(recomputeCheckpoint(payloadOf(second), mine.open(), undefined, [payloadOf(kept[0] as SignedCheckpoint)]), { ok: true, mismatches: [] });
  }));

test('coverage: an entry in a granted cell citing an ungranted cell is not covered, nor anything after it in that log; other writers are', () =>
  withSigning({}, async (hub, scheduler) => {
    let intel = '';
    const { world, officer, ops } = await team(hub, (made) => {
      intel = made.world.labelCell('intel', [made.world.lead, made.officer]).cell;
      grantToHub(hub, made.world, made.ops);
    });
    // The officer's first ops entry is covered; the next one cites the intel entry, so it and the one after it are not. Its lamport is the
    // same with or without the dep, so only the dep decides.
    const opened = note(world, officer, { stream: ops });
    const secret = note(world, officer, { stream: intel });
    const citing = note(world, officer, { stream: ops, deps: [secret] });
    const after = note(world, officer, { stream: ops });
    const byLead = note(world, world.lead, { stream: ops });
    await append(hub, world, officer, [opened, secret, citing, after]);
    await append(hub, world, world.lead, [byLead]);
    await advance(hub, scheduler, DEBOUNCE_MS);
    const signed = stored(hub, world.project)[0] as SignedCheckpoint;
    assert.deepEqual(streamsOf(signed).sort(), [world.project, ops].sort());
    const opsStream = payloadOf(signed).streams.find((stream) => stream.stream === ops);
    assert.deepEqual(
      opsStream?.heads.map((head) => [head.writer, head.hash]),
      [[world.lead.writer, byLead.hash], [officer.writer, opened.hash]].sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1)),
    );
    assert.equal(opsStream?.count, 2);
    assert.ok(!streamsOf(signed).includes(intel));
    const mine = client(world);
    assert.deepEqual(recomputeCheckpoint(payloadOf(signed), mine.open()), { ok: true, mismatches: [] });
  }));

test('coverage: an entry a client chain stage refuses (a lamport that is not one more than its past, or a roster older than its past cites) is not covered, nor anything after it', () =>
  withSigning({}, async (hub, scheduler) => {
    const { world, analyst, officer } = await team(hub);
    const fine = note(world, world.lead);
    const badLamport = note(world, analyst, { lamport: 7 });
    const afterBad = note(world, analyst);
    // The officer cites the genesis roster while its dep (the lead's note) cites the current head.
    const stale = world.write(officer, { kind: 'note.add', data: { text: 'Fictional note' }, roster: world.genesisHash, deps: [{ writer: fine.writer, seq: fine.seq, hash: fine.hash }] });
    await append(hub, world, world.lead, [fine]);
    await append(hub, world, analyst, [badLamport, afterBad]);
    await append(hub, world, officer, [stale]);
    await advance(hub, scheduler, DEBOUNCE_MS);
    const signed = stored(hub, world.project)[0] as SignedCheckpoint;
    const heads = payloadOf(signed).streams[0]?.heads ?? [];
    assert.deepEqual(heads.map((head) => head.writer), [world.lead.writer]);
    assert.equal(heads[0]?.hash, fine.hash);
    const entries = client(world).open();
    assert.deepEqual(recomputeCheckpoint(payloadOf(signed), entries), { ok: true, mismatches: [] });
  }));

test('nest: three checkpoints over a history with a late concurrent entry recompute with the earlier ones nested, and no two conflict', () =>
  withSigning({}, async (hub, scheduler) => {
    const { world, analyst } = await team(hub);
    await append(hub, world, world.lead, [note(world, world.lead)]);
    await advance(hub, scheduler, DEBOUNCE_MS);
    await append(hub, world, world.lead, [note(world, world.lead), note(world, world.lead)]);
    await advance(hub, scheduler, MIN_GAP_MS);
    // The analyst's first entry has lamport 1 and sorts before everything C2 covered, yet arrives after C2.
    const late = note(world, analyst);
    assert.equal(late.entry.header.seq, 0);
    await append(hub, world, analyst, [late]);
    await advance(hub, scheduler, MIN_GAP_MS);
    const [c1, c2, c3] = stored(hub, world.project) as [SignedCheckpoint, SignedCheckpoint, SignedCheckpoint];
    assert.ok(c3, 'three checkpoints were not signed');
    const entries = client(world).open();
    assert.deepEqual(recomputeCheckpoint(payloadOf(c2), entries, undefined, [payloadOf(c1)]), { ok: true, mismatches: [] });
    assert.deepEqual(recomputeCheckpoint(payloadOf(c3), entries, undefined, [payloadOf(c1), payloadOf(c2)]), { ok: true, mismatches: [] });
    // Without nesting the late entry would sort first: the nesting is what the hub signed.
    assert.equal(recomputeCheckpoint(payloadOf(c3), entries).ok, false);
    assert.equal(checkpointConflict(c1, c2), undefined);
    assert.equal(checkpointConflict(c2, c3), undefined);
    assert.equal(checkpointConflict(c1, c3), undefined);
  }));

test('debounce: arrivals at 0, 1 and 2 seconds give one checkpoint at 4 seconds and none before', () =>
  withSigning({}, async (hub, scheduler) => {
    const { world, analyst } = await team(hub);
    for (let second = 0; second < 3; second += 1) {
      await append(hub, world, analyst, [note(world, analyst)]);
      if (second < 2) await advance(hub, scheduler, 1000);
    }
    await advance(hub, scheduler, DEBOUNCE_MS - 1);
    assert.equal(hub.store.checkpoints(world.project).length, 0, 'signed before 4 seconds');
    await advance(hub, scheduler, 1);
    assert.equal(hub.store.checkpoints(world.project).length, 1);
    await advance(hub, scheduler, MIN_GAP_MS * 2);
    assert.equal(hub.store.checkpoints(world.project).length, 1, 'signed again with nothing new');
  }));

test('debounce: a burst 10 seconds after a checkpoint is signed 60 seconds after that checkpoint, not before, and nothing new signs nothing', () =>
  withSigning({}, async (hub, scheduler) => {
    const { world, analyst } = await team(hub);
    await append(hub, world, analyst, [note(world, analyst)]);
    await advance(hub, scheduler, DEBOUNCE_MS);
    assert.equal(hub.store.checkpoints(world.project).length, 1);
    await advance(hub, scheduler, 10_000);
    for (let index = 0; index < 3; index += 1) await append(hub, world, analyst, [note(world, analyst)]);
    await advance(hub, scheduler, MIN_GAP_MS - 10_000 - 1);
    assert.equal(hub.store.checkpoints(world.project).length, 1, 'signed sooner than 60 seconds after the previous checkpoint');
    await advance(hub, scheduler, 1);
    assert.equal(hub.store.checkpoints(world.project).length, 2);
    await advance(hub, scheduler, MIN_GAP_MS * 3);
    await ask(hub, world, analyst);
    await settle(hub);
    assert.equal(hub.store.checkpoints(world.project).length, 2, 'a covered set that did not grow was signed again');
  }));

test('ask: with new entries signs at once; a second ask 5 seconds later signs nothing; the same ask after 10 seconds signs; every checkpoint is kept', () =>
  withSigning({}, async (hub, scheduler) => {
    const { world, analyst } = await team(hub);
    const reader = await EventClient.open(hub, world.lead, world.project);
    const stream = await reader.events();
    await append(hub, world, analyst, [note(world, analyst)]);
    await ask(hub, world, analyst);
    await settle(hub);
    assert.equal(hub.store.checkpoints(world.project).length, 1, 'an ask with new entries did not sign at once');

    await append(hub, world, analyst, [note(world, analyst)]);
    await advance(hub, scheduler, 5000);
    await ask(hub, world, analyst);
    await settle(hub);
    assert.equal(hub.store.checkpoints(world.project).length, 1, 'a second ask within 10 seconds signed');
    await advance(hub, scheduler, ASK_GAP_MS - 5000);
    await ask(hub, world, analyst);
    await settle(hub);
    const kept = stored(hub, world.project);
    assert.equal(kept.length, 2);
    await stream.until((item) => item.frames.filter((frame) => frame.event === 'checkpoint').length === 2, 'two checkpoint events');
    assert.deepEqual(
      stream.frames.filter((frame) => frame.event === 'checkpoint').map((frame) => (frame.data as { checkpoint: SignedCheckpoint }).checkpoint),
      kept,
    );
    assert.deepEqual((await headsOf(hub, world, analyst)).checkpoint, kept[1]);
    const entries = client(world).open();
    assert.deepEqual(recomputeCheckpoint(payloadOf(kept[1] as SignedCheckpoint), entries, undefined, [payloadOf(kept[0] as SignedCheckpoint)]), { ok: true, mismatches: [] });

    // An ask with nothing new signs and sends nothing: the next checkpoint event is the next new checkpoint.
    await advance(hub, scheduler, ASK_GAP_MS);
    await ask(hub, world, analyst);
    await settle(hub);
    await append(hub, world, analyst, [note(world, analyst)]);
    await advance(hub, scheduler, MIN_GAP_MS);
    const all = stored(hub, world.project);
    assert.equal(all.length, 3);
    await stream.until((item) => item.frames.filter((frame) => frame.event === 'checkpoint').length >= 3, 'the third checkpoint event');
    assert.deepEqual(
      stream.frames.filter((frame) => frame.event === 'checkpoint').map((frame) => (frame.data as { checkpoint: SignedCheckpoint }).checkpoint),
      all,
    );
  }));

test('restart: a hub started again on its own database nests its next checkpoint after the ones it signed before', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-hub-checkpoints-'));
  const tls = makeTlsFixture();
  const keys = { signing: generateKeyFile('signing'), encryption: generateKeyFile('encryption') };
  const dir = path.join(root, 'state');
  try {
    mkdirSync(dir, { mode: 0o700 });
    let world: HubWorld | undefined;
    let analyst: WorldDevice | undefined;
    await withSigning({ dir, keys, tls }, async (hub, scheduler) => {
      ({ world, analyst } = await team(hub));
      await append(hub, world, world.lead, [note(world, world.lead)]);
      await advance(hub, scheduler, DEBOUNCE_MS);
    });
    assert.ok(world && analyst);
    const w = world;
    const a = analyst;
    await withSigning({ dir, keys, tls }, async (hub, scheduler) => {
      await append(hub, w, a, [note(w, a)]);
      await advance(hub, scheduler, DEBOUNCE_MS);
      const kept = stored(hub, w.project);
      assert.equal(kept.length, 2);
      assert.equal(hub.checkpointLogs.filter((line) => line.event === 'checkpoint.conflict' || line.event === 'checkpoint.waiting').length, 0);
      const entries = client(w).open();
      assert.deepEqual(recomputeCheckpoint(payloadOf(kept[1] as SignedCheckpoint), entries, undefined, [payloadOf(kept[0] as SignedCheckpoint)]), { ok: true, mismatches: [] });
      assert.equal(checkpointConflict(kept[0] as SignedCheckpoint, kept[1] as SignedCheckpoint, entries), undefined);
    });
  } finally {
    tls.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test('waiting: a restored hub keeps a newer checkpoint handed back, signs nothing while its heads are missing, then nests after it once clients re-push', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-hub-checkpoints-'));
  const tls = makeTlsFixture();
  const keys = { signing: generateKeyFile('signing'), encryption: generateKeyFile('encryption') };
  const dir = path.join(root, 'state');
  const backup = path.join(root, 'backup');
  try {
    mkdirSync(dir, { mode: 0o700 });
    let world: HubWorld | undefined;
    let analyst: WorldDevice | undefined;
    await withSigning({ dir, keys, tls }, async (hub, scheduler) => {
      ({ world, analyst } = await team(hub));
      await append(hub, world, world.lead, [note(world, world.lead)]);
      await advance(hub, scheduler, DEBOUNCE_MS);
      assert.equal(hub.store.checkpoints(world.project).length, 1);
    });
    assert.ok(world && analyst);
    const w = world;
    const a = analyst;
    // The operator's backup, taken while the hub is stopped.
    cpSync(dir, backup, { recursive: true });
    const lost = [note(w, w.lead), note(w, w.lead)];
    let newer: SignedCheckpoint | undefined;
    let first: SignedCheckpoint | undefined;
    await withSigning({ dir, keys, tls }, async (hub, scheduler) => {
      await append(hub, w, w.lead, lost);
      await advance(hub, scheduler, DEBOUNCE_MS);
      [first, newer] = stored(hub, w.project);
    });
    assert.ok(first && newer, 'the newer checkpoint was not signed');
    const c1 = first;
    const c2 = newer;

    // The backup is restored: the hub has C1 and the first note, not the two lost notes nor C2.
    await withSigning({ dir: backup, keys, tls }, async (hub, scheduler) => {
      assert.deepEqual(hub.store.checkpoints(w.project).map((record) => record.hash), [checkpointHash(c1)]);
      const answer = await ask(hub, w, a, [c2]);
      assert.equal(answer.kept, 1);
      await settle(hub);
      const waiting = hub.checkpointLogs.filter((line) => line.event === 'checkpoint.waiting');
      assert.equal(waiting.length, 1);
      assert.deepEqual(Object.keys(waiting[0]?.fields ?? {}).sort(), ['kept', 'missingHeads', 'project']);
      assert.equal(waiting[0]?.fields.project, w.project);
      assert.equal(typeof waiting[0]?.fields.missingHeads, 'number');
      assert.equal(typeof waiting[0]?.fields.kept, 'number');

      // Arrivals and asks sign nothing while C2's heads are missing.
      const meanwhile = note(w, a);
      await append(hub, w, a, [meanwhile]);
      await advance(hub, scheduler, MIN_GAP_MS);
      await ask(hub, w, a);
      await settle(hub);
      assert.equal(hub.store.checkpoints(w.project).length, 2);
      assert.ok(hub.checkpointLogs.filter((line) => line.event === 'checkpoint.waiting').length >= 2);

      // The lead's device re-pushes what the restore lost; the next checkpoint nests after C2.
      await append(hub, w, w.lead, lost);
      await advance(hub, scheduler, MIN_GAP_MS);
      const kept = stored(hub, w.project);
      assert.equal(kept.length, 3);
      const c3 = hub.store.latestCheckpoint(w.project);
      assert.ok(c3);
      const next = JSON.parse(c3.body) as SignedCheckpoint;
      assert.notEqual(c3.hash, checkpointHash(c2));
      const entries = client(w).open();
      assert.deepEqual(recomputeCheckpoint(payloadOf(next), entries, undefined, [payloadOf(c1), payloadOf(c2)]), { ok: true, mismatches: [] });
      assert.equal(checkpointConflict(c2, next), undefined);
      assert.equal(checkpointConflict(c2, next, entries), undefined);
      assert.deepEqual((await headsOf(hub, w, a)).checkpoint, next);
    });
  } finally {
    tls.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test('conflict: two kept checkpoints of this hub that do not nest stop signing for that project and log checkpoint.conflict; another project keeps signing', () =>
  withSigning({}, async (hub, scheduler) => {
    const { world, analyst } = await team(hub);
    const other = await team(hub, undefined, 'eastwind');
    const byLead = note(world, world.lead);
    const byAnalyst = note(world, analyst);
    await append(hub, world, world.lead, [byLead]);
    await append(hub, world, analyst, [byAnalyst]);
    const mine = client(world);
    const all = mine.open();
    // Both are honest on their own, and neither covers the other: one without the lead's note, one without the analyst's.
    const withoutLead = honestCheckpoint(hub, world, mine.view, all.filter((entry) => entry.hash !== byLead.hash));
    const withoutAnalyst = honestCheckpoint(hub, world, mine.view, all.filter((entry) => entry.hash !== byAnalyst.hash));
    assert.equal((await ask(hub, world, analyst, [withoutLead, withoutAnalyst])).kept, 2);
    await settle(hub);
    const conflicts = hub.checkpointLogs.filter((line) => line.event === 'checkpoint.conflict');
    assert.equal(conflicts.length, 1);
    assert.deepEqual(Object.keys(conflicts[0]?.fields ?? {}).sort(), ['kept', 'project', 'reason']);
    assert.equal(conflicts[0]?.fields.project, world.project);
    assert.equal(conflicts[0]?.fields.reason, 'not-nested');

    await append(hub, world, analyst, [note(world, analyst)]);
    await append(hub, other.world, other.analyst, [note(other.world, other.analyst)]);
    await advance(hub, scheduler, MIN_GAP_MS);
    await ask(hub, world, analyst);
    await settle(hub);
    assert.equal(hub.store.checkpoints(world.project).length, 2, 'the conflicting project was signed again');
    assert.equal(hub.store.checkpoints(other.world.project).length, 1, 'the other project stopped signing too');
    assert.equal(hub.checkpointLogs.filter((line) => line.event === 'checkpoint.conflict').length, 1);
  }));

test('conflict: a kept checkpoint of this hub whose order the hub cannot reproduce stops signing with checkpoint.conflict', () =>
  withSigning({}, async (hub, scheduler) => {
    const { world, analyst } = await team(hub);
    await append(hub, world, analyst, [note(world, analyst)]);
    await advance(hub, scheduler, DEBOUNCE_MS);
    const mine = client(world);
    const honest = payloadOf(honestCheckpoint(hub, world, mine.view, mine.open()));
    // The same heads with another order hash: a second word of this hub about one prefix.
    const forged = signCheckpoint(hub.identity.signer, { ...honest, streams: honest.streams.map((stream) => ({ ...stream, orderTip: 'f'.repeat(64) })) });
    assert.equal((await ask(hub, world, analyst, [forged])).kept, 1);
    await settle(hub);
    const conflicts = hub.checkpointLogs.filter((line) => line.event === 'checkpoint.conflict');
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]?.fields.reason, 'equal-count-tip-mismatch');
    await append(hub, world, analyst, [note(world, analyst)]);
    await advance(hub, scheduler, MIN_GAP_MS);
    assert.equal(hub.store.checkpoints(world.project).length, 2);
  }));

test('conflict: a lone kept checkpoint whose order hash the hub cannot reproduce stops signing with the order-mismatch reason', () =>
  withSigning({}, async (hub, scheduler) => {
    const { world, analyst } = await team(hub);
    await append(hub, world, analyst, [note(world, analyst)]);
    const mine = client(world);
    const honest = payloadOf(honestCheckpoint(hub, world, mine.view, mine.open()));
    const forged = signCheckpoint(hub.identity.signer, { ...honest, streams: honest.streams.map((stream) => ({ ...stream, orderTip: 'e'.repeat(64) })) });
    assert.equal((await ask(hub, world, analyst, [forged])).kept, 1);
    await settle(hub);
    const conflicts = hub.checkpointLogs.filter((line) => line.event === 'checkpoint.conflict');
    assert.deepEqual(conflicts.map((line) => line.fields.reason), ['order-mismatch']);
    await append(hub, world, analyst, [note(world, analyst)]);
    await advance(hub, scheduler, MIN_GAP_MS);
    assert.equal(hub.store.checkpoints(world.project).length, 1);
  }));

test('trimmed: granted streams past the size limit are dropped from the end of stream id order; the base cell stream stays and checkpoint.trimmed has counts', () =>
  withSigning({}, async (hub, scheduler) => {
    const cells: string[] = [];
    const { world } = await team(hub, (made) => {
      for (let index = 0; index < 200; index += 1) {
        const cell = made.world.labelCell(`sector-${index}`, [made.world.lead]).cell;
        grantToHub(hub, made.world, cell);
        cells.push(cell);
      }
    });
    const written = cells.map((cell) => note(world, world.lead, { stream: cell }));
    await append(hub, world, world.lead, written.slice(0, 100));
    await append(hub, world, world.lead, written.slice(100));
    await advance(hub, scheduler, DEBOUNCE_MS);
    const signed = stored(hub, world.project)[0] as SignedCheckpoint;
    assert.ok(signed, 'nothing was signed');
    const listed = streamsOf(signed);
    assert.ok(listed.includes(world.project), 'the base cell stream was dropped');
    assert.ok(listed.length < cells.length + 1, 'nothing was dropped');
    // The streams kept are the granted ones first in stream id order.
    const keptCells = listed.filter((stream) => stream !== world.project);
    assert.deepEqual(keptCells, [...cells].sort().slice(0, keptCells.length));
    const trimmed = hub.checkpointLogs.filter((line) => line.event === 'checkpoint.trimmed');
    assert.equal(trimmed.length, 1);
    assert.deepEqual(Object.keys(trimmed[0]?.fields ?? {}).sort(), ['dropped', 'project', 'streams']);
    assert.equal(trimmed[0]?.fields.dropped, cells.length - keptCells.length);
    const mine = client(world);
    assert.ok(verifyCheckpoint(signed, mine.view).ok, 'the trimmed checkpoint does not verify within the size limit');
    assert.deepEqual(recomputeCheckpoint(payloadOf(signed), mine.open()), { ok: true, mismatches: [] });
  }));

test('WR-05 bounded: the signer keeps only its latest checkpoint in memory, and neither an ask nor a hand-back reads every kept checkpoint again', () =>
  withSigning({}, async (hub, scheduler) => {
    const { world, analyst } = await team(hub);
    for (let round = 0; round < 4; round += 1) {
      await append(hub, world, analyst, [note(world, analyst)]);
      await advance(hub, scheduler, MIN_GAP_MS);
      await ask(hub, world, analyst);
      await settle(hub);
    }
    const kept = stored(hub, world.project);
    assert.equal(kept.length, 4);

    const store = hub.store;
    const readAll = store.checkpoints.bind(store);
    let fullReads = 0;
    store.checkpoints = (project: string) => {
      fullReads += 1;
      return readAll(project);
    };
    try {
      for (let index = 0; index < 3; index += 1) {
        await advance(hub, scheduler, ASK_GAP_MS);
        await ask(hub, world, analyst);
        await settle(hub);
      }
      // Handing back checkpoints the hub already keeps places nothing and reads no other checkpoint either.
      assert.equal((await ask(hub, world, analyst, [kept[0] as SignedCheckpoint, kept[3] as SignedCheckpoint])).kept, 0);
      await settle(hub);
      assert.equal(fullReads, 0, 'an ask or a hand-back read every kept checkpoint again');
    } finally {
      store.checkpoints = readAll;
    }
    assert.equal(hub.checkpoints?.keptInMemory(world.project), 1, 'every signed checkpoint is still held in memory');

    // Signing goes on and nests after the latest, still holding one checkpoint.
    await append(hub, world, analyst, [note(world, analyst)]);
    await advance(hub, scheduler, MIN_GAP_MS);
    const after = stored(hub, world.project);
    assert.equal(after.length, 5);
    assert.equal(hub.checkpoints?.keptInMemory(world.project), 1);
    assert.equal(hub.checkpointLogs.filter((line) => line.event === 'checkpoint.conflict' || line.event === 'checkpoint.waiting').length, 0);
    const entries = client(world).open();
    assert.deepEqual(recomputeCheckpoint(payloadOf(after[4] as SignedCheckpoint), entries, undefined, after.slice(0, 4).map(payloadOf)), { ok: true, mismatches: [] });
  }));

test('WR-05 bounded: a checkpoint handed back below the latest one makes the whole kept chain be checked again, so a second word about an old prefix still stops signing', () =>
  withSigning({}, async (hub, scheduler) => {
    const { world, analyst } = await team(hub);
    await append(hub, world, analyst, [note(world, analyst)]);
    await advance(hub, scheduler, DEBOUNCE_MS);
    const mine = client(world);
    const early = payloadOf(honestCheckpoint(hub, world, mine.view, mine.open()));
    assert.equal(hub.store.checkpoints(world.project).length, 1);
    await append(hub, world, analyst, [note(world, analyst)]);
    await advance(hub, scheduler, MIN_GAP_MS);
    assert.equal(hub.store.checkpoints(world.project).length, 2);
    assert.equal(hub.checkpoints?.keptInMemory(world.project), 1);
    // The first checkpoint's prefix with another order hash, handed back after the hub moved on.
    const forged = signCheckpoint(hub.identity.signer, { ...early, streams: early.streams.map((stream) => ({ ...stream, orderTip: 'd'.repeat(64) })) });
    assert.equal((await ask(hub, world, analyst, [forged])).kept, 1);
    await settle(hub);
    const conflicts = hub.checkpointLogs.filter((line) => line.event === 'checkpoint.conflict');
    assert.deepEqual(conflicts.map((line) => line.fields.reason), ['equal-count-tip-mismatch']);
    await append(hub, world, analyst, [note(world, analyst)]);
    await advance(hub, scheduler, MIN_GAP_MS);
    assert.equal(hub.store.checkpoints(world.project).length, 3, 'signed again after a conflicting checkpoint was handed back');
  }));

// ---- Task 3: clean shutdown ----

test('shutdown: stopping clears a pending debounce timer, so nothing is signed once shutdown starts, not even on an ask', () =>
  withSigning({}, async (hub, scheduler) => {
    const { world, analyst } = await team(hub);
    await append(hub, world, analyst, [note(world, analyst)]);
    assert.equal(hub.checkpoints?.pending(world.project), true, 'no debounce timer was set');
    hub.checkpoints?.stop();
    assert.equal(hub.checkpoints?.pending(world.project), false, 'the debounce timer was left set');
    await advance(hub, scheduler, MIN_GAP_MS * 2);
    await ask(hub, world, analyst);
    await settle(hub);
    assert.equal(hub.store.checkpoints(world.project).length, 0);
  }));

/** Reads the open stream until it ends or ms pass. */
async function ended(stream: EventStream, ms: number): Promise<boolean> {
  try {
    await stream.end(ms);
    return true;
  } catch {
    return stream.ended;
  }
}

test('shutdown: SIGTERM with an event stream open exits 0 within 6 seconds, ends the stream, logs no project text, and keeps the signed checkpoint', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-hub-checkpoints-'));
  const tlsFixture = makeTlsFixture();
  const signingLine = generateKeyFile('signing');
  const encryptionLine = generateKeyFile('encryption');
  const secrets = { HUB_TLS_CERT: tlsFixture.certPem, HUB_TLS_KEY: tlsFixture.keyPem, HUB_SIGNING_KEY: `${signingLine}\n`, HUB_ENCRYPTION_KEY: `${encryptionLine}\n` };
  const stateDir = path.join(root, 'state');
  const signing = readSigningKey(signingLine);
  const identity = hubIdentityOf(signing, readEncryptionKey(encryptionLine, signing), tlsFixture.certPem, HUB_ADDRESS);
  const runs: Array<{ cleanup(): void }> = [];
  const connections: HubConnection[] = [];
  try {
    const issue = launchHub({ args: ['--hub-file', '7'], secrets, stateDir, env: { HUB_PUBLIC_ADDRESS: HUB_ADDRESS } });
    runs.push(issue);
    assert.equal((await within(issue.exited, 20_000, 'the hub file')).code, 0, issue.stdout());
    const file = readHubFile(issue.stdout().trim(), new Date());
    assert.ok(file.ok);
    const run = await startHubProcess({ secrets, stateDir });
    runs.push(run);
    const world = createHubWorld({ causalLamport: true });
    world.admitHub(identity);
    const analyst = world.device('ANALYST', 'mbr-analyst');
    world.admitMember(analyst);
    const enrol = await HubConnection.open(run.port, identity.certPin);
    assert.equal((await enrol.post('/v1/enrol', world.enrolRequest(file.hubFile))).status, 201);
    enrol.close();
    const endpoint = {
      port: run.port,
      now: () => Date.now(),
      connect: async () => {
        const connection = await HubConnection.open(run.port, identity.certPin);
        connections.push(connection);
        return connection;
      },
    };
    const lead = await (await EventClient.open(endpoint, world.lead, world.project)).events();
    const pusher = await EventClient.open(endpoint, analyst, world.project);
    const pushed = async (written: Written): Promise<void> => {
      const answer = await pusher.call('POST', `/v1/projects/${world.project}/append`, { json: { entries: [written.entry] } });
      assert.equal(answer.status, 200, answer.text);
    };
    await pushed(note(world, analyst));
    await lead.until((item) => item.frames.some((frame) => frame.event === 'checkpoint'), 'the checkpoint event', 10_000);
    const signed = (lead.frames.find((frame) => frame.event === 'checkpoint')?.data as { checkpoint: SignedCheckpoint }).checkpoint;
    // A second arrival leaves a debounce timer pending (60 seconds from the first checkpoint) when the stop comes.
    await pushed(note(world, analyst));
    pusher.close();

    const started = Date.now();
    const stopped = await within(run.kill('SIGTERM'), 15_000, 'the stop');
    assert.equal(stopped.code, 0, run.stdout());
    assert.ok(Date.now() - started < 6000, `the stop took ${Date.now() - started} ms`);
    assert.equal(await ended(lead, 2000), true, 'the event stream did not end');
    assert.equal(lead.frames.some((frame) => frame.event === 'resync'), false, 'shutdown sent resync');
    const lines = run.logs();
    const stopIndex = lines.findIndex((line) => line.event === 'hub.stopping');
    assert.ok(stopIndex >= 0 && lines.some((line) => line.event === 'hub.stopped'), run.stdout());
    for (const line of lines.filter((item) => item.event === 'hub.stopping' || item.event === 'hub.stopped')) {
      assert.equal(JSON.stringify(line).includes(world.project), false, 'a shutdown line names the project');
    }
    assert.equal(lines.slice(stopIndex).filter((line) => line.event === 'checkpoint.signed').length, 0, 'a checkpoint was signed after the stop began');
    // The pending debounce timer of the second arrival was cleared when the stop began, and the line holds a count only.
    const cleared = lines.slice(stopIndex).find((line) => line.event === 'checkpoints.stopped');
    assert.ok(cleared, 'the checkpoint timers were not stopped');
    assert.deepEqual(Object.keys(cleared).filter((key) => !['time', 'level', 'event'].includes(key)), ['timersCleared']);
    assert.equal(cleared.timersCleared, 1);
    assert.equal(JSON.stringify(cleared).includes(world.project), false);
    assert.equal(lines.filter((line) => line.event === 'checkpoint.signed').length, 1);

    const reopened = await openHubStore(stateDir, { recoverBlobs: false });
    try {
      assert.deepEqual(reopened.checkpoints(world.project).map((record) => record.hash), [checkpointHash(signed)]);
    } finally {
      reopened.close();
    }
  } finally {
    for (const connection of connections) connection.close();
    for (const item of runs) item.cleanup();
    tlsFixture.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
