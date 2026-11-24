import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkBatch, commitBatch } from '../src/append/checks';
import type { AppendInput, AppendResult } from '../src/append/checks';
import { RosterCache } from '../src/append/rosterCache';
import { enrolProject, issueHubFile } from '../src/enrol';
import { RateLimits } from '../src/limits';
import { openHubStore } from '../src/store/hubStore';
import type { HubStore } from '../src/store/hubStore';
import { NOW_MS, WORLD_NOW, createHubWorld, makeHubIdentity } from './helpers/hubWorld';
import type { HubWorld, WorldDevice, Written } from './helpers/hubWorld';

// Phase 33, plan 07 (D-28, WR-07 hub side): a blob the hub does not hold refuses only the entry that uses it, and that writer's later entries in
// the batch meet seq-gap; every other entry of the batch is stored. All names and data are fictional.

interface Hub { store: HubStore; cache: RosterCache; limits: RateLimits; world: HubWorld; analyst: WorldDevice; close(): Promise<void> }

async function enrolledHub(): Promise<Hub> {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-hub-blob-entry-'));
  const store = await openHubStore(dir);
  const identity = makeHubIdentity();
  const world = createHubWorld();
  world.admitHub(identity);
  const analyst = world.device('ANALYST', 'mbr-analyst');
  world.admitMember(analyst);
  const issued = issueHubFile(store, identity, { days: 7, now: new Date(WORLD_NOW) });
  if (!issued.ok) throw new Error(issued.message);
  const enrolled = await enrolProject({ store, identity, now: new Date(WORLD_NOW) }, world.enrolRequest(issued.file.payload));
  assert.equal(enrolled.ok ? 'ok' : enrolled.reason, 'ok');
  return { store, cache: new RosterCache(store, identity), limits: new RateLimits(), world, analyst, async close() { store.close(); await rm(dir, { recursive: true, force: true }); } };
}

async function withHub(body: (hub: Hub) => Promise<void>): Promise<void> {
  const hub = await enrolledHub();
  try {
    await body(hub);
  } finally {
    await hub.close();
  }
}

async function push(hub: Hub, entries: readonly Written[], extra: Partial<AppendInput> = {}): Promise<AppendResult> {
  const checked = await checkBatch({ project: hub.world.project, device: hub.world.lead.writer, entries: entries.map((item) => item.entry), ...extra }, { store: hub.store, cache: hub.cache, limits: hub.limits, now: NOW_MS });
  assert.ok(checked.ok, checked.ok ? '' : `the batch was refused ${checked.reason}`);
  return commitBatch(hub.store, hub.cache, checked.checked, NOW_MS);
}

const note = (hub: Hub, device: WorldDevice, text: string): Written => hub.world.write(device, { kind: 'note.add', data: { text } });
const refusals = (result: AppendResult): Array<[string | undefined, string]> => result.refused.map((item) => [item.hash, item.reason]);
const blobOf = (text: string): { hash: string; bytes: Buffer } => {
  const bytes = Buffer.from(text);
  return { hash: createHash('sha256').update(bytes).digest('hex'), bytes };
};

test('a batch of five from two writers: the entry whose blob is missing is refused blob-missing, its writer\'s next seq-gap, and the other three are stored', () =>
  withHub(async (hub) => {
    const blob = blobOf('fictional sealed attachment');
    const w1 = note(hub, hub.world.lead, 'Lead one');
    const w2 = note(hub, hub.world.lead, 'Lead two');
    const w3 = note(hub, hub.world.lead, 'Lead three');
    const o1 = note(hub, hub.analyst, 'Analyst one');
    const o2 = note(hub, hub.analyst, 'Analyst two');
    const result = await push(hub, [w1, o1, w2, o2, w3], { blobRefs: [{ entry: w2.hash, blob: blob.hash }] });
    assert.deepEqual(refusals(result), [[w2.hash, 'blob-missing'], [w3.hash, 'seq-gap']]);
    assert.deepEqual(result.accepted, [w1.hash, o1.hash, o2.hash]);
    assert.equal(hub.store.entryByHash(hub.world.project, w2.hash), undefined);
    assert.ok(hub.store.entryByHash(hub.world.project, o2.hash));
  }));

test('a base-stream entry whose own body blob the hub does not hold is refused blob-missing for that entry only', () =>
  withHub(async (hub) => {
    const big = hub.world.write(hub.world.lead, { kind: 'note.add', data: { text: 'Fictional long report. '.repeat(1200) } });
    assert.ok(hub.world.blobs.size > 0, 'the long body travels as a blob');
    const other = note(hub, hub.analyst, 'Analyst note');
    const result = await push(hub, [big, other]);
    assert.deepEqual(refusals(result), [[big.hash, 'blob-missing']]);
    assert.deepEqual(result.accepted, [other.hash]);
  }));

test('after the blob is put, sending only the refused entries again stores them, and the heads are as if the batch had arrived whole', () =>
  withHub(async (hub) => {
    const blob = blobOf('fictional sealed attachment two');
    const w1 = note(hub, hub.world.lead, 'Lead one');
    const w2 = note(hub, hub.world.lead, 'Lead two');
    const w3 = note(hub, hub.world.lead, 'Lead three');
    const o1 = note(hub, hub.analyst, 'Analyst one');
    const first = await push(hub, [w1, w2, o1, w3], { blobRefs: [{ entry: w2.hash, blob: blob.hash }] });
    assert.deepEqual(refusals(first), [[w2.hash, 'blob-missing'], [w3.hash, 'seq-gap']]);
    await hub.store.putBlob(hub.world.project, blob.hash, blob.bytes, hub.world.lead.writer, NOW_MS);
    const again = await push(hub, [w2, w3], { blobRefs: [{ entry: w2.hash, blob: blob.hash }] });
    assert.deepEqual(refusals(again), []);
    assert.deepEqual(again.accepted, [w2.hash, w3.hash]);
    const lead = hub.store.headOf(hub.world.project, hub.world.project, hub.world.lead.writer);
    assert.deepEqual(lead, { seq: w3.seq, hash: w3.hash });
    assert.equal(hub.store.blobInfo(hub.world.project, blob.hash)?.referencedAt, NOW_MS);
  }));

test('an entry the hub already holds, sent again naming a blob it does not hold, is refused blob-missing and not counted as held', () =>
  withHub(async (hub) => {
    const blob = blobOf('fictional sealed attachment three');
    const w1 = note(hub, hub.world.lead, 'Lead one');
    assert.deepEqual((await push(hub, [w1])).accepted, [w1.hash]);
    const result = await push(hub, [w1], { blobRefs: [{ entry: w1.hash, blob: blob.hash }] });
    assert.deepEqual(refusals(result), [[w1.hash, 'blob-missing']]);
    assert.deepEqual(result.accepted, []);
    assert.deepEqual(result.held, []);
  }));
