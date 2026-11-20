// Convergence of the whole replica core (plan 30-12; ROADMAP Phase 30 success criterion 1; D-10, D-11, D-28): random worlds of two to five writers, persons
// and agent runs, co-editing, proposing, giving verdicts, submitting and deciding, with later-phase and unknown kinds, a cloned device, a tampered entry and
// a future-dated one, fold to one state and one digest under any delivery order, duplication, partition and arrival order, through the default reducers.
// The fold is called with no reducers option except in the two checkpoint scenarios at the end, which watch the apply calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalBytes } from '../domain/team/canonical';
import { applyRemote, docText, encodeFullState, snapshotOf } from '../domain/replica/doc';
import { sealBlob } from '../domain/replica/entry';
import type { Actor, Dep, SealedEntry } from '../domain/replica/entry';
import { checkpointHash, orderTipOf, signCheckpoint, verifyCheckpoint } from '../domain/replica/checkpoint';
import type { Checkpoint, SignedCheckpoint } from '../domain/replica/checkpoint';
import { addEntries, createFoldState, foldEntries } from '../domain/replica/fold';
import type { FoldResult, FoldState } from '../domain/replica/fold';
import { integrityReducer } from '../domain/replica/integrityFold';
import { kahnOrder, totalOrder } from '../domain/replica/order';
import type { AnyReducer } from '../domain/replica/reducers';
import { staticRosterView } from '../domain/replica/rosterView';
import type { ReplicaContext } from '../domain/replica/rosterView';
import { textReducer } from '../domain/replica/textFold';
import type { ProductTextOutput } from '../domain/replica/textFold';
import { verifyEntry } from '../domain/replica/verify';
import type { VerifiedEntry } from '../domain/replica/verify';
import { replicaVersionHash } from '../domain/replica/versions';
import type { ProductVersions } from '../domain/replica/versions';
import { forkAt, futureEntry, tamperHeader } from './helpers/replicaForks';
import { createWorld, fixedSigner, rng, shuffled, streamId, updateData } from './helpers/replicaWorld';
import type { Editor, Rng, Written, World } from './helpers/replicaWorld';

const OWNER: Actor = { kind: 'agent', member: 'j2-chief', run: 'r-1' };
const TRADECRAFT: Actor = { kind: 'agent', member: 'tradecraft', run: 'r-t' };
const GUARD: Actor = { kind: 'agent', member: 'release-guard', run: 'r-g' };
const PERSON: Actor = { kind: 'person' };
const COMMANDER = 'commander';
const MAX_ENTRIES = 60;

// ---- the random world -----------------------------------------------------------------------------------------------------------------------------

// One way of typing: a device with a person or an agent run, its own client id and its own local document. `last` is the newest entry whose past covers
// everything the document holds, so a reader of the document cites it.
interface Slot { device: string; actor: Actor; editor: Editor; last: Written | undefined }
interface Pipeline { hash: string; step: number; last: Written; proposer: string }
interface StreamPlan { id: string; product: string; slots: Slot[]; pipelines: Pipeline[]; lead: Written }

export interface RandomWorld {
  world: World;
  // What gets delivered: every entry the world wrote, with the tampered one replaced by its changed copy.
  delivered: SealedEntry[];
  streams: string[];
  notes: { writers: number; fork: boolean; tampered: boolean; future: boolean; released: number };
}

function rolesOf(index: number): string[] {
  if (index === 0) return ['member', 'staff_lead', 'section_lead:j2', 'answers_for:j2'];
  if (index <= 2) return ['member', 'answers_for:j2', `decision_for:${COMMANDER}`];
  return ['member', 'answers_for:j2'];
}

const hex = (random: Rng, length: number): string => Array.from({ length }, () => '0123456789abcdef'[random.int(16)]).join('');

export function randomWorld(random: Rng, options: { withUnrelatedWriter?: boolean } = {}): RandomWorld {
  const count = 2 + random.int(4);
  const devices = Array.from({ length: count }, (_, index) => `W${index}`);
  const members = devices.map((device, index) => ({ member: `mbr-w${index}`, name: `Writer ${index}`, roles: rolesOf(index), devices: [device] }));
  if (options.withUnrelatedWriter === true) members.push({ member: 'mbr-zz', name: 'Zed', roles: ['member'], devices: ['Z'] });
  const world = createWorld({ members });
  const deviceOf = new Map(devices.map((device) => [world.writerOf(device), device]));

  let client = 1000;
  const plans: StreamPlan[] = [];
  const streamCount = random.chance(0.4) ? 2 : 1;
  for (let index = 0; index < streamCount; index += 1) {
    const id = index === 0 ? world.stream : streamId('second');
    const product = index === 0 ? 'prod-one' : 'prod-two';
    const genesis = world.write('W0', { kind: 'project.genesis', stream: id, data: { project: id, name: `Exercise ${index}`, profile: 'staff', labelMapHash: hex(random, 64), lead: { member: 'mbr-w0', writer: world.writerOf('W0') } } });
    const lead = world.write('W0', {
      kind: 'product.create', stream: id, deps: [genesis],
      data: { product, section: 'j2', roles: { owner: 'j2-chief', sectionLead: 'j2-lead', releaseGuard: 'release-guard', tradecraftReviewer: 'tradecraft' }, title: `Product ${index}` }
    });
    const slots: Slot[] = [];
    for (const device of devices) {
      slots.push({ device, actor: PERSON, editor: world.editor(device, product, (client += 1)), last: undefined });
      if (random.chance(0.5)) slots.push({ device, actor: { kind: 'agent', member: 'j2-analyst', run: `r-${client}` }, editor: world.editor(device, product, (client += 1)), last: undefined });
    }
    plans.push({ id, product, slots, pipelines: [], lead });
  }

  const target = 12 + random.int(MAX_ENTRIES - 12 - 12);
  const futureAt = random.chance(0.1) ? Math.floor(target * 0.7) : -1;
  let futureDone = false;
  let released = 0;
  let counter = 0;

  const docStep = (plan: StreamPlan): void => {
    const slot = random.pick(plan.slots);
    if (slot.last === undefined) {
      slot.last = slot.editor.register({ stream: plan.id, actor: slot.actor, deps: [plan.lead] });
      return;
    }
    const deps: Written[] = [];
    for (const other of shuffled(plan.slots.filter((candidate) => candidate !== slot && candidate.last !== undefined), random).slice(0, random.int(3))) {
      applyRemote(slot.editor.doc, encodeFullState(other.editor.doc));
      deps.push(other.last as Written);
    }
    const length = docText(slot.editor.doc).length;
    counter += 1;
    slot.last = length > 3 && random.chance(0.25)
      ? slot.editor.remove(random.int(length - 1), 1 + random.int(2), { stream: plan.id, actor: slot.actor, deps })
      : slot.editor.insert(random.int(length + 1), `${counter % 97} `, { stream: plan.id, actor: slot.actor, deps });
  };

  const proposeStep = (plan: StreamPlan): void => {
    const ready = plan.slots.filter((slot) => slot.last !== undefined && slot.actor.kind === 'person');
    if (ready.length === 0) return docStep(plan);
    const slot = random.pick(ready);
    const deps: Written[] = [slot.last as Written];
    for (const other of plan.slots.filter((candidate) => candidate !== slot && candidate.last !== undefined && random.chance(0.8))) {
      applyRemote(slot.editor.doc, encodeFullState(other.editor.doc));
      deps.push(other.last as Written);
    }
    const text = docText(slot.editor.doc);
    const hash = replicaVersionHash(text, []);
    const blob = sealBlob(world.keyFor(plan.id, 0), plan.id, 0, canonicalBytes({ text, header: { title: 'Estimate' } }));
    world.blobs.set(blob.hash, blob);
    const proposal = world.write(slot.device, { kind: 'version.propose', stream: plan.id, actor: OWNER, deps, data: { product: plan.product, hash, textBlob: blob.hash, snapshot: Buffer.from(snapshotOf(slot.editor.doc)).toString('base64url'), pins: [] } });
    slot.last = proposal;
    plan.pipelines.push({ hash, step: 0, last: proposal, proposer: slot.device });
  };

  const pipelineStep = (plan: StreamPlan): void => {
    if (plan.pipelines.length === 0) return proposeStep(plan);
    const line = random.pick(plan.pipelines);
    const base = { stream: plan.id, deps: [line.last] };
    const verdict = (gate: 'guard' | 'tradecraft', word: string): Record<string, unknown> => ({ product: plan.product, hash: line.hash, gate, verdict: word, reasons: word === 'NOT READY' || word === 'HOLD' ? ['not sourced'] : [] });
    let next: Written | undefined;
    if (random.chance(0.06)) {
      next = world.write(line.proposer, { ...base, kind: 'version.withdraw', actor: OWNER, data: { product: plan.product, hash: line.hash, reason: 'obsolete', decisionsSeen: [] } });
      line.step = 9;
    } else if (line.step === 0) {
      next = world.write('W0', { ...base, kind: 'version.verdict', actor: TRADECRAFT, data: verdict('tradecraft', random.chance(0.85) ? 'SIGN-OFF' : 'NOT READY') });
      line.step = 1;
    } else if (line.step === 1) {
      next = world.write('W0', { ...base, kind: 'version.verdict', actor: GUARD, data: verdict('guard', random.chance(0.9) ? 'CLEARED' : 'HOLD') });
      line.step = 2;
    } else if (line.step === 2) {
      next = world.write(line.proposer, { ...base, kind: 'version.submit', actor: OWNER, data: { product: plan.product, hash: line.hash, decisionFor: COMMANDER } });
      line.step = 3;
    } else if (line.step === 3) {
      const outcome = random.chance(0.75) ? 'approve' : 'reject';
      const decide = (device: string, word: string): Written => world.write(device, { ...base, kind: 'version.decide', actor: PERSON, data: { product: plan.product, hash: line.hash, outcome: word, reasons: word === 'reject' ? ['the figure is not sourced'] : [], decisionsSeen: [] } });
      next = decide('W1', outcome);
      // A second holder of the role deciding at the same time makes the version contested or settles it, the same on every machine.
      if (count > 2 && random.chance(0.25)) decide('W2', outcome === 'approve' ? 'reject' : 'approve');
      line.step = 4;
    } else if (line.step === 4) {
      next = world.write('W1', { ...base, kind: 'version.release', actor: PERSON, data: { product: plan.product, hash: line.hash, decisionsSeen: [line.last.hash] } });
      line.step = 9;
      released += 1;
    } else {
      return docStep(plan);
    }
    line.last = next as Written;
  };

  const sideStep = (plan: StreamPlan): void => {
    const device = random.pick(devices);
    const pick = random.int(4);
    counter += 1;
    if (pick === 0) world.write(device, { stream: plan.id, kind: 'register.row', data: { register: 'ccir', row: `row-${counter % 5}`, fields: { note: `value ${counter}` } } });
    else if (pick === 1) world.write(device, { stream: plan.id, kind: 'run.claim', actor: OWNER, data: { run: 'r-1', member: 'j2-chief', target: `target-${counter % 3}`, purpose: 'edit', leaseSeconds: 1200 } });
    else if (pick === 2) world.write(device, { stream: plan.id, kind: 'future.thing', data: { n: counter } });
    else world.write('W0', { stream: plan.id, kind: 'project.import', data: { ledger: 'legacy', legacyHead: hex(random, 64), count: 1 + random.int(5) } });
  };

  while (world.entries.length < target) {
    const plan = random.pick(plans);
    if (futureAt >= 0 && !futureDone && world.entries.length >= futureAt) {
      futureDone = true;
      futureEntry(world, random.pick(devices), 11, { stream: plan.id, kind: 'future.thing', data: { late: true } });
      continue;
    }
    const roll = random.int(100);
    if (roll < 33) docStep(plan);
    else if (roll < 45) proposeStep(plan);
    else if (roll < 85) pipelineStep(plan);
    else sideStep(plan);
  }

  // A cloned device: a second signed entry at a seq the writer already used, with the same predecessor.
  const fork = random.chance(0.1);
  if (fork) {
    const victim = random.pick(world.entries);
    forkAt(world, deviceOf.get(victim.header.writer) as string, victim.header.stream, victim.header.seq, { kind: 'future.thing', data: { fork: true } });
  }
  const delivered = [...world.entries];
  // One header changed after signing, with the signature kept.
  const tampered = random.chance(0.1);
  if (tampered) {
    const index = random.int(delivered.length);
    delivered[index] = tamperHeader(delivered[index], { epoch: 1 });
  }
  return { world, delivered, streams: plans.map((plan) => plan.id), notes: { writers: count, fork, tampered, future: futureDone, released } };
}

// An unrelated writer in a stream of its own: a registration, then random edits and kinds, one entry on top of another.
function unrelatedEntries(world: World, random: Rng): SealedEntry[] {
  const before = world.entries.length;
  const stream = streamId('unrelated');
  const editor = world.editor('Z', 'prod-z', 9001);
  let last = editor.register({ stream });
  const total = 1 + random.int(14);
  for (let index = 0; index < total; index += 1) {
    const roll = random.int(5);
    if (roll < 3) last = editor.insert(random.int(docText(editor.doc).length + 1), `z${index}`, { stream, deps: [last] });
    else if (roll === 3) last = world.write('Z', { stream, kind: 'register.row', data: { register: 'rfi', row: `row-${index}`, fields: { note: 'x' } } });
    else last = world.write('Z', { stream, kind: 'future.thing', data: { z: index } });
  }
  return world.entries.slice(before);
}

// ---- helpers ----------------------------------------------------------------------------------------------------------------------------------------

const copyOf = (entry: SealedEntry): SealedEntry => ({ header: { ...entry.header }, body: entry.body });

function deliver(state: FoldState, items: readonly SealedEntry[], parts: number): FoldState {
  let current = state;
  const size = Math.max(1, Math.ceil(items.length / parts));
  for (let from = 0; from < items.length; from += size) current = addEntries(current, items.slice(from, from + size));
  return current;
}

const hashesOf = (entries: readonly { hash: string }[]): string[] => entries.map((entry) => entry.hash);

// ---- the properties -----------------------------------------------------------------------------------------------------------------------------------

test('200 random worlds of 2 to 5 writers fold to one state and one digest under shuffled and duplicated delivery, partitions and one-at-a-time arrival, and Kahn order equals the sort', () => {
  const stats = { worlds: 0, applied: 0, released: 0, forks: 0, quarantined: 0, tampered: 0, future: 0, held: 0, refused: 0, kept: 0, multiStream: 0, widest: 0 };
  for (let seed = 1; seed <= 200; seed += 1) {
    const random = rng(seed);
    const built = randomWorld(random);
    assert.ok(built.delivered.length <= MAX_ENTRIES, `seed ${seed}: at most ${MAX_ENTRIES} entries`);
    const ctx = built.world.ctx();
    const reference = foldEntries(built.delivered, ctx);
    stats.worlds += 1;
    stats.applied += reference.applied.length;
    stats.released += (reference.families.versions as ProductVersions[]).flatMap((product) => product.versions).filter((version) => version.state === 'released').length;
    stats.forks += built.notes.fork ? 1 : 0;
    stats.quarantined += reference.quarantined.length > 0 ? 1 : 0;
    stats.tampered += built.notes.tampered ? 1 : 0;
    stats.future += built.notes.future ? 1 : 0;
    stats.held += reference.held.length > 0 ? 1 : 0;
    stats.refused += reference.refused.length > 0 ? 1 : 0;
    stats.kept += reference.kept.length > 0 ? 1 : 0;
    stats.multiStream += built.streams.length > 1 ? 1 : 0;
    stats.widest = Math.max(stats.widest, built.notes.writers);

    // Four shuffled deliveries, each with five duplicates (copies, so they are read as separate inputs and recognised by their hash).
    for (let round = 0; round < 4; round += 1) {
      const duplicates = Array.from({ length: 5 }, () => copyOf(random.pick(built.delivered)));
      const delivery = shuffled([...shuffled(built.delivered, random), ...duplicates], random);
      assert.deepEqual(foldEntries(delivery, ctx), reference, `seed ${seed} round ${round}: shuffled delivery`);
    }

    // Two partitions folded on their own, then joined in either direction.
    const split = shuffled(built.delivered, random);
    const middle = Math.floor(split.length / 2);
    const left = deliver(createFoldState(ctx), split.slice(0, middle), 3);
    const right = deliver(createFoldState(ctx), split.slice(middle), 3);
    assert.deepEqual(deliver(left, split.slice(middle), 3).result, reference, `seed ${seed}: left then right`);
    assert.deepEqual(deliver(right, split.slice(0, middle), 3).result, reference, `seed ${seed}: right then left`);

    // One entry at a time in random order, and the reference order built by Kahn's algorithm equals the sort the fold uses.
    let state = createFoldState(ctx);
    for (const entry of shuffled(built.delivered, random)) state = addEntries(state, [entry]);
    assert.deepEqual(state.result, reference, `seed ${seed}: one at a time`);
    const { ordered, graph, chains } = state.prepared;
    assert.deepEqual(hashesOf(kahnOrder(chains.admitted, graph)), hashesOf(ordered), `seed ${seed}: Kahn order equals the sort`);
    assert.deepEqual(hashesOf(ordered), reference.order, `seed ${seed}: the fold's order`);
    assert.equal(reference.checkpoint, null, `seed ${seed}: no checkpoint in a random world`);
  }
  // The generator must exercise what the property claims to cover, or a quiet generator would pass for the wrong reason.
  console.log(`replicaConvergence worlds: ${JSON.stringify(stats)}`);
  assert.ok(stats.released >= 20, 'released versions are exercised');
  assert.ok(stats.forks >= 5 && stats.quarantined >= 5, 'cloned devices are exercised');
  assert.ok(stats.tampered >= 5 && stats.future >= 3, 'tampered and future-dated entries are exercised');
  assert.ok(stats.held >= 5 && stats.refused >= 5 && stats.kept >= 20, 'held, refused and kept entries are exercised');
  assert.ok(stats.multiStream >= 40 && stats.widest === 5, 'two streams and five writers are exercised');
});

test('an unrelated writer in another stream, at any interleaving, never changes another stream\'s digest or families output (50 seeds)', () => {
  for (let seed = 1; seed <= 50; seed += 1) {
    const random = rng(seed * 31);
    const built = randomWorld(random, { withUnrelatedWriter: true });
    const base = built.delivered;
    const unrelated = unrelatedEntries(built.world, random);
    const zStream = unrelated[0].header.stream;
    assert.ok(zStream !== built.streams[0] && !built.streams.includes(zStream));
    const ctx = built.world.ctx();
    const alone = foldEntries(base, ctx);
    const together = foldEntries(shuffled([...base, ...unrelated], random), ctx);
    for (const stream of built.streams) assert.equal(together.digests[stream], alone.digests[stream], `seed ${seed}: digest of ${stream.slice(0, 6)}`);
    assert.ok(together.digests[zStream] !== undefined, `seed ${seed}: the unrelated stream has its own digest`);
    for (const family of Object.keys(alone.families)) {
      const rows = (result: FoldResult): unknown[] => (result.families[family] as Array<{ stream: string }>).filter((row) => row.stream !== zStream);
      assert.deepEqual(rows(together), rows(alone), `seed ${seed}: ${family} output of the original streams`);
    }
    assert.deepEqual(together.quarantined, alone.quarantined, `seed ${seed}: quarantine`);
  }
});

// A reducer that reports where each doc entry sits, by the global index or by the index in its own stream.
function positional(which: 'position' | 'streamPosition'): AnyReducer {
  type Rows = Record<string, number[]>;
  return {
    family: 'doc',
    init: (): Rows => ({}),
    apply(state: Rows, entry, view) {
      (state[entry.header.stream] ??= []).push((which === 'position' ? view.position(entry.hash) : view.streamPosition(entry.hash)) ?? -1);
      return { status: 'applied' };
    },
    finish: (state: Rows) => Object.keys(state).sort().map((stream) => ({ stream, at: state[stream] })),
    canonical: (output: Array<{ stream: string; at: number[] }>, stream: string) => output.find((row) => row.stream === stream)?.at ?? [],
    clone: (state: Rows): Rows => Object.fromEntries(Object.entries(state).map(([stream, at]) => [stream, [...at]]))
  };
}

test('the unrelated-stream invariant has teeth: a reducer that reports the global index changes with another stream, and one that reports the stream index does not', () => {
  const moved = { position: 0, streamPosition: 0 };
  for (let seed = 1; seed <= 20; seed += 1) {
    const random = rng(seed * 17);
    const built = randomWorld(random, { withUnrelatedWriter: true });
    const base = built.delivered;
    const unrelated = unrelatedEntries(built.world, random);
    const ctx = built.world.ctx();
    for (const which of ['position', 'streamPosition'] as const) {
      const reducers = [positional(which)];
      const rowsOf = (entries: readonly SealedEntry[]): unknown => (foldEntries(entries, ctx, { reducers }).families.doc as Array<{ stream: string }>).filter((row) => built.streams.includes(row.stream));
      try {
        assert.deepEqual(rowsOf([...base, ...unrelated]), rowsOf(base));
      } catch {
        moved[which] += 1;
      }
    }
  }
  assert.ok(moved.position > 0, 'the global index moves when an unrelated stream is added, so the invariant test would catch a reducer that used it');
  assert.equal(moved.streamPosition, 0);
});

// ---- quarantine crossed with checkpoint finality ---------------------------------------------------------------------------------------------------

const PRODUCT = 'intel-estimate';

interface Counts {
  applied: Map<string, number>;
  finalAtApply: Map<string, boolean>;
}

// The text reducer with every apply call counted, and the finality it saw, so a test can tell which entries a refold applied again.
function watching(counts: Counts): AnyReducer {
  return {
    ...textReducer,
    apply(state, entry, view) {
      counts.applied.set(entry.hash, (counts.applied.get(entry.hash) ?? 0) + 1);
      counts.finalAtApply.set(entry.hash, view.isFinal(entry.hash));
      return textReducer.apply(state, entry, view);
    }
  };
}

interface Fixture {
  world: World;
  ctx: ReplicaContext;
  hub: ReturnType<typeof fixedSigner>;
  writer: string;
}

function fixture(): Fixture {
  const world = createWorld({ members: [{ member: 'mbr-w', devices: ['W'] }, { member: 'mbr-x', devices: ['X'] }, { member: 'mbr-h', devices: ['H'] }] });
  const hub = fixedSigner('H');
  const spec = { ...world.rosterSpec, rosters: world.rosterSpec.rosters.map((roster) => ({ ...roster, checkpointSigners: [hub.writer] })) };
  return { world, ctx: world.ctx({ roster: staticRosterView(spec) }), hub, writer: world.writerOf('W') };
}

// The checkpoint a correct hub signs over the covered entries: the heads, the count and the order tip of their final order.
function checkpointOver(f: Fixture, covered: readonly Written[]): SignedCheckpoint {
  const entries = covered.map((item) => {
    const outcome = verifyEntry(item.entry, f.ctx);
    assert.equal(outcome.status, 'verified');
    return (outcome as { entry: VerifiedEntry }).entry;
  });
  const ordered = totalOrder(entries);
  const heads = new Map<string, Dep>();
  for (const entry of entries) {
    const known = heads.get(entry.header.writer);
    if (known === undefined || known.seq < entry.header.seq) heads.set(entry.header.writer, { writer: entry.header.writer, seq: entry.header.seq, hash: entry.hash });
  }
  const checkpoint: Checkpoint = {
    type: 'checkpoint', v: 1, project: 'project-main', signer: f.hub.writer, rosterHead: f.world.rosterHash,
    streams: [{ stream: f.world.stream, heads: [...heads.values()].sort((a, b) => (a.writer < b.writer ? -1 : 1)), count: ordered.length, orderTip: orderTipOf(hashesOf(ordered)) }]
  };
  const signed = signCheckpoint(f.hub.signer, checkpoint);
  assert.equal(verifyCheckpoint(signed, f.ctx.roster).ok, true);
  return signed;
}

const sealed = (...items: Written[]): SealedEntry[] => items.map((item) => item.entry);
const textOf = (result: FoldResult): string => (result.families.doc as ProductTextOutput[])[0].text;

test('quarantine after a checkpoint prefix: a late second branch refolds from the prefix snapshot, keeps the prefix applied and final, and equals the from-scratch fold', () => {
  const f = fixture();
  const w = f.world.editor('W', PRODUCT, 101);
  const x = f.world.editor('X', PRODUCT, 202);
  const w0 = w.register();
  const w1 = w.insert(0, 'alpha ', { deps: [w0] });
  const w2 = w.insert(6, 'beta ', { deps: [w1] });
  const x0 = x.register();
  const x1 = x.insert(0, 'gamma ', { deps: [x0] });
  const prefix = [w0, w1, w2, x0, x1];
  const w3a = w.insert(0, 'first-branch ', { deps: [w2] });
  const w3b = forkAt(f.world, 'W', f.world.stream, 3, { kind: 'doc.update', data: updateData(PRODUCT, f.world.editor('W', PRODUCT, 101).insertUpdate(0, 'second-branch ')) });
  const checkpoint = checkpointOver(f, prefix);
  const hash = checkpointHash(checkpoint);

  const counts: Counts = { applied: new Map(), finalAtApply: new Map() };
  const options = { reducers: [watching(counts), integrityReducer], checkpoints: [checkpoint] };
  let state = createFoldState(f.ctx, options);
  state = addEntries(state, sealed(...prefix));
  state = addEntries(state, sealed(w3a));
  assert.equal(state.result.checkpoint, hash);
  assert.ok(textOf(state.result).includes('first-branch'), 'before the second branch arrives, the first branch is applied');
  const refoldsBefore = state.refolds;
  const appliedBefore = new Map(counts.applied);
  assert.deepEqual(prefix.map((item) => appliedBefore.get(item.hash)), [1, 1, 1, 1, 1]);

  state = addEntries(state, sealed(w3b));
  assert.equal(state.refolds - refoldsBefore, 1, 'the late branch triggers exactly one refold');
  for (const item of prefix) assert.equal(counts.applied.get(item.hash), 1, 'the refold started from the prefix snapshot, so no prefix entry was applied again');
  assert.equal(counts.applied.has(w3b.hash), false, 'the second branch is never applied');
  assert.equal(counts.applied.get(w3a.hash), 1, 'the first branch was applied once before the fork was known and not again');
  for (const item of prefix) assert.equal(counts.finalAtApply.get(item.hash), true, 'prefix entries are applied as final');

  const result = state.result;
  assert.deepEqual(result.quarantined, [{ writer: f.writer, stream: f.world.stream, fromSeq: 3 }]);
  assert.deepEqual(result.excluded, hashesOf([w3a, w3b]).sort());
  assert.equal(result.proofs.length, 1);
  for (const item of prefix) assert.ok(result.applied.includes(item.hash), 'the prefix stays applied');
  assert.ok(!result.applied.includes(w3a.hash) && !result.applied.includes(w3b.hash));
  assert.ok(['alpha', 'beta', 'gamma'].every((word) => textOf(result).includes(word)), 'the prefix text is there');
  assert.ok(!textOf(result).includes('branch'), 'neither branch is in the text');
  assert.equal(result.checkpoint, hash);

  const scratch = foldEntries([...sealed(...prefix), w3a.entry, w3b.entry], f.ctx, { reducers: [watching({ applied: new Map(), finalAtApply: new Map() }), integrityReducer], checkpoints: [checkpoint] });
  assert.deepEqual(result, scratch);
});

test('quarantine inside a checkpoint prefix: a second branch arriving after the checkpoint refolds from the start and excludes the covered branch too', () => {
  const f = fixture();
  const w = f.world.editor('W', PRODUCT, 101);
  const x = f.world.editor('X', PRODUCT, 202);
  const w0 = w.register();
  const w1 = w.insert(0, 'alpha ', { deps: [w0] });
  const w2a = w.insert(6, 'beta ', { deps: [w1] });
  const x0 = x.register();
  const x1 = x.insert(0, 'gamma ', { deps: [x0] });
  const covered = [w0, w1, w2a, x0, x1];
  const w2b = forkAt(f.world, 'W', f.world.stream, 2, { kind: 'doc.update', data: updateData(PRODUCT, f.world.editor('W', PRODUCT, 101).insertUpdate(0, 'rival ')) });
  const checkpoint = checkpointOver(f, covered);
  const hash = checkpointHash(checkpoint);

  const counts: Counts = { applied: new Map(), finalAtApply: new Map() };
  const options = { reducers: [watching(counts), integrityReducer], checkpoints: [checkpoint] };
  let state = createFoldState(f.ctx, options);
  state = addEntries(state, sealed(...covered));
  const before = state.result;
  assert.equal(before.checkpoint, hash);
  assert.ok(textOf(before).includes('beta'), 'before the second branch arrives, the covered branch is applied and final');
  assert.equal(counts.finalAtApply.get(w2a.hash), true);
  const refoldsBefore = state.refolds;

  state = addEntries(state, sealed(w2b));
  assert.equal(state.refolds - refoldsBefore, 1, 'one refold');
  assert.equal(counts.applied.get(w0.hash), 2, 'the fork point is inside the prefix, so the refold started from the start');
  const result = state.result;
  assert.deepEqual(result.quarantined, [{ writer: f.writer, stream: f.world.stream, fromSeq: 2 }]);
  assert.deepEqual(result.excluded, hashesOf([w2a, w2b]).sort(), 'finality does not shield an equivocating writer');
  assert.equal(result.proofs.length, 1);
  for (const item of [w0, w1, x0, x1]) assert.ok(result.applied.includes(item.hash), 'the other entries stay applied');
  assert.ok(!result.applied.includes(w2a.hash) && !result.applied.includes(w2b.hash));
  assert.ok(!textOf(result).includes('beta') && !textOf(result).includes('rival'));
  assert.ok(textOf(result).includes('alpha') && textOf(result).includes('gamma'));
  assert.notEqual(result.digests[f.world.stream], before.digests[f.world.stream], 'the digest moved with the exclusion');
  assert.equal(result.checkpoint, hash, 'the result still names the checkpoint');

  const scratch = foldEntries([...sealed(...covered), w2b.entry], f.ctx, { reducers: [watching({ applied: new Map(), finalAtApply: new Map() }), integrityReducer], checkpoints: [checkpoint] });
  assert.deepEqual(result, scratch);
});
