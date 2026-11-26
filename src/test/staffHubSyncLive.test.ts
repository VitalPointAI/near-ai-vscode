// One exchange with your organization's server against the Phase 33 wire (33-07 and 33-08 share it word for word): restoring, needs-update and a
// per-entry blob-missing each end in a plain outcome; the lead's hub.readmit clears a distrusted server once; and a late joiner starts each writer
// log at a trusted checkpoint's head. The transport is a scripted object with the calls syncOnce makes, and the local replica a small in-memory one,
// so every answer is exact. All names and data are fictional.
import assert from 'node:assert/strict';
import test from 'node:test';
import { signCheckpoint } from '../domain/replica/checkpoint';
import type { Checkpoint, SignedCheckpoint } from '../domain/replica/checkpoint';
import { GENESIS_PREV, buildEntry, entryHash } from '../domain/replica/entry';
import type { SealedEntry } from '../domain/replica/entry';
import { UPDATE_SENTENCE } from '../domain/replica/features';
import { createWitness, witnessCheckpoint } from '../domain/replica/hubWitness';
import type { WitnessState } from '../domain/replica/hubWitness';
import { staticRosterView } from '../domain/replica/rosterView';
import type { RosterView } from '../domain/replica/rosterView';
import { FULL_REPLAY_SENTENCE, RESTORING_SENTENCE, syncOnce } from '../staff/replica/hubSync';
import type { HubMemory, SyncLocal, SyncTransport } from '../staff/replica/hubSync';
import type { ManagedHandoff } from '../staff/replica/managedGrantDelivery';
import { HubTransportError } from '../staff/replica/hubTransport';
import type { AppendAnswer, AppendBatch, EntriesPage, HubHeads } from '../staff/replica/hubTransport';
import { epochKey, fixedSigner, streamId } from './helpers/replicaWorld';

const PROJECT = streamId('sync-live/project');
const ROSTER = 'e'.repeat(64);
const HUB = fixedSigner('sync-live/hub');
const OTHER_HUB = fixedSigner('sync-live/other-hub');
const LEAD = fixedSigner('sync-live/lead');
const WRITER = fixedSigner('sync-live/writer');
const HUB_MEMBER = 'hub-main';
const NOW = new Date('2026-11-24T10:00:00.000Z');
const KEY = epochKey('sync-live/base');

/** The roster this computer folded: the lead, a writer and the hub (a checkpoint signer); hubReadmits answers the hashes given. */
function rosterWith(readmits: Record<string, string[]> = {}): RosterView {
  const view = staticRosterView({
    rosters: [{
      hash: ROSTER,
      checkpointSigners: [HUB.writer, OTHER_HUB.writer],
      members: [
        { member: 'mbr-lead', name: 'Avery Lead', roles: ['member'], devices: [{ writer: LEAD.writer, publicKey: LEAD.publicKey }] },
        { member: 'mbr-writer', name: 'Blake Rivers', roles: ['member'], devices: [{ writer: WRITER.writer, publicKey: WRITER.publicKey }] },
        { member: HUB_MEMBER, name: 'Sync hub', roles: ['member'], devices: [{ writer: HUB.writer, publicKey: HUB.publicKey }] },
        { member: 'hub-other', name: 'Second sync hub', roles: ['member'], devices: [{ writer: OTHER_HUB.writer, publicKey: OTHER_HUB.publicKey }] }
      ]
    }]
  });
  return { ...view, hubReadmits: (hub) => readmits[hub] ?? [] };
}

/** The writer's log in the base stream, seq 0 to count - 1. */
function writerLog(count: number, signer = WRITER, label = 'note'): SealedEntry[] {
  const log: SealedEntry[] = [];
  let prev = GENESIS_PREV;
  for (let seq = 0; seq < count; seq += 1) {
    const built = buildEntry({ signer: signer.signer, key: KEY, stream: PROJECT, seq, prev, epoch: 1, body: { deps: [], roster: ROSTER, lamport: seq + 1, at: NOW.toISOString(), actor: { kind: 'person' }, kind: 'note.add', data: { text: `Fictional ${label} ${seq}` } } });
    log.push(built.entry);
    prev = built.hash;
  }
  return log;
}

function checkpointOver(log: readonly SealedEntry[], seq: number, by = HUB, label = ''): SignedCheckpoint {
  const head = log[seq] as SealedEntry;
  const value: Checkpoint = {
    type: 'checkpoint', v: 2, project: PROJECT, signer: by.writer, rosterHead: ROSTER,
    streams: [{ stream: PROJECT, heads: [{ writer: head.header.writer, seq, hash: entryHash(head.header), lamport: seq + 1, roster: ROSTER }], count: seq + 1, orderTip: `${label}${'1'.repeat(64)}`.slice(0, 64) }]
  };
  return signCheckpoint(by.signer, value);
}

/** An in-memory replica of this computer. */
function memoryLocal(roster: RosterView | ((stored: readonly SealedEntry[]) => RosterView), own: readonly SealedEntry[] = []): SyncLocal & { stored: SealedEntry[]; kept: SignedCheckpoint[] } {
  const stored: SealedEntry[] = [...own];
  const kept: SignedCheckpoint[] = [];
  const logOf = (stream: string, writer: string): SealedEntry[] => stored.filter((entry) => entry.header.stream === stream && entry.header.writer === writer).sort((a, b) => a.header.seq - b.header.seq);
  return {
    project: PROJECT,
    writer: LEAD.writer,
    stored,
    kept,
    roster: () => Promise.resolve(typeof roster === 'function' ? roster(stored) : roster),
    heads: () => {
      const writers = [...new Set(stored.map((entry) => entry.header.writer))];
      return Promise.resolve(writers.length === 0 ? [] : [{ stream: PROJECT, heads: writers.map((writer) => { const last = logOf(PROJECT, writer).at(-1) as SealedEntry; return { writer, seq: last.header.seq, hash: entryHash(last.header) }; }) }]);
    },
    head: (stream, writer) => {
      const last = logOf(stream, writer).at(-1);
      return Promise.resolve(last === undefined ? undefined : { seq: last.header.seq, hash: entryHash(last.header) });
    },
    holds: (hashes) => Promise.resolve(new Set(hashes.filter((hash) => stored.some((entry) => entryHash(entry.header) === hash)))),
    entriesAfter: (stream, writer, seq) => Promise.resolve(logOf(stream, writer).filter((entry) => entry.header.seq > seq)),
    blob: () => Promise.resolve(undefined),
    wantedBlobs: () => Promise.resolve([]),
    blobsCitedBy: () => Promise.resolve([]),
    grants: () => Promise.resolve([]),
    ingest(entries) {
      let added = 0;
      for (const entry of entries) if (!stored.some((item) => entryHash(item.header) === entryHash(entry.header))) { stored.push(entry); added += 1; }
      return Promise.resolve({ added, notStored: entries.length - added });
    },
    putGrants: () => Promise.resolve(),
    checkpoints: () => Promise.resolve([...kept]),
    putCheckpoint: (signed) => { kept.push(signed); return Promise.resolve(); }
  };
}

function memoryOf(initial?: WitnessState): HubMemory & { saved: WitnessState[] } {
  const saved: WitnessState[] = [];
  return {
    saved,
    load: (hub, project) => Promise.resolve(saved.at(-1) ?? initial ?? createWitness(hub, project)),
    save: (state) => { saved.push(state); return Promise.resolve(); }
  };
}

interface Script {
  heads?: () => HubHeads;
  entries?: (stream: string, writer: string, from: number) => EntriesPage;
  append?: (batch: AppendBatch, call: number) => AppendAnswer;
  ask?: () => { project: string; kept: number; checkpoint?: unknown };
}

/** A scripted transport: every call recorded, every answer from the script. */
function scripted(script: Script, hub = HUB.writer): SyncTransport & { calls: string[]; from: Array<{ writer: string; from: number }>; appended: AppendBatch[] } {
  const calls: string[] = [];
  const from: Array<{ writer: string; from: number }> = [];
  const appended: AppendBatch[] = [];
  return {
    project: PROJECT,
    hub,
    calls,
    from,
    appended,
    hubHeads: () => { calls.push('heads'); return Promise.resolve(script.heads?.() ?? { project: PROJECT, rosterHead: ROSTER, streams: [], grants: [] }); },
    entries: (stream, writer, start) => {
      calls.push('entries');
      from.push({ writer, from: start });
      return Promise.resolve(script.entries?.(stream, writer, start) ?? { project: PROJECT, stream, writer, entries: [], more: false, head: null });
    },
    append: (batch) => {
      calls.push('append');
      appended.push(batch);
      try {
        return Promise.resolve(script.append?.(batch, appended.length) ?? { project: PROJECT, accepted: batch.entries.map((entry) => entryHash(entry.header)), refused: [], grantsRefused: [], rosterHead: ROSTER, blobsPut: false });
      } catch (error) {
        return Promise.reject(error);
      }
    },
    getBlob: (hash) => Promise.resolve({ kind: 'missing', hash }),
    grant: (hash) => Promise.resolve({ kind: 'missing', hash }),
    askCheckpoint: () => { calls.push('ask'); return Promise.resolve(script.ask?.() ?? { project: PROJECT, kept: 0 }); }
  } as SyncTransport & { calls: string[]; from: Array<{ writer: string; from: number }>; appended: AppendBatch[] };
}

const own = (): SealedEntry[] => writerLog(2, LEAD);
const ok = (batch: AppendBatch): AppendAnswer => ({ project: PROJECT, accepted: batch.entries.map((entry) => entryHash(entry.header)), refused: [], grantsRefused: [], rosterHead: ROSTER, blobsPut: false });

test('normal sync passes only opaque managed addresses to an explicitly configured private route', async () => {
  const outgoing = 'a'.repeat(64);
  const incoming = 'b'.repeat(64);
  const descriptor = { cell: PROJECT, recipient: WRITER.writer, info: { base: true } };
  const uploaded: unknown[] = [];
  const received: unknown[] = [];
  const secretHandoffs: string[] = [];
  const local = Object.assign(memoryLocal(rosterWith()), {
    managed: {
      seal: async (input: ManagedHandoff) => {
        assert.deepEqual(input, descriptor);
        return { handle: outgoing, packet: 'outgoing ciphertext' };
      },
      stage: async (wrapped: unknown) => {
        received.push(wrapped);
        return true;
      }
    }
  });
  const options = { now: () => NOW, managed: {
    offers: async () => [descriptor],
    pending: async () => [incoming, incoming, 'invalid-address'],
    published: async (_input: ManagedHandoff, handle: string) => { secretHandoffs.push(handle); },
    accepted: async (handle: string) => { secretHandoffs.push(handle); }
  } };
  const legacy = scripted({});
  const waiting = await syncOnce(legacy, local, memoryOf(), options);
  assert.equal(Reflect.get(waiting, 'managed'), 'waiting');
  assert.deepEqual(received, []);
  assert.deepEqual(secretHandoffs, []);

  const route = {
    put: async (...opaque: unknown[]) => { uploaded.push(opaque); return true; },
    get: async (...opaque: unknown[]) => {
      assert.deepEqual(opaque, [incoming]);
      return 'incoming ciphertext';
    }
  };
  const online = await syncOnce(Object.assign(scripted({}), { managedRoute: route }), local, memoryOf(), options);
  assert.equal(Reflect.get(online, 'managed'), 'complete');
  assert.deepEqual(uploaded, [[outgoing, 'outgoing ciphertext']]);
  assert.deepEqual(received, [{ handle: incoming, packet: 'incoming ciphertext' }]);
  assert.deepEqual(secretHandoffs.sort(), [outgoing, incoming].sort());
});

// ---- restoring, needs-update, blob-missing ---------------------------------------------------------------------------------------------------

test('restoring: a 503 append ends the exchange offline with reason restoring and its retry time; the checkpoint ask still goes and nothing is lost', async () => {
  const local = memoryLocal(rosterWith(), own());
  const transport = scripted({ append: () => { throw new HubTransportError('hub-error', { status: 503, reason: 'restoring', retryAfterSeconds: 30 }); } });
  const report = await syncOnce(transport, local, memoryOf(), { now: () => NOW });
  assert.deepEqual([report.outcome, report.reason, report.retryAfterSeconds, report.message], ['offline', 'restoring', 30, RESTORING_SENTENCE]);
  assert.ok(transport.calls.includes('ask'), 'every member\'s ask is what ends restore mode at the hub');
  assert.equal(local.stored.length, 2, 'the entries stay here, queued');
});

test('restoring: once the hub stops answering restoring, the next exchange pushes the queued entries and ends synced', async () => {
  const local = memoryLocal(rosterWith(), own());
  const memory = memoryOf();
  let restoring = true;
  const transport = scripted({ append: (batch) => { if (restoring) throw new HubTransportError('hub-error', { status: 503, reason: 'restoring', retryAfterSeconds: 30 }); return ok(batch); } });
  assert.equal((await syncOnce(transport, local, memory, { now: () => NOW })).outcome, 'offline');
  restoring = false;
  const report = await syncOnce(transport, local, memory, { now: () => NOW });
  assert.deepEqual([report.outcome, report.pushed], ['synced', 2]);
});

test('needs-update: a 403 needs-update append ends with outcome needs-update and the update sentence, never attention', async () => {
  const transport = scripted({ append: () => { throw new HubTransportError('hub-error', { status: 403, reason: 'needs-update' }); } });
  const report = await syncOnce(transport, memoryLocal(rosterWith(), own()), memoryOf(), { now: () => NOW });
  assert.deepEqual([report.outcome, report.reason, report.message], ['needs-update', 'needs-update', UPDATE_SENTENCE]);
});

test('needs-update: a session refused needs-update ends with outcome needs-update; one refused not-admitted still ends refused', async () => {
  const updating = scripted({ heads: () => { throw new HubTransportError('session-refused', { status: 403, reason: 'needs-update' }); } });
  const update = await syncOnce(updating, memoryLocal(rosterWith()), memoryOf(), { now: () => NOW });
  assert.deepEqual([update.outcome, update.message], ['needs-update', UPDATE_SENTENCE]);
  const refusing = scripted({ heads: () => { throw new HubTransportError('session-refused', { status: 403, reason: 'not-admitted' }); } });
  const refused = await syncOnce(refusing, memoryLocal(rosterWith()), memoryOf(), { now: () => NOW });
  assert.deepEqual([refused.outcome, refused.reason], ['refused', 'not-admitted']);
});

test('blob-missing: an answer refusing one entry blob-missing and the writer\'s next seq-gap sends both again on the next push pass, and the exchange ends synced', async () => {
  const local = memoryLocal(rosterWith(), writerLog(3, LEAD));
  const [zero, first, second] = local.stored.map((entry) => entryHash(entry.header));
  const transport = scripted({
    append: (batch, call) => call === 1
      ? { project: PROJECT, accepted: [zero], refused: [{ index: 1, hash: first, reason: 'blob-missing' }, { index: 2, hash: second, reason: 'seq-gap' }], grantsRefused: [], rosterHead: ROSTER, blobsPut: true }
      : ok(batch)
  });
  const report = await syncOnce(transport, local, memoryOf(), { now: () => NOW });
  assert.deepEqual([report.outcome, report.pushed, transport.appended.length], ['synced', 3, 2]);
  assert.deepEqual(transport.appended[1]?.entries.map((entry) => entryHash(entry.header)), [first, second]);
});

test('other hub-error reasons still end in attention, as before', async () => {
  const transport = scripted({ append: () => { throw new HubTransportError('hub-error', { status: 500, reason: 'internal' }); } });
  const report = await syncOnce(transport, memoryLocal(rosterWith(), own()), memoryOf(), { now: () => NOW });
  assert.equal(report.outcome, 'attention');
});

// ---- the lead's re-admission ---------------------------------------------------------------------------------------------------------------

/** A witness of HUB that saw it show two versions of the project. */
function forkedWitness(): WitnessState {
  const log = writerLog(6);
  let state = createWitness(HUB.writer, PROJECT);
  state = witnessCheckpoint(state, checkpointOver(log, 3), rosterWith()).state;
  const forked = witnessCheckpoint(state, checkpointOver(writerLog(6, WRITER, 'other branch'), 3), rosterWith());
  assert.equal(forked.state.distrusted, true);
  return forked.state;
}

const READMIT = 'a'.repeat(64);

test('readmit: after the roster folds a hub.readmit for this hub, the exchange uses a trusted witness, ends synced and saves the hash it applied', async () => {
  const memory = memoryOf(forkedWitness());
  const log = writerLog(6);
  const transport = scripted({ heads: () => ({ project: PROJECT, rosterHead: ROSTER, streams: [], grants: [], checkpoint: checkpointOver(log, 5) }) });
  const report = await syncOnce(transport, memoryLocal(rosterWith({ [HUB_MEMBER]: [READMIT] })), memory, { now: () => NOW });
  assert.equal(report.outcome, 'synced', JSON.stringify(report.findings));
  const saved = memory.saved.at(-1) as WitnessState;
  assert.deepEqual([saved.distrusted, saved.readmitted], [false, [READMIT]]);
});

test('readmit: a later distrust is not cleared by the same hub.readmit; only a new one clears it', async () => {
  const again = { ...forkedWitness(), readmitted: [READMIT] };
  const memory = memoryOf(again);
  const report = await syncOnce(scripted({ heads: () => ({ project: PROJECT, rosterHead: ROSTER, streams: [], grants: [], checkpoint: checkpointOver(writerLog(6), 5) }) }), memoryLocal(rosterWith({ [HUB_MEMBER]: [READMIT] })), memory, { now: () => NOW });
  assert.equal(report.outcome, 'attention');
  assert.ok(report.findings.some((item) => item.kind === 'forked-view'));
  assert.equal((memory.saved.at(-1) as WitnessState).distrusted, true);
});

test('readmit: a distrusted server\'s roster changes are still read, so the lead\'s hub.readmit reaches this computer through it and clears the mark in the same exchange', async () => {
  // The lead's roster change that the hub serves; once this computer holds it, its folded roster names a hub.readmit for this hub.
  const lead = writerLog(1, LEAD, 'readmit');
  const readmitHash = entryHash((lead[0] as SealedEntry).header);
  const roster = (stored: readonly SealedEntry[]): RosterView => rosterWith(stored.some((entry) => entryHash(entry.header) === readmitHash) ? { [HUB_MEMBER]: [readmitHash] } : {});
  const memory = memoryOf(forkedWitness());
  const transport = scripted({
    heads: () => ({ project: PROJECT, rosterHead: ROSTER, grants: [], streams: [{ stream: PROJECT, heads: [{ writer: LEAD.writer, seq: 0, hash: readmitHash }] }], checkpoint: checkpointOver(writerLog(6), 5) }),
    entries: (stream, writer, start) => ({ project: PROJECT, stream, writer, entries: lead.filter((entry) => entry.header.seq >= start), more: false, head: null })
  });
  const report = await syncOnce(transport, memoryLocal(roster), memory, { now: () => NOW });
  assert.equal(report.outcome, 'synced', JSON.stringify(report.findings));
  assert.deepEqual((memory.saved.at(-1) as WitnessState).readmitted, [readmitHash]);
});

test('readmit: a hub.readmit for another hub changes nothing for this one', async () => {
  const memory = memoryOf(forkedWitness());
  const report = await syncOnce(scripted({ heads: () => ({ project: PROJECT, rosterHead: ROSTER, streams: [], grants: [], checkpoint: checkpointOver(writerLog(6), 5) }) }), memoryLocal(rosterWith({ 'hub-other': [READMIT] })), memory, { now: () => NOW });
  assert.equal(report.outcome, 'attention');
  assert.equal((memory.saved.at(-1) as WitnessState).distrusted, true);
});

// ---- startFromBase -------------------------------------------------------------------------------------------------------------------------

const LOG = writerLog(63);
const headsAt = (checkpoint?: SignedCheckpoint): HubHeads => ({
  project: PROJECT, rosterHead: ROSTER, grants: [],
  streams: [{ stream: PROJECT, heads: [{ writer: WRITER.writer, seq: 62, hash: entryHash((LOG[62] as SealedEntry).header) }] }],
  ...(checkpoint === undefined ? {} : { checkpoint })
});
const pageFrom = (stream: string, writer: string, start: number, log: readonly SealedEntry[] = LOG): EntriesPage => ({ project: PROJECT, stream, writer, entries: log.filter((entry) => entry.header.seq >= start), more: false, head: null });

test('startFromBase: a fresh device with a trusted checkpoint covering the writer up to seq 60 keeps the checkpoint and pulls from 61 only', async () => {
  const local = memoryLocal(rosterWith());
  const checkpoint = checkpointOver(LOG, 60);
  const transport = scripted({ heads: () => headsAt(checkpoint), entries: (stream, writer, start) => pageFrom(stream, writer, start) });
  const report = await syncOnce(transport, local, memoryOf(), { now: () => NOW, startFromBase: true });
  assert.equal(report.outcome, 'synced', JSON.stringify(report.findings));
  assert.deepEqual(report.readInFull, [], 'the log started at the base');
  assert.deepEqual(transport.from, [{ writer: WRITER.writer, from: 61 }]);
  assert.deepEqual(local.stored.map((entry) => entry.header.seq), [61, 62]);
  assert.equal(local.kept.length, 1, 'the checkpoint base was kept first');
});

test('startFromBase: an entry that does not follow the checkpoint head is not taken', async () => {
  const local = memoryLocal(rosterWith());
  // The writer's own signature, but a log that does not run through the checkpoint's head at seq 60.
  const other = writerLog(63, WRITER, 'other branch');
  const transport = scripted({ heads: () => headsAt(checkpointOver(LOG, 60)), entries: (stream, writer, start) => pageFrom(stream, writer, start, other) });
  await syncOnce(transport, local, memoryOf(), { now: () => NOW, startFromBase: true });
  assert.deepEqual(local.stored, []);
});

test('startFromBase: without a checkpoint, or with one that does not verify for this roster, the log is pulled from 0 as before', async () => {
  for (const checkpoint of [undefined, checkpointOver(LOG, 60, fixedSigner('sync-live/stranger'))]) {
    const local = memoryLocal(rosterWith());
    const transport = scripted({ heads: () => headsAt(checkpoint), entries: (stream, writer, start) => pageFrom(stream, writer, start) });
    const report = await syncOnce(transport, local, memoryOf(), { now: () => NOW, startFromBase: true });
    // Read in full, nothing left out, and said so in plain words (33-14).
    assert.deepEqual(report.readInFull, [PROJECT]);
    assert.equal(FULL_REPLAY_SENTENCE, 'Your organization\'s server keeps no summary of this part of the project, so this computer reads all of its history. Nothing is left out.');
    assert.deepEqual(transport.from[0], { writer: WRITER.writer, from: 0 });
    assert.equal(local.stored.length, 63);
  }
  const plain = memoryLocal(rosterWith());
  const transport = scripted({ heads: () => headsAt(checkpointOver(LOG, 60)), entries: (stream, writer, start) => pageFrom(stream, writer, start) });
  await syncOnce(transport, plain, memoryOf(), { now: () => NOW });
  assert.deepEqual(transport.from[0], { writer: WRITER.writer, from: 0 }, 'without startFromBase nothing changes');
});
