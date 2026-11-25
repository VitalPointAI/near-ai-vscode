import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { GENESIS_PREV, buildEntryAsync, entryHash } from '@ext/domain/replica/entry';
import type { Actor, SealedEntry } from '@ext/domain/replica/entry';
import { ROSTER_REFUSALS, foldRoster } from '@ext/domain/replica/roster';
import type { RosterState } from '@ext/domain/replica/roster';
import { holderAt } from '@ext/domain/replica/rosterPositions';
import type { AsyncPayloadSigner, PayloadSigner } from '@ext/domain/team/signedPayload';
import { APPEND_REFUSALS } from '../src/append/checks';
import { RosterCache, sealedOf } from '../src/append/rosterCache';
import type { StoredEntry } from '../src/store/hubStore';
import { withHub } from './helpers/hubHarness';
import type { Hub } from './helpers/hubHarness';
import { createHubWorld } from './helpers/hubWorld';
import type { HubWorld, WorldDevice, Written } from './helpers/hubWorld';

// Phase 33.1, plan 01 (D-01, D-02, D-09, D-12): the tracer of positions. The lead creates the vacant position "Watch Officer, night" and orders an
// enrolled member to it, both entries signed through an asynchronous signer (the person key's path); that member's own device reports for duty. Your
// organization's server, the same server's roster reloaded from its store, and a second replica folding the entries it pulled all name one holder
// and the lead as orderer, and every wrong write is refused with the same named reason by the fold and by the server. Fictional people and keys only.

const POSITION = 'watch-officer-night';
const POSTING = 'pst-watch-night-1';
const START = '2026-12-01T00:00:00.000Z';
const ON_START = '2026-12-01T08:00:00.000Z';
const BEFORE_START = '2026-11-30T20:00:00.000Z';
const HUB_NOW = Date.parse('2026-12-01T09:00:00.000Z');
const hashOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const LABEL = { scale: 'demo', level: 'OFFICIAL', compartments: [], releasability: [] };

/** An asynchronous signer over a device's key, standing in for your organization's key store (33-21 AsyncPayloadSigner). */
function asyncOf(signer: PayloadSigner): AsyncPayloadSigner & { calls: number } {
  const wrapped = {
    calls: 0,
    fingerprint: signer.fingerprint,
    publicKey: signer.publicKey,
    sign: async (bytes: Buffer): Promise<string> => {
      wrapped.calls += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return signer.sign(bytes);
    }
  };
  return wrapped;
}

/** A roster entry of the device built with buildEntryAsync after its last base-stream entry in the world, citing the world's head. */
async function asyncRoster(world: HubWorld, device: WorldDevice, kind: string, data: Record<string, unknown>, options: { actor?: Actor; advance?: boolean } = {}): Promise<Written> {
  const own = world.entries.filter((entry) => entry.header.stream === world.project && entry.header.writer === device.writer);
  const last = own[own.length - 1];
  const rosterPrev = world.head;
  const signer = asyncOf(device.signer);
  const built = await buildEntryAsync({
    signer, key: world.keyOf(world.project, 1), stream: world.project, seq: own.length, prev: last === undefined ? GENESIS_PREV : entryHash(last.header), epoch: 1,
    body: { deps: [], roster: rosterPrev, lamport: 1000 + world.entries.length, at: '2026-11-25T10:00:00.000Z', actor: options.actor ?? { kind: 'person' }, kind, data: { ...data, rosterPrev } }
  });
  assert.ok('entry' in built);
  assert.equal(signer.calls, 1);
  world.entries.push(built.entry);
  if (options.advance !== false) world.head = built.hash;
  return { entry: built.entry, hash: built.hash, stream: world.project, writer: device.writer, seq: own.length, blobs: built.blobs };
}

const createData = { position: POSITION, title: 'Watch Officer, night', section: 'j3', decides: [], clearance: LABEL, keyGroups: [], acting: false, dualHat: false, shift: 'Night' };
const orderData = (member: string): Record<string, unknown> => ({
  posting: POSTING, position: POSITION, person: { member }, evidence: [hashOf('credential/clearance'), hashOf('credential/service')].sort(),
  status: [{ list: 'urn:example:status:1', hash: hashOf('status/1'), validFrom: '2026-11-24T00:00:00.000Z' }], kind: 'substantive', start: START,
  policy: hashOf('policy/example-organization'), stages: []
});

interface Setup { world: HubWorld; pat: WorldDevice; quinn: WorldDevice }

async function enrolled(hub: Hub): Promise<Setup> {
  const world = createHubWorld();
  world.admitHub(hub.identity);
  const pat = world.device('PAT-LAPTOP', 'mbr-pat');
  const quinn = world.device('QUINN-LAPTOP', 'mbr-quinn');
  world.admitMember(pat);
  world.admitMember(quinn);
  await hub.enrolProject(world, { direct: true });
  return { world, pat, quinn };
}

async function append(hub: Hub, world: HubWorld, device: WorldDevice, entries: readonly Written[]): Promise<{ accepted: string[]; refused: Array<{ hash?: string; reason: string; message: string }> }> {
  const session = await hub.openSession(device, world.project);
  const answer = await session.connection.post(`/v1/projects/${world.project}/append`, { entries: entries.map((item) => item.entry) }, session.token);
  assert.equal(answer.status, 200, answer.text);
  const body = answer.json<{ accepted?: string[]; refused?: Array<{ hash?: string; reason: string; message: string }> }>();
  return { accepted: body.accepted ?? [], refused: body.refused ?? [] };
}

const reasonOf = (answer: { refused: Array<{ hash?: string; reason: string }> }, written: Written): string | undefined => answer.refused.find((item) => item.hash === written.hash)?.reason;

/** Every base-stream entry the server stored, as a second replica pulls them. */
function pulled(hub: Hub, world: HubWorld): SealedEntry[] {
  const entries: SealedEntry[] = [];
  for (const stream of hub.store.heads(world.project)) {
    if (stream.stream !== world.project) continue;
    for (const head of stream.heads) {
      const page = hub.store.entriesFrom(world.project, world.project, head.writer, 0, { limit: 1000, maxBytes: 8 * 1024 * 1024 });
      for (const row of page.entries) entries.push(sealedOf(row as StoredEntry));
    }
  }
  return entries;
}

const foldOf = (world: HubWorld, device: WorldDevice, entries: readonly SealedEntry[]): RosterState =>
  foldRoster({ entries, anchor: world.anchor(), keys: world.ringFor(device), blobs: () => undefined, grants: world.grants, now: new Date(HUB_NOW) });

const refusedIn = (state: RosterState, written: Written): string | undefined => state.refused.find((item) => item.hash === written.hash)?.reason;

/** The holder of the position at the roster with this hash. */
function holderOn(state: RosterState, hash: string): { member: string; orderedBy: string } | undefined {
  const at = state.positionOf.get(hash);
  assert.ok(at !== undefined, 'the roster is on the line');
  const holder = holderAt(state.posts, POSITION, at);
  return holder === undefined ? undefined : { member: holder.member, orderedBy: holder.orderedBy };
}

/** The lead creates the position and orders Pat to it; both are taken by your organization's server. */
async function ordered(hub: Hub, s: Setup): Promise<{ create: Written; order: Written }> {
  const create = await asyncRoster(s.world, s.world.lead, 'position.create', createData);
  const order = await asyncRoster(s.world, s.world.lead, 'posting.order', orderData(s.pat.member));
  const answer = await append(hub, s.world, s.world.lead, [create, order]);
  assert.deepEqual(answer.refused, []);
  assert.deepEqual(answer.accepted, [create.hash, order.hash]);
  return { create, order };
}

test('tracer: a person-key order and the member\'s own report for duty give one holder on the server, on its reloaded roster and on a second replica', () =>
  withHub({ now: HUB_NOW }, async (hub) => {
    const s = await enrolled(hub);
    const { create, order } = await ordered(hub, s);
    const report = s.world.rosterEntry(s.pat, 'posting.report', { posting: POSTING }, { at: ON_START });
    const answer = await append(hub, s.world, s.pat, [report]);
    assert.deepEqual(answer.refused, []);
    assert.deepEqual(answer.accepted, [report.hash]);

    const live = await hub.cache.get(s.world.project);
    const reloaded = await new RosterCache(hub.store, hub.identity).get(s.world.project);
    const replicaB = foldOf(s.world, s.pat, pulled(hub, s.world));
    const replicaA = foldOf(s.world, s.world.lead, s.world.entries);
    const expected = { member: s.pat.member, orderedBy: s.world.lead.member };
    for (const state of [live.state, reloaded.state, replicaB, replicaA]) {
      assert.equal(state.positions[state.positions.length - 1], report.hash, 'the report is the roster head');
      assert.deepEqual(holderOn(state, report.hash), expected);
      // Vacant when created, and still vacant at the order: only the report makes a holder.
      assert.equal(holderOn(state, create.hash), undefined);
      assert.equal(holderOn(state, order.hash), undefined);
      assert.deepEqual(state.refused, []);
    }
    // The same entries in another order fold to the same holder.
    const reversed = foldOf(s.world, s.pat, [...pulled(hub, s.world)].reverse());
    assert.deepEqual(holderOn(reversed, report.hash), expected);
  }));

test('a report by another member for Pat\'s posting is refused not-the-posted-member by the server and the fold, and nobody holds the position', () =>
  withHub({ now: HUB_NOW }, async (hub) => {
    const s = await enrolled(hub);
    const { order } = await ordered(hub, s);
    const wrong = s.world.rosterEntry(s.quinn, 'posting.report', { posting: POSTING }, { at: ON_START, advance: false });
    const answer = await append(hub, s.world, s.quinn, [wrong]);
    assert.equal(reasonOf(answer, wrong), 'not-the-posted-member');
    assert.equal(answer.refused[0]?.message, APPEND_REFUSALS['not-the-posted-member']);
    const fold = foldOf(s.world, s.world.lead, s.world.entries);
    assert.equal(refusedIn(fold, wrong), 'not-the-posted-member');
    assert.equal(ROSTER_REFUSALS['not-the-posted-member'], APPEND_REFUSALS['not-the-posted-member']);
    for (const state of [fold, (await hub.cache.get(s.world.project)).state]) {
      assert.equal(state.positions[state.positions.length - 1], order.hash, 'the roster did not move');
      assert.equal(holderOn(state, order.hash), undefined);
    }
  }));

test('an agent actor on posting.order and a hub actor on posting.report are refused person-only by the server and the fold', () =>
  withHub({ now: HUB_NOW }, async (hub) => {
    const s = await enrolled(hub);
    const create = await asyncRoster(s.world, s.world.lead, 'position.create', createData);
    assert.deepEqual((await append(hub, s.world, s.world.lead, [create])).refused, []);
    const byAgent = await asyncRoster(s.world, s.world.lead, 'posting.order', orderData(s.pat.member), { actor: { kind: 'agent', member: s.world.lead.member, run: 'run-1' }, advance: false });
    const answer = await append(hub, s.world, s.world.lead, [byAgent]);
    assert.equal(reasonOf(answer, byAgent), 'person-only');
    const byHub = s.world.rosterEntry(s.pat, 'posting.report', { posting: POSTING }, { at: ON_START, actor: { kind: 'hub', watch: 'night-watch' }, advance: false });
    assert.equal(reasonOf(await append(hub, s.world, s.pat, [byHub]), byHub), 'person-only');
    const fold = foldOf(s.world, s.world.lead, s.world.entries);
    assert.equal(refusedIn(fold, byAgent), 'person-only');
    assert.equal(refusedIn(fold, byHub), 'person-only');
    assert.equal(fold.posts.postings.size, 0, 'no posting was ordered');
  }));

test('a report signed before the posting starts is refused report-before-start; the report on the start day then makes Pat the holder', () =>
  withHub({ now: HUB_NOW }, async (hub) => {
    const s = await enrolled(hub);
    const { order } = await ordered(hub, s);
    // Pat's first base-stream entry, at seq 0; the server refuses it, so the report on the start day takes the same place.
    const early = s.world.write(s.pat, { kind: 'posting.report', data: { posting: POSTING, rosterPrev: s.world.head }, at: BEFORE_START, seq: 0, prev: GENESIS_PREV });
    const answer = await append(hub, s.world, s.pat, [early]);
    assert.equal(reasonOf(answer, early), 'report-before-start');
    const fold = foldOf(s.world, s.world.lead, s.world.entries);
    assert.equal(refusedIn(fold, early), 'report-before-start');
    assert.equal(holderOn(fold, order.hash), undefined);
    const onTime = s.world.rosterEntry(s.pat, 'posting.report', { posting: POSTING }, { at: ON_START });
    assert.deepEqual((await append(hub, s.world, s.pat, [onTime])).accepted, [onTime.hash]);
    assert.deepEqual(holderOn((await hub.cache.get(s.world.project)).state, onTime.hash), { member: s.pat.member, orderedBy: s.world.lead.member });
  }));

test('a second report for the same posting is refused posting-not-open by the server and the fold, and the holder stays', () =>
  withHub({ now: HUB_NOW }, async (hub) => {
    const s = await enrolled(hub);
    await ordered(hub, s);
    const report = s.world.rosterEntry(s.pat, 'posting.report', { posting: POSTING }, { at: ON_START });
    assert.deepEqual((await append(hub, s.world, s.pat, [report])).refused, []);
    const again = s.world.rosterEntry(s.pat, 'posting.report', { posting: POSTING }, { at: '2026-12-01T08:30:00.000Z', advance: false });
    assert.equal(reasonOf(await append(hub, s.world, s.pat, [again]), again), 'posting-not-open');
    const fold = foldOf(s.world, s.world.lead, s.world.entries);
    assert.equal(refusedIn(fold, again), 'posting-not-open');
    for (const state of [fold, (await hub.cache.get(s.world.project)).state]) {
      assert.equal(state.positions[state.positions.length - 1], report.hash);
      assert.deepEqual(holderOn(state, report.hash), { member: s.pat.member, orderedBy: s.world.lead.member });
    }
  }));

test('an order by a member who is not the lead is refused order-not-allowed, and a position.create by them not-a-roster-writer, by the server and the fold', () =>
  withHub({ now: HUB_NOW }, async (hub) => {
    const s = await enrolled(hub);
    const create = await asyncRoster(s.world, s.world.lead, 'position.create', createData);
    assert.deepEqual((await append(hub, s.world, s.world.lead, [create])).refused, []);
    const byPat = await asyncRoster(s.world, s.pat, 'posting.order', orderData(s.pat.member), { advance: false });
    assert.equal(reasonOf(await append(hub, s.world, s.pat, [byPat]), byPat), 'order-not-allowed');
    const createByQuinn = await asyncRoster(s.world, s.quinn, 'position.create', { ...createData, position: 'watch-officer-day', title: 'Watch Officer, day' }, { advance: false });
    assert.equal(reasonOf(await append(hub, s.world, s.quinn, [createByQuinn]), createByQuinn), 'not-a-roster-writer');
    const fold = foldOf(s.world, s.world.lead, s.world.entries);
    assert.equal(refusedIn(fold, byPat), 'order-not-allowed');
    assert.equal(refusedIn(fold, createByQuinn), 'not-a-roster-writer');
    assert.equal(fold.posts.positions.size, 1);
    assert.equal(fold.posts.postings.size, 0);
  }));

test('kinds a later plan applies (posting.end, an acting order) are refused roster-kind-pending by the server and the fold and change nothing', () =>
  withHub({ now: HUB_NOW }, async (hub) => {
    const s = await enrolled(hub);
    await ordered(hub, s);
    const report = s.world.rosterEntry(s.pat, 'posting.report', { posting: POSTING }, { at: ON_START });
    assert.deepEqual((await append(hub, s.world, s.pat, [report])).refused, []);
    const end = await asyncRoster(s.world, s.world.lead, 'posting.end', { posting: POSTING, reason: 'Exercise ended.' }, { advance: false });
    assert.equal(reasonOf(await append(hub, s.world, s.world.lead, [end]), end), 'roster-kind-pending');
    const fold = foldOf(s.world, s.world.lead, s.world.entries);
    assert.equal(refusedIn(fold, end), 'roster-kind-pending');
    // An acting order is a posting.order this plan does not apply yet: refused before anything is folded.
    const position = s.world.head;
    const acting = { ...orderData(s.pat.member), posting: 'pst-acting-1', kind: 'acting' };
    const actingFold = foldOf(s.world, s.world.lead, [...s.world.entries.filter((entry) => entryHash(entry.header) !== end.hash), (await asyncRoster(s.world, s.world.lead, 'posting.order', acting, { advance: false })).entry]);
    assert.equal(actingFold.refused.find((item) => item.kind === 'posting.order')?.reason, 'roster-kind-pending');
    for (const state of [fold, actingFold, (await hub.cache.get(s.world.project)).state]) {
      assert.equal(state.positions[state.positions.length - 1], position);
      assert.deepEqual(holderOn(state, report.hash), { member: s.pat.member, orderedBy: s.world.lead.member });
    }
  }));
