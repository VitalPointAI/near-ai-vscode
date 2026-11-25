import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { grantHash } from '@ext/domain/replica/cellKeys';
import { checkpointHash, signCheckpoint } from '@ext/domain/replica/checkpoint';
import { verifyProof } from '@ext/domain/replica/equivocation';
import { readHubFile } from '@ext/domain/replica/hubFile';
import { APPEND_REFUSALS, appendBatch, checkBatch, commitBatch } from '../src/append/checks';
import type { AppendContext, AppendInput, AppendResult } from '../src/append/checks';
import { RosterCache } from '../src/append/rosterCache';
import { enrolProject, issueHubFile, secretHashOf } from '../src/enrol';
import type { HubIdentity } from '../src/enrol';
import { LIMITS, RateLimits } from '../src/limits';
import { openHubStore } from '../src/store/hubStore';
import type { HubStore } from '../src/store/hubStore';
import { DEMO_CLEARANCE, INVITE_EXPIRES, NOW_MS, WORLD_NOW, createHubWorld, makeHubIdentity, streamOf } from './helpers/hubWorld';
import type { HubWorld, WorldDevice, WriteOptions, Written } from './helpers/hubWorld';

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


// ---- Task 2: every append outcome (D-42, D-58), equivocation (D-43), grants and blob references (D-44, D-69) ----

const DIGITS = (seed: string): string => createHash('sha256').update(seed).digest('hex');

/** Every entry the store keeps for the project, by hash. */
function storedHashes(store: HubStore, project: string): string[] {
  const hashes: string[] = [];
  for (const stream of store.heads(project)) {
    for (const head of stream.heads) for (const entry of store.entriesFrom(project, stream.stream, head.writer, 0, { limit: 10_000, maxBytes: 64 * 1024 * 1024 }).entries) hashes.push(entry.hash);
  }
  return hashes.sort();
}

/** Checks then commits one batch and returns the result. */
async function push(hub: Hub, entries: readonly unknown[], extra: Partial<AppendInput> = {}, ctx: Partial<AppendContext> = {}): Promise<AppendResult> {
  const checked = await checkBatch(input(hub, entries, extra), hub.ctx(ctx));
  if (!checked.ok) throw new Error(`the batch was refused ${checked.reason}`);
  return commitBatch(hub.store, hub.cache, checked.checked, NOW_MS);
}

/** One entry is refused with exactly this id, and the store gained nothing. */
async function expectRefused(hub: Hub, entry: unknown, reason: string, device = hub.world.lead.writer): Promise<AppendResult> {
  const before = storedHashes(hub.store, hub.world.project);
  const result = await push(hub, [entry], { device });
  assert.deepEqual(result.refused.map((item) => item.reason), [reason]);
  assert.deepEqual(result.accepted, []);
  assert.deepEqual(storedHashes(hub.store, hub.world.project), before);
  for (const item of result.refused) assert.equal(item.message, APPEND_REFUSALS[item.reason]);
  return result;
}

const note = (world: HubWorld, device: WorldDevice, extra: Partial<WriteOptions> = {}): Written => world.write(device, { kind: 'note.add', data: { text: 'Fictional note' }, ...extra });

async function withHub(prepare: ((world: HubWorld, identity: HubIdentity) => void) | undefined, body: (hub: Hub) => Promise<void>): Promise<void> {
  const hub = await enrolledHub(prepare);
  try {
    await body(hub);
  } finally {
    await hub.close();
  }
}

const analystOf = (world: HubWorld): WorldDevice => world.device('ANALYST', 'mbr-analyst');

test('malformed-header: an entry whose header is not a header is refused and nothing is stored', () =>
  withHub(undefined, async (hub) => {
    await expectRefused(hub, { header: { v: 2, stream: hub.world.project }, body: '' }, 'malformed-header');
    await expectRefused(hub, 'not an entry', 'malformed-header');
  }));

test('header-too-large: a header over 4 KiB is refused before it is read', () =>
  withHub(undefined, async (hub) => {
    const written = note(hub.world, hub.world.lead);
    await expectRefused(hub, { header: { ...written.entry.header, padding: 'x'.repeat(5000) }, body: written.entry.body }, 'header-too-large');
  }));

test('body-mismatch: a body whose size or ciphertext hash differs from the header is refused', () =>
  withHub(undefined, async (hub) => {
    const written = note(hub.world, hub.world.lead);
    const bytes = Buffer.from(written.entry.body, 'base64url');
    const flipped = Buffer.from(bytes);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] as number) ^ 1;
    await expectRefused(hub, { header: written.entry.header, body: flipped.toString('base64url') }, 'body-mismatch');
    await expectRefused(hub, { header: written.entry.header, body: bytes.subarray(0, bytes.length - 1).toString('base64url') }, 'body-mismatch');
    await expectRefused(hub, { header: written.entry.header }, 'body-mismatch');
  }));

test('body-too-large: a header naming a body over the inline limit is refused before the signature is checked', () =>
  withHub(undefined, async (hub) => {
    const written = note(hub.world, hub.world.lead);
    let calls = 0;
    const counting = (): boolean => { calls += 1; return true; };
    const before = storedHashes(hub.store, hub.world.project);
    const result = await push(hub, [{ header: { ...written.entry.header, body: { ...written.entry.header.body, size: LIMITS.inlineBodyBytes + 1 } }, body: written.entry.body }], {}, { verify: counting });
    assert.deepEqual(result.refused.map((item) => item.reason), ['body-too-large']);
    assert.equal(calls, 0);
    assert.deepEqual(storedHashes(hub.store, hub.world.project), before);
  }));

test('unknown-stream: an entry for a stream the roster does not have is refused', () =>
  withHub(undefined, async (hub) => {
    await expectRefused(hub, note(hub.world, hub.world.lead, { stream: streamOf('nowhere') }).entry, 'unknown-stream');
  }));

test('not-admitted: an entry from a device the roster never had is refused', () =>
  withHub(undefined, async (hub) => {
    const stranger = hub.world.device('STRANGER', 'mbr-stranger');
    await expectRefused(hub, note(hub.world, stranger).entry, 'not-admitted', stranger.writer);
  }));

test('bad-signature: an entry signed by another key than its writer\'s is refused', () =>
  withHub(undefined, async (hub) => {
    const first = note(hub.world, hub.world.lead);
    const second = note(hub.world, hub.world.lead, { stream: hub.world.project });
    await expectRefused(hub, { header: { ...first.entry.header, sig: second.entry.header.sig }, body: first.entry.body }, 'bad-signature');
  }));

test('revoked: an entry from a device the roster revoked is refused', () =>
  withHub((world) => {
    const analyst = analystOf(world);
    world.admitMember(analyst);
    world.rosterEntry(world.lead, 'device.revoke', { member: analyst.member, writer: analyst.writer });
  }, async (hub) => {
    const analyst = analystOf(hub.world);
    await expectRefused(hub, note(hub.world, analyst).entry, 'revoked', analyst.writer);
  }));

test('quarantined: a device the roster quarantined, with no release, is refused', () =>
  withHub((world) => {
    const analyst = analystOf(world);
    world.admitMember(analyst);
    world.rosterEntry(world.lead, 'device.quarantine', { writer: analyst.writer, stream: world.project, seq: 0 });
  }, async (hub) => {
    const analyst = analystOf(hub.world);
    await expectRefused(hub, note(hub.world, analyst).entry, 'quarantined', analyst.writer);
  }));

test('not-on-access-list: a member writing a label cell whose grants do not name it is refused', () =>
  withHub((world) => {
    world.admitMember(analystOf(world));
    world.labelCell('restricted', [world.lead]);
  }, async (hub) => {
    const analyst = analystOf(hub.world);
    const cell = streamOf('cell/restricted');
    await expectRefused(hub, note(hub.world, analyst, { stream: cell }).entry, 'not-on-access-list', analyst.writer);
    // The lead, named by the founding grant, may write it.
    const result = await push(hub, [note(hub.world, hub.world.lead, { stream: cell }).entry]);
    assert.equal(result.accepted.length, 1);
  }));

test('seq-gap: an entry beyond the next seq of its writer\'s log is refused', () =>
  withHub(undefined, async (hub) => {
    const head = hub.store.headOf(hub.world.project, hub.world.project, hub.world.lead.writer);
    assert.ok(head !== undefined);
    await expectRefused(hub, note(hub.world, hub.world.lead, { seq: head.seq + 2, prev: head.hash }).entry, 'seq-gap');
  }));

test('prev-mismatch: an entry at the next seq that does not cite the head of its writer\'s log is refused', () =>
  withHub(undefined, async (hub) => {
    const head = hub.store.headOf(hub.world.project, hub.world.project, hub.world.lead.writer);
    assert.ok(head !== undefined);
    await expectRefused(hub, note(hub.world, hub.world.lead, { seq: head.seq + 1, prev: DIGITS('another entry') }).entry, 'prev-mismatch');
  }));

test('not-a-roster-writer: a member\'s member.invite is refused', () =>
  withHub((world) => { world.admitMember(analystOf(world)); }, async (hub) => {
    const analyst = analystOf(hub.world);
    const invite = hub.world.rosterEntry(analyst, 'member.invite', { invite: 'inv-member', name: 'Someone', seat: 'j2-analyst', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: DIGITS('secret') }, { advance: false });
    await expectRefused(hub, invite.entry, 'not-a-roster-writer', analyst.writer);
  }));

test('an earlier roster cited (once roster-not-at-head, CR-01): the lead\'s change citing a roster from before the hub was admitted is stored, the hub keeps its key through the split, and the lead\'s choice resolves it', () =>
  withHub(undefined, async (hub) => {
    const { world } = hub;
    const head = (await hub.cache.get(world.project)).head;
    const late = world.rosterEntry(world.lead, 'member.invite', inviteData('inv-late'), { rosterPrev: world.genesisHash, advance: false });
    const result = await push(hub, [late.entry]);
    assert.deepEqual(result.refused, []);
    assert.deepEqual(result.accepted, [late.hash]);
    assert.ok(hub.store.entryByHash(world.project, late.hash) !== undefined);
    // It cites the genesis, where the hub admission already sits: two changes at one roster are a split, so the head goes back to the genesis.
    // The hub still holds the base cell key from the grant it kept, so it still reads the roster.
    for (const roster of [await hub.cache.get(world.project), await new RosterCache(hub.store, hub.identity).get(world.project)]) {
      assert.equal(roster.head, world.genesisHash);
      assert.ok(roster.ring(world.project, 1) !== undefined);
      assert.equal(roster.state.pending.length, 1);
    }
    const hubAdmit = (await hub.cache.get(world.project)).state.pending[0]?.branches.find((hash) => hash !== late.hash) as string;
    // The lead chooses the hub admission: the line comes back as it was, and the lead goes on from the old head.
    const choose = world.rosterEntry(world.lead, 'roster.choose', { chosen: hubAdmit }, { rosterPrev: world.genesisHash, advance: false });
    const chose = await push(hub, [choose.entry]);
    assert.deepEqual(chose.refused, []);
    const resolved = await hub.cache.get(world.project);
    assert.deepEqual(resolved.state.pending, []);
    assert.equal(resolved.head, head);
    const next = world.rosterEntry(world.lead, 'member.invite', inviteData('inv-next'), { rosterPrev: head });
    assert.deepEqual((await push(hub, [next.entry])).accepted, [next.hash]);
    assert.equal((await new RosterCache(hub.store, hub.identity).get(world.project)).head, next.hash);
  }));

test('roster-unreadable: a base-stream body that does not open with the epoch key the hub holds is refused', () =>
  withHub(undefined, async (hub) => {
    await expectRefused(hub, note(hub.world, hub.world.lead, { key: createHash('sha256').update('a key nobody granted').digest() }).entry, 'roster-unreadable');
  }));

// ---- CR-01 follow-up (D-42, D-44): a base-stream entry under an epoch the hub holds no key for yet is the writer's log; the fold judges it later ----

/** A roster entry of the lead sealed under another epoch of the base cell, advancing the world's head. */
function rosterAtEpoch(world: HubWorld, kind: string, data: Record<string, unknown>, epoch: number): Written {
  const rosterPrev = world.head;
  const written = world.write(world.lead, { kind, data: { ...data, rosterPrev }, roster: rosterPrev, epoch });
  world.head = written.hash;
  return written;
}

/** A base cell rekey to epoch 2 with its founding grant to the given devices, then the lead's first entry and a revocation of the analyst under it.
 *  The founding grant gives the hub the stream's access list; the hub reads the epoch only from a grant wrapped to it. */
function lateEpoch(hub: Hub, to: ReadonlyArray<{ writer: string; x25519: string }>): { founding: unknown; rekey: Written; first: Written; revoke: Written } {
  const { world } = hub;
  const analyst = analystOf(world);
  const founding = world.grant(world.lead, { epoch: 2, roster: world.head, to });
  const rekey = world.rosterEntry(world.lead, 'cell.rekey', { cell: world.project, epoch: 2, reason: 'scheduled', grant: grantHash(founding) });
  const first = note(world, world.lead, { epoch: 2 });
  const revoke = rosterAtEpoch(world, 'device.revoke', { member: analyst.member, writer: analyst.writer }, 2);
  return { founding, rekey, first, revoke };
}

const hubDeviceOf = (hub: Hub): { writer: string; x25519: string } => ({ writer: hub.identity.writer, x25519: hub.identity.x25519 });

test('epoch key late: the first entry under a base epoch not yet granted to the hub and a later revocation are both stored; the revocation takes effect when the grant arrives', () =>
  withHub((world) => { world.admitMember(analystOf(world)); }, async (hub) => {
    const { world } = hub;
    const analyst = analystOf(world);
    // The new epoch goes to the members first; the hub's own grant of it comes later (a separate grant at the rekey).
    const { founding, rekey, first, revoke } = lateEpoch(hub, [world.lead, analyst]);
    const toHub = world.grant(world.lead, { epoch: 2, roster: rekey.hash, to: [hubDeviceOf(hub)] });
    assert.deepEqual((await push(hub, [rekey.entry], { grants: [founding] })).accepted, [rekey.hash]);
    // A batch with no grant: what the hub cannot open is still kept in the cached roster, so the later grant folds it without a reload.
    const pushed = await push(hub, [first.entry, revoke.entry]);
    assert.deepEqual(pushed.refused, []);
    assert.deepEqual(pushed.accepted, [first.hash, revoke.hash]);
    assert.equal(hub.store.headOf(world.project, world.project, world.lead.writer)?.hash, revoke.hash);
    // Without the epoch key the hub cannot read the revocation yet: the analyst is still admitted and the roster stops at the rekey.
    for (const roster of [await hub.cache.get(world.project), await new RosterCache(hub.store, hub.identity).get(world.project)]) {
      assert.equal(roster.ring(world.project, 2), undefined);
      assert.equal(roster.head, rekey.hash);
      assert.equal(roster.standing(analyst.writer), 'admitted');
    }
    // The hub's grant arrives on its own: the hub folds the entries it kept, and the revocation is in force at once.
    const granted = await push(hub, [], { grants: [toHub] });
    assert.deepEqual(granted.grants.refused, []);
    assert.equal(granted.grants.stored.length, 1);
    assert.equal(granted.rosterChanged, true);
    assert.equal(granted.rosterHead, revoke.hash);
    for (const roster of [await hub.cache.get(world.project), await new RosterCache(hub.store, hub.identity).get(world.project)]) {
      assert.equal(roster.head, revoke.hash);
      assert.equal(roster.standing(analyst.writer), 'revoked');
    }
    await expectRefused(hub, note(world, analyst).entry, 'revoked', analyst.writer);
    // The lead's log goes on under the new epoch.
    const next = note(world, world.lead, { epoch: 2 });
    assert.deepEqual((await push(hub, [next.entry])).accepted, [next.hash]);
  }));

test('epoch key late, hub restarted: the kept entries are loaded from the store and the grant that arrives after the restart folds them', () =>
  withHub((world) => { world.admitMember(analystOf(world)); }, async (hub) => {
    const { world } = hub;
    const analyst = analystOf(world);
    const { founding, rekey, first, revoke } = lateEpoch(hub, [world.lead, analyst]);
    const toHub = world.grant(world.lead, { epoch: 2, roster: rekey.hash, to: [hubDeviceOf(hub)] });
    assert.deepEqual((await push(hub, [rekey.entry, first.entry, revoke.entry], { grants: [founding] })).refused, []);
    const restarted = new RosterCache(hub.store, hub.identity);
    const checked = await checkBatch(input(hub, [], { grants: [toHub] }), hub.ctx({ cache: restarted }));
    assert.ok(checked.ok);
    const granted = commitBatch(hub.store, restarted, checked.checked, NOW_MS);
    assert.equal(granted.rosterHead, revoke.hash);
    assert.equal((await restarted.get(world.project)).standing(analyst.writer), 'revoked');
  }));

test('epoch key late, grant in the same batch after the entries: every entry is stored and the revocation applies in that batch', () =>
  withHub((world) => { world.admitMember(analystOf(world)); }, async (hub) => {
    const { world } = hub;
    const analyst = analystOf(world);
    const { founding, rekey, first, revoke } = lateEpoch(hub, [world.lead, analyst, hubDeviceOf(hub)]);
    const result = await push(hub, [rekey.entry, first.entry, revoke.entry], { grants: [founding] });
    assert.deepEqual(result.refused, []);
    assert.deepEqual(result.accepted, [rekey.hash, first.hash, revoke.hash]);
    assert.equal(result.rosterHead, revoke.hash);
    assert.equal((await hub.cache.get(world.project)).standing(analyst.writer), 'revoked');
  }));

test('founding grant late: entries under the new epoch wait on a retryable refusal (not-on-access-list) and are accepted with the grant on the next push', () =>
  withHub((world) => { world.admitMember(analystOf(world)); }, async (hub) => {
    const { world } = hub;
    const analyst = analystOf(world);
    const { founding, rekey, first, revoke } = lateEpoch(hub, [world.lead, analyst, hubDeviceOf(hub)]);
    const early = await push(hub, [rekey.entry, first.entry, revoke.entry]);
    assert.deepEqual(early.accepted, [rekey.hash]);
    assert.deepEqual(early.refused.map((item) => item.reason), ['not-on-access-list', 'not-on-access-list']);
    const again = await push(hub, [first.entry, revoke.entry], { grants: [founding] });
    assert.deepEqual(again.refused, []);
    assert.deepEqual(again.accepted, [first.hash, revoke.hash]);
    assert.equal((await hub.cache.get(world.project)).standing(analyst.writer), 'revoked');
  }));

test('epoch key never granted (zero knowledge): a base epoch the hub is left out of is kept as ciphertext it cannot read, and the writer\'s log is never cut', () =>
  withHub((world) => { world.admitMember(analystOf(world)); }, async (hub) => {
    const { world } = hub;
    const analyst = analystOf(world);
    const { founding, rekey, first, revoke } = lateEpoch(hub, [world.lead, analyst]);
    const result = await push(hub, [rekey.entry, first.entry, revoke.entry], { grants: [founding] });
    assert.deepEqual(result.refused, []);
    assert.deepEqual(result.accepted, [rekey.hash, first.hash, revoke.hash]);
    const roster = await hub.cache.get(world.project);
    assert.equal(roster.ring(world.project, 2), undefined);
    assert.equal(roster.head, rekey.hash);
    assert.equal(hub.store.entryByHash(world.project, revoke.hash)?.body, revoke.entry.body);
    const later = note(world, world.lead, { epoch: 2 });
    assert.deepEqual((await push(hub, [later.entry])).accepted, [later.hash]);
  }));

test('batch-too-large: 201 entries are refused as a whole and nothing is stored', () =>
  withHub(undefined, async (hub) => {
    const written = note(hub.world, hub.world.lead);
    const before = storedHashes(hub.store, hub.world.project);
    const checked = await checkBatch(input(hub, Array.from({ length: 201 }, () => written.entry)), hub.ctx());
    assert.equal(checked.ok ? 'ok' : checked.reason, 'batch-too-large');
    assert.deepEqual(storedHashes(hub.store, hub.world.project), before);
  }));

test('unknown-project: a batch for a project the hub does not hold is refused as a whole', () =>
  withHub(undefined, async (hub) => {
    const checked = await checkBatch({ ...input(hub, []), project: streamOf('another project') }, hub.ctx());
    assert.equal(checked.ok ? 'ok' : checked.reason, 'unknown-project');
  }));

test('held: the same entry again is listed accepted and nothing new is stored', () =>
  withHub(undefined, async (hub) => {
    const written = note(hub.world, hub.world.lead);
    const first = await push(hub, [written.entry]);
    assert.deepEqual(first.accepted, [written.hash]);
    assert.deepEqual(first.held, []);
    const before = storedHashes(hub.store, hub.world.project);
    const again = await push(hub, [written.entry, written.entry]);
    assert.deepEqual(again.accepted, [written.hash]);
    assert.deepEqual(again.held, [written.hash, written.hash]);
    assert.deepEqual(again.refused, []);
    assert.deepEqual(again.stored, []);
    assert.deepEqual(storedHashes(hub.store, hub.world.project), before);
  }));

test('a label cell entry from a granted member is accepted and stored as ciphertext the hub holds no key for', () =>
  withHub((world) => {
    const analyst = analystOf(world);
    world.admitMember(analyst);
    world.labelCell('ops', [world.lead, analyst]);
  }, async (hub) => {
    const analyst = analystOf(hub.world);
    const cell = streamOf('cell/ops');
    const written = note(hub.world, analyst, { stream: cell, data: { text: 'Fictional canary line' } });
    const result = await push(hub, [written.entry], { device: analyst.writer });
    assert.deepEqual(result.accepted, [written.hash]);
    const roster = await hub.cache.get(hub.world.project);
    assert.equal(roster.ring(cell, 1), undefined);
    assert.deepEqual(roster.accessList(cell), [hub.world.lead.writer, analyst.writer].sort());
    const kept = hub.store.entryByHash(hub.world.project, written.hash);
    assert.equal(kept?.body, written.entry.body);
    assert.equal(Buffer.from(kept.body, 'base64url').includes(Buffer.from('Fictional canary line')), false);
  }));

test('equivocation: a second validly signed header at a used seq is stored as proof, the first stays, and the writer is quarantined until released or revoked', () =>
  withHub((world) => {
    const analyst = analystOf(world);
    world.admitMember(analyst);
    world.labelCell('ops', [world.lead, analyst]);
  }, async (hub) => {
    const { world, store } = hub;
    const analyst = analystOf(world);
    const cell = streamOf('cell/ops');
    const first = note(world, analyst);
    assert.deepEqual((await push(hub, [first.entry], { device: analyst.writer })).accepted, [first.hash]);

    // The same plaintext sealed again is a second signed header at seq 0 (32-RESEARCH Pitfall 1).
    const fork = note(world, analyst, { seq: 0 });
    assert.notEqual(fork.hash, first.hash);
    const before = storedHashes(store, world.project);
    const forked = await push(hub, [fork.entry], { device: analyst.writer });
    assert.deepEqual(forked.refused.map((item) => item.reason), ['equivocation']);
    assert.deepEqual(storedHashes(store, world.project), before);
    assert.equal(store.entryAt(world.project, world.project, analyst.writer, 0)?.hash, first.hash);
    const proofs = store.equivocations(world.project);
    assert.equal(proofs.length, 1);
    assert.equal(verifyProof(JSON.parse(proofs[0]?.proof as string) as unknown), true);
    assert.deepEqual({ writer: proofs[0]?.writer, stream: proofs[0]?.stream, seq: proofs[0]?.seq }, { writer: analyst.writer, stream: world.project, seq: 0 });
    assert.equal(forked.equivocations.length, 1);

    // Refused everywhere: its next entry in another stream is quarantined.
    const elsewhere = note(world, analyst, { stream: cell });
    await expectRefused(hub, elsewhere.entry, 'quarantined', analyst.writer);

    // The lead releases that place: the writer is accepted again.
    const release = world.rosterEntry(world.lead, 'device.release', { writer: analyst.writer, stream: world.project, seq: 0, branch: first.hash });
    assert.deepEqual((await push(hub, [release.entry])).accepted, [release.hash]);
    assert.deepEqual((await push(hub, [elsewhere.entry], { device: analyst.writer })).accepted, [elsewhere.hash]);

    // After device.revoke it is refused revoked.
    const revoke = world.rosterEntry(world.lead, 'device.revoke', { member: analyst.member, writer: analyst.writer });
    assert.deepEqual((await push(hub, [revoke.entry])).accepted, [revoke.hash]);
    await expectRefused(hub, note(world, analyst, { stream: cell }).entry, 'revoked', analyst.writer);

    // A fresh roster fold from the store agrees with the cache.
    const reloaded = new RosterCache(store, hub.identity);
    assert.equal((await reloaded.get(world.project)).standing(analyst.writer), 'revoked');
  }));

test('equivocation proofs stored before a restart still quarantine the writer after the roster is loaded again', () =>
  withHub((world) => { world.admitMember(analystOf(world)); }, async (hub) => {
    const analyst = analystOf(hub.world);
    const first = note(hub.world, analyst);
    await push(hub, [first.entry], { device: analyst.writer });
    await push(hub, [note(hub.world, analyst, { seq: 0 }).entry], { device: analyst.writer });
    const reloaded = new RosterCache(hub.store, hub.identity);
    assert.equal((await reloaded.get(hub.world.project)).standing(analyst.writer), 'quarantined');
  }));

test('an invalid second header at a used seq is bad-signature and records nothing', () =>
  withHub((world) => { world.admitMember(analystOf(world)); }, async (hub) => {
    const analyst = analystOf(hub.world);
    const first = note(hub.world, analyst);
    await push(hub, [first.entry], { device: analyst.writer });
    const fork = note(hub.world, analyst, { seq: 0 });
    const other = note(hub.world, hub.world.lead);
    await expectRefused(hub, { header: { ...fork.entry.header, sig: other.entry.header.sig }, body: fork.entry.body }, 'bad-signature', analyst.writer);
    assert.deepEqual(hub.store.equivocations(hub.world.project), []);
    assert.equal((await hub.cache.get(hub.world.project)).standing(analyst.writer), 'admitted');
  }));

test('grants: a cell.create with its founding grant in one batch places the grant and its grantees become the access list', () =>
  withHub((world) => { world.admitMember(analystOf(world)); }, async (hub) => {
    const analyst = analystOf(hub.world);
    const created = hub.world.labelCell('plans', [hub.world.lead, analyst]);
    const first = note(hub.world, analyst, { stream: created.cell });
    const result = await push(hub, [created.entry.entry, first.entry], { grants: [created.grant] });
    assert.deepEqual(result.accepted, [created.entry.hash, first.hash]);
    assert.deepEqual(result.grants.refused, []);
    assert.equal(result.grants.stored.length, 1);
    assert.ok(hub.store.grant(hub.world.project, result.grants.stored[0] as string) !== undefined);
    assert.equal(result.rosterChanged, true);
    const roster = await hub.cache.get(hub.world.project);
    assert.deepEqual(roster.accessList(created.cell), [hub.world.lead.writer, analyst.writer].sort());
  }));

test('grants: a grant signed by a member is refused grant-not-placed and not stored', () =>
  withHub((world) => { world.admitMember(analystOf(world)); }, async (hub) => {
    const analyst = analystOf(hub.world);
    const stranger = hub.world.device('STRANGER', 'mbr-stranger');
    const forged = hub.world.grant(analyst, { roster: hub.world.head, to: [analyst, stranger] });
    const result = await push(hub, [], { device: analyst.writer, grants: [forged, { not: 'a grant' }] });
    assert.deepEqual(result.grants.refused.map((item) => [item.index, item.reason]), [[0, 'grant-not-placed'], [1, 'grant-not-placed']]);
    assert.deepEqual(result.grants.stored, []);
    assert.equal(hub.store.grants(hub.world.project).some((grant) => grant.body.includes(stranger.writer)), false);
  }));

test('blob references: a blob the hub does not hold refuses the entry that names it with blob-missing (per entry since Phase 33 D-28, no longer the whole batch); a held blob is marked referenced', () =>
  withHub(undefined, async (hub) => {
    const written = note(hub.world, hub.world.lead);
    const blobBytes = Buffer.from('fictional sealed blob bytes');
    const blobHash = createHash('sha256').update(blobBytes).digest('hex');
    const before = storedHashes(hub.store, hub.world.project);
    const missing = await checkBatch(input(hub, [written.entry], { blobRefs: [{ entry: written.hash, blob: blobHash }] }), hub.ctx());
    assert.ok(missing.ok, 'the batch itself is taken; the entry is refused on its own (Phase 33 D-28)');
    assert.deepEqual(missing.checked.refused.map((item) => [item.hash, item.reason]), [[written.hash, 'blob-missing']]);
    assert.deepEqual(missing.checked.entries, []);
    assert.deepEqual(storedHashes(hub.store, hub.world.project), before);

    await hub.store.putBlob(hub.world.project, blobHash, blobBytes, hub.world.lead.writer, NOW_MS);
    assert.equal(hub.store.blobInfo(hub.world.project, blobHash)?.referencedAt, undefined);
    const result = await push(hub, [written.entry], { blobRefs: [{ entry: written.hash, blob: blobHash }] });
    assert.deepEqual(result.accepted, [written.hash]);
    assert.equal(hub.store.blobInfo(hub.world.project, blobHash)?.referencedAt, NOW_MS);
  }));

test('a store failure in commitAppend accepts nothing and leaves the cached head and roster as they were', () =>
  withHub(undefined, async (hub) => {
    const before = await hub.cache.get(hub.world.project);
    const stored = storedHashes(hub.store, hub.world.project);
    const invite = hub.world.rosterEntry(hub.world.lead, 'member.invite', { invite: 'inv-lost', name: 'Someone', seat: 'j2-analyst', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: DIGITS('secret') });
    const checked = await checkBatch(input(hub, [invite.entry]), hub.ctx());
    assert.ok(checked.ok);
    assert.equal(checked.checked.rosterChanged, true);
    const failing = Object.create(hub.store) as HubStore;
    failing.commitAppend = () => { throw new Error('the disk is full'); };
    assert.throws(() => commitBatch(failing, hub.cache, checked.checked, NOW_MS), /the disk is full/);
    assert.equal(hub.cache.peek(hub.world.project), before);
    assert.equal((await hub.cache.get(hub.world.project)).head, before.head);
    assert.deepEqual(storedHashes(hub.store, hub.world.project), stored);
  }));

test('a roster entry the fold refuses is still stored as the writer\'s log and the head does not move', () =>
  withHub(undefined, async (hub) => {
    const head = (await hub.cache.get(hub.world.project)).head;
    const stranger = hub.world.device('STRANGER', 'mbr-stranger');
    // An admission for an invitation the roster never had: the fold refuses it (invite-unknown).
    const admit = hub.world.rosterEntry(hub.world.lead, 'member.admit', { member: 'mbr-stranger', invite: 'inv-none', name: 'Stranger', seat: 'j2-analyst', roles: ['member'], clearance: DEMO_CLEARANCE, device: stranger.descriptor(40) }, { advance: false });
    const result = await push(hub, [admit.entry]);
    assert.deepEqual(result.accepted, [admit.hash]);
    assert.equal(result.rosterChanged, false);
    assert.equal(result.rosterHead, head);
    assert.ok(hub.store.entryByHash(hub.world.project, admit.hash) !== undefined);
    const roster = await hub.cache.get(hub.world.project);
    assert.equal(roster.head, head);
    assert.ok(roster.state.refused.some((item) => item.hash === admit.hash));
    // The lead's next roster entry still cites that head and is accepted.
    const invite = hub.world.rosterEntry(hub.world.lead, 'member.invite', { invite: 'inv-next', name: 'Someone', seat: 'j2-analyst', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: DIGITS('secret') });
    assert.deepEqual((await push(hub, [invite.entry])).accepted, [invite.hash]);
  }));

// ---- CR-01 (D-09, D-11, D-42): a roster entry citing an older roster head is the writer's log; the hub's roster fold decides what it does ----

const deputyOf = (world: HubWorld): WorldDevice => world.device('DEPUTY', 'mbr-deputy');
const inviteData = (invite: string): Record<string, unknown> => ({ invite, name: 'Someone', seat: 'j2-analyst', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: DIGITS(invite) });

/** The enrolled world with a deputy lead (an admitted member named deputy by the lead). */
const withDeputy = (world: HubWorld): void => {
  const deputy = deputyOf(world);
  world.admitMember(deputy);
  world.rosterEntry(world.lead, 'deputy.name', { member: deputy.member });
};

test('CR-01 roster race: the lead and the deputy each change the roster at one head; both are stored, the hub shows a split, and the lead\'s roster.choose resolves it', () =>
  withHub(withDeputy, async (hub) => {
    const { world } = hub;
    const deputy = deputyOf(world);
    const head = (await hub.cache.get(world.project)).head;
    const byDeputy = world.rosterEntry(deputy, 'member.invite', inviteData('inv-deputy'), { advance: false });
    const byLead = world.rosterEntry(world.lead, 'member.invite', inviteData('inv-lead'), { advance: false });
    // The deputy pushes first: its change applies at the hub.
    assert.deepEqual((await push(hub, [byDeputy.entry], { device: deputy.writer })).accepted, [byDeputy.hash]);
    assert.equal((await hub.cache.get(world.project)).head, byDeputy.hash);
    // The lead's change cites the same head. It is the lead's log, so it is stored, and the fold now holds a split at that head.
    const raced = await push(hub, [byLead.entry]);
    assert.deepEqual(raced.refused, []);
    assert.deepEqual(raced.accepted, [byLead.hash]);
    assert.ok(hub.store.entryByHash(world.project, byLead.hash) !== undefined);
    const split = await hub.cache.get(world.project);
    assert.equal(split.head, head);
    assert.deepEqual(split.state.pending.map((item) => ({ at: item.at, branches: item.branches })), [{ at: head, branches: [byDeputy.hash, byLead.hash].sort() }]);
    // A fresh fold from the store agrees with the cache.
    assert.equal((await new RosterCache(hub.store, hub.identity).get(world.project)).head, head);

    // The lead chooses its own change: the choice and the chosen change apply, and the lead's log goes on.
    const choose = world.rosterEntry(world.lead, 'roster.choose', { chosen: byLead.hash }, { rosterPrev: head });
    const chose = await push(hub, [choose.entry]);
    assert.deepEqual(chose.refused, []);
    assert.deepEqual(chose.accepted, [choose.hash]);
    const resolved = await hub.cache.get(world.project);
    assert.deepEqual(resolved.state.pending, []);
    assert.equal(resolved.head, byLead.hash);
    assert.ok(resolved.state.notChosen.has(byDeputy.hash));
    world.head = byLead.hash;
    const next = world.rosterEntry(world.lead, 'member.invite', inviteData('inv-after'));
    assert.deepEqual((await push(hub, [next.entry])).accepted, [next.hash]);
    assert.equal((await hub.cache.get(world.project)).head, next.hash);
  }));

test('CR-01 no wedge: after a roster entry citing an older head, the same device\'s later base-stream entries are still accepted (its log is not cut)', () =>
  withHub(withDeputy, async (hub) => {
    const { world } = hub;
    const deputy = deputyOf(world);
    const head = world.head;
    const byDeputy = world.rosterEntry(deputy, 'member.invite', inviteData('inv-deputy'), { advance: false });
    await push(hub, [byDeputy.entry], { device: deputy.writer });
    const byLead = world.rosterEntry(world.lead, 'member.invite', inviteData('inv-lead'), { rosterPrev: head, advance: false });
    // The lead goes on writing in its own log: a note citing the roster it knows.
    const later = note(world, world.lead, { roster: head });
    const result = await push(hub, [byLead.entry, later.entry]);
    assert.deepEqual(result.refused, []);
    assert.deepEqual(result.accepted, [byLead.hash, later.hash]);
    assert.equal(hub.store.headOf(world.project, world.project, world.lead.writer)?.hash, later.hash);
  }));

test('CR-01 handover race: the lead\'s roster entry written offline is stored after the deputy took over the lead, and makes a split for the new lead to choose', () =>
  withHub(withDeputy, async (hub) => {
    const { world } = hub;
    const deputy = deputyOf(world);
    const head = world.head;
    // Offline, the lead invites someone at head H. Meanwhile the deputy, finding the lead lost, takes over the lead at the same head.
    const offline = world.rosterEntry(world.lead, 'member.invite', inviteData('inv-offline'), { advance: false });
    const handover = world.rosterEntry(deputy, 'lead.handover', { to: deputy.member, reason: 'lead-lost' }, { advance: false });
    assert.deepEqual((await push(hub, [handover.entry], { device: deputy.writer })).accepted, [handover.hash]);
    assert.equal((await hub.cache.get(world.project)).isRosterWriter(world.lead.writer), false);
    // The old lead's entry reaches the hub later. At H the old lead was the lead, so it is stored and the fold splits there.
    const result = await push(hub, [offline.entry]);
    assert.deepEqual(result.refused, []);
    assert.deepEqual(result.accepted, [offline.hash]);
    const roster = await hub.cache.get(world.project);
    assert.equal(roster.head, head);
    assert.deepEqual(roster.state.pending.map((item) => item.branches), [[handover.hash, offline.hash].sort()]);
  }));

test('CR-01 still refused: a roster entry by a device that is not a roster writer at the roster it cites is refused not-a-roster-writer and stored nowhere', () =>
  withHub(withDeputy, async (hub) => {
    const { world } = hub;
    const analyst = analystOf(world);
    const admitted = world.admitMember(analyst);
    await push(hub, [admitted.invite.entry, admitted.admit.entry], { grants: admitted.grant === undefined ? [] : [admitted.grant] });
    // At the hub's head the analyst is a plain member, and at the older roster it cites it was not even admitted.
    const atHead = world.write(analyst, { kind: 'member.invite', data: { ...inviteData('inv-a'), rosterPrev: world.head }, roster: world.head, seq: 0 });
    await expectRefused(hub, atHead.entry, 'not-a-roster-writer', analyst.writer);
    const atGenesis = world.write(analyst, { kind: 'member.invite', data: { ...inviteData('inv-b'), rosterPrev: world.genesisHash }, roster: world.genesisHash, seq: 0 });
    await expectRefused(hub, atGenesis.entry, 'not-a-roster-writer', analyst.writer);
  }));

test('appendBatch runs one batch at a time per project, so two roster changes citing one head are judged in turn: the second makes a split', () =>
  withHub(undefined, async (hub) => {
    const a = hub.world.rosterEntry(hub.world.lead, 'member.invite', { invite: 'inv-a', name: 'Someone', seat: 'j2-analyst', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: DIGITS('a') }, { advance: false });
    const b = hub.world.rosterEntry(hub.world.lead, 'member.invite', { invite: 'inv-b', name: 'Someone', seat: 'j2-analyst', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: DIGITS('b') }, { advance: false });
    const [first, second] = await Promise.all([appendBatch(input(hub, [a.entry]), hub.ctx()), appendBatch(input(hub, [b.entry]), hub.ctx())]);
    assert.ok(first.ok && second.ok);
    assert.deepEqual(first.result.accepted, [a.hash]);
    // b follows a in the lead's log but cites the roster before a: checked after a was stored, the fold sees two changes at one roster.
    assert.equal(first.result.rosterHead, a.hash);
    assert.deepEqual(second.result.refused, []);
    assert.deepEqual(second.result.accepted, [b.hash]);
    const roster = await hub.cache.get(hub.world.project);
    assert.deepEqual(roster.state.pending.map((item) => item.branches), [[a.hash, b.hash].sort()]);
    assert.equal(second.result.rosterHead, roster.head);
  }));

// ---- WR-02 (D-42, D-54): after a restore, a device revoked since re-pushes places a checkpoint this hub kept already covers ----

/** Keeps a checkpoint signed by this hub whose heads name these places (counts and order hashes are not read by the append checks). */
function keepCheckpoint(hub: Hub, heads: ReadonlyArray<{ stream: string; written: Written }>): void {
  const streams = [...new Set(heads.map((item) => item.stream))].sort().map((stream) => ({
    stream,
    heads: heads.filter((item) => item.stream === stream).map((item) => ({ writer: item.written.writer, seq: item.written.seq, hash: item.written.hash, lamport: item.written.seq + 1, roster: hub.world.head })),
    count: heads.filter((item) => item.stream === stream).length,
    orderTip: DIGITS(`tip ${stream}`)
  }));
  const signed = signCheckpoint(hub.identity.signer, { type: 'checkpoint', v: 2, project: hub.world.project, signer: hub.identity.writer, rosterHead: hub.world.head, streams });
  assert.equal(hub.store.putCheckpoint(hub.world.project, { hash: checkpointHash(signed), body: JSON.stringify(signed), signedAt: NOW_MS, receivedAt: NOW_MS }), 'stored');
}

test('WR-02 restore: entries of a device revoked since, at places a checkpoint this hub kept covers, are accepted again; a place beyond it or another entry at it is refused revoked', () =>
  withHub((world) => { world.admitMember(analystOf(world)); }, async (hub) => {
    const { world } = hub;
    const analyst = analystOf(world);
    const first = note(world, analyst);
    const second = note(world, analyst);
    // Before the restore the hub had both entries and signed a checkpoint naming the second as the analyst's head.
    keepCheckpoint(hub, [{ stream: world.project, written: second }]);
    // The restored hub gets the lead's revocation back first (hubSync pushes the base stream first).
    const revoke = world.rosterEntry(world.lead, 'device.revoke', { member: analyst.member, writer: analyst.writer });
    assert.deepEqual((await push(hub, [revoke.entry])).accepted, [revoke.hash]);
    assert.equal((await hub.cache.get(world.project)).standing(analyst.writer), 'revoked');

    // Another entry at the covered head's place is not the one the checkpoint names.
    const other = note(world, analyst, { seq: 1, prev: first.hash, data: { text: 'Fictional other note' } });
    const third = note(world, analyst);
    const result = await push(hub, [first.entry, other.entry, second.entry, third.entry], { device: world.lead.writer });
    assert.deepEqual(result.accepted, [first.hash, second.hash]);
    assert.deepEqual(result.refused.map((item) => [item.index, item.reason]), [[1, 'revoked'], [3, 'revoked']]);
    assert.equal(hub.store.headOf(world.project, world.project, analyst.writer)?.hash, second.hash);
  }));

test('WR-02 restore: without a kept checkpoint covering the place, an entry of a revoked device is still refused revoked', () =>
  withHub((world) => { world.admitMember(analystOf(world)); }, async (hub) => {
    const { world } = hub;
    const analyst = analystOf(world);
    const written = note(world, analyst);
    const revoke = world.rosterEntry(world.lead, 'device.revoke', { member: analyst.member, writer: analyst.writer });
    await push(hub, [revoke.entry]);
    await expectRefused(hub, written.entry, 'revoked', world.lead.writer);
  }));

// ---- IN-01 (D-44, D-69): a blob reference on an entry the hub already holds is kept only from that entry's own writer ----

test('IN-01 blob references: another device naming a blob for an entry the hub already holds is dropped, so the upload stays unreferenced; the writer\'s own is kept', () =>
  withHub((world) => { world.admitMember(analystOf(world)); }, async (hub) => {
    const { world } = hub;
    const analyst = analystOf(world);
    const written = note(world, analyst);
    assert.deepEqual((await push(hub, [written.entry], { device: analyst.writer })).accepted, [written.hash]);
    const blobBytes = Buffer.from('fictional sealed blob bytes of the lead');
    const blobHash = createHash('sha256').update(blobBytes).digest('hex');
    await hub.store.putBlob(world.project, blobHash, blobBytes, world.lead.writer, NOW_MS);

    // The lead re-pushes the analyst's entry naming its own upload: the entry is held, the reference is not kept.
    const byLead = await push(hub, [written.entry], { device: world.lead.writer, blobRefs: [{ entry: written.hash, blob: blobHash }] });
    assert.deepEqual(byLead.held, [written.hash]);
    assert.equal(hub.store.blobInfo(world.project, blobHash)?.referencedAt, undefined, 'a device attached its upload to another writer\'s entry');

    // The analyst's own device may name a blob for its entry.
    const byWriter = await push(hub, [written.entry], { device: analyst.writer, blobRefs: [{ entry: written.hash, blob: blobHash }] });
    assert.deepEqual(byWriter.held, [written.hash]);
    assert.equal(hub.store.blobInfo(world.project, blobHash)?.referencedAt, NOW_MS);
  }));
