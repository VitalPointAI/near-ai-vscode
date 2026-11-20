import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readHubFile } from '@ext/domain/replica/hubFile';
import { checkBatch, commitBatch } from '../src/append/checks';
import type { AppendContext, AppendInput } from '../src/append/checks';
import { RosterCache } from '../src/append/rosterCache';
import { enrolProject, issueHubFile, secretHashOf } from '../src/enrol';
import type { HubIdentity } from '../src/enrol';
import { RateLimits } from '../src/limits';
import { openHubStore } from '../src/store/hubStore';
import type { HubStore } from '../src/store/hubStore';
import { NOW_MS, WORLD_NOW, createHubWorld, makeHubIdentity } from './helpers/hubWorld';
import type { HubWorld } from './helpers/hubWorld';

// Phase 32, plan 19 (D-39 to D-44): the hub's judgement. A project reaches the hub only through enrolment with the operator's one-time hub file, and
// every entry offered after that is checked against the roster the hub folds itself, with the base cell key granted to it and no other key. These
// tests run the real store on temporary folders. All names and data are fictional.

interface Hub {
  dir: string;
  store: HubStore;
  identity: HubIdentity;
  world: HubWorld;
  cache: RosterCache;
  limits: RateLimits;
  ctx(extra?: Partial<AppendContext>): AppendContext;
  close(): Promise<void>;
}

/** A hub with the world's project enrolled: the lead's genesis, the hub admitted (D-64) and its base cell grant. */
async function enrolledHub(prepare?: (world: HubWorld, identity: HubIdentity) => void): Promise<Hub> {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-hub-append-'));
  const store = await openHubStore(dir);
  const identity = makeHubIdentity();
  const world = createHubWorld();
  world.admitHub(identity);
  prepare?.(world, identity);
  const issued = issueHubFile(store, identity, { days: 7, now: new Date(WORLD_NOW) });
  if (!issued.ok) throw new Error(issued.message);
  const enrolled = await enrolProject({ store, identity, now: new Date(WORLD_NOW) }, world.enrolRequest(issued.file.payload));
  assert.deepEqual(enrolled.ok ? 'ok' : enrolled.reason, 'ok');
  const cache = new RosterCache(store, identity);
  const limits = new RateLimits();
  return {
    dir,
    store,
    identity,
    world,
    cache,
    limits,
    ctx: (extra = {}) => ({ store, cache, limits, now: NOW_MS, ...extra }),
    async close() {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  };
}

function input(hub: Hub, entries: readonly unknown[], extra: Partial<AppendInput> = {}): AppendInput {
  return { project: hub.world.project, device: hub.world.lead.writer, entries, ...extra };
}

test('tracer: the operator issues a hub file, the lead enrols the project, then one roster entry is accepted, stored and followed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-hub-tracer-'));
  const store = await openHubStore(dir);
  try {
    const identity = makeHubIdentity();
    const world = createHubWorld();
    world.admitHub(identity);

    const issued = issueHubFile(store, identity, { days: 7, now: new Date(WORLD_NOW) });
    if (!issued.ok) throw new Error(issued.message);
    const read = readHubFile(issued.text, new Date(WORLD_NOW));
    assert.equal(read.ok, true);
    const payload = issued.file.payload;
    // Only the hash of the one-time secret is kept: the secret itself is nowhere in the store's record.
    const kept = store.enrolment(payload.enrolment);
    assert.ok(kept !== undefined);
    assert.equal(kept.secretHash, secretHashOf(payload.enrolmentSecret));
    assert.equal(JSON.stringify(kept).includes(payload.enrolmentSecret), false);
    assert.equal(kept.usedAt, undefined);

    const enrolled = await enrolProject({ store, identity, now: new Date(WORLD_NOW) }, world.enrolRequest(payload));
    assert.equal(enrolled.ok, true, enrolled.ok ? '' : enrolled.message);
    assert.equal(store.project(world.project)?.genesisHash, world.genesisHash);
    assert.equal(store.headOf(world.project, world.project, world.lead.writer)?.hash, world.head);
    assert.ok(store.enrolment(payload.enrolment)?.usedAt !== undefined);

    const cache = new RosterCache(store, identity);
    const before = await cache.get(world.project);
    assert.equal(before.head, world.head);
    // The hub holds the base cell key from the grant wrapped to its own X25519 key.
    assert.ok(before.ring(world.project, 1) !== undefined);

    const invite = world.rosterEntry(world.lead, 'member.invite', { invite: 'inv-tracer', name: 'Analyst One', seat: 'j2-analyst', roles: ['member'], clearance: { scale: 'demo', level: 'OFFICIAL', compartments: [], releasability: [] }, expiresAt: '2026-11-26T11:00:00.000Z', secretHash: 'a'.repeat(64) });
    const limits = new RateLimits();
    const checked = await checkBatch({ project: world.project, device: world.lead.writer, entries: [invite.entry] }, { store, cache, limits, now: NOW_MS });
    assert.equal(checked.ok, true, checked.ok ? '' : checked.message);
    if (!checked.ok) return;
    assert.deepEqual(checked.checked.refused, []);
    const result = commitBatch(store, cache, checked.checked, NOW_MS);
    assert.deepEqual(result.accepted, [invite.hash]);
    assert.equal(result.rosterChanged, true);
    assert.equal(store.entryByHash(world.project, invite.hash)?.hash, invite.hash);
    const after = await cache.get(world.project);
    assert.equal(after.head, invite.hash);
    assert.ok(after.state.members.invites.has('inv-tracer'));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

