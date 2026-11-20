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
