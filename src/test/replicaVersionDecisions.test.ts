// Decisions on versions through the fold (plan 30-10, D-24, D-25, D-37; DESIGN 15.4 rows 6 to 11, 15.5): real signed entries, the decision algebra of
// 30-07 and release.ts's transition() together. Every test asserts one result under every delivery order of its decision entries.
// The world builders are local to this file (the shared helper is not edited).
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalBytes } from '../domain/team/canonical';
import { docText, snapshotOf } from '../domain/replica/doc';
import { sealBlob } from '../domain/replica/entry';
import type { Actor, Dep, SealedEntry } from '../domain/replica/entry';
import { checkpointHash, orderTipOf, signCheckpoint } from '../domain/replica/checkpoint';
import type { Checkpoint, SignedCheckpoint } from '../domain/replica/checkpoint';
import { foldEntries } from '../domain/replica/fold';
import type { FoldOptions, FoldResult } from '../domain/replica/fold';
import { totalOrder } from '../domain/replica/order';
import { staticRosterView } from '../domain/replica/rosterView';
import type { ReplicaContext } from '../domain/replica/rosterView';
import { textReducer } from '../domain/replica/textFold';
import { verifyEntry } from '../domain/replica/verify';
import type { VerifiedEntry } from '../domain/replica/verify';
import { actorForTransition, personForTransition, replicaVersionHash, versionsReducer } from '../domain/replica/versions';
import type { Pin, ProductVersions, VersionView } from '../domain/replica/versions';
import { transition } from '../domain/staff/release';
import { createWorld, fixedSigner, permutations } from './helpers/replicaWorld';
import type { Editor, Written, World } from './helpers/replicaWorld';

const PRODUCT = 'intel-estimate';
const REDUCERS = [textReducer, versionsReducer];
const OWNER: Actor = { kind: 'agent', member: 'j2-chief', run: 'r-1' };
const GUARD: Actor = { kind: 'agent', member: 'release-guard', run: 'r-g' };
const PERSON: Actor = { kind: 'person' };
const COMMANDER = 'commander';
const OTHER_HASH = 'a'.repeat(64);
const ROSTER_STREAM = '3'.repeat(32);

// ---- the world ----------------------------------------------------------------------------------------------------------------------------------

interface Kit {
  product: string;
  create: Written;
  editor: Editor;
  reg: Written;
  typed: Written;
  textNow(): string;
  snapNow(): Uint8Array;
}

interface Fixture {
  world: World;
  kit: Kit;
  hub: ReturnType<typeof fixedSigner>;
  ctx: ReplicaContext;
  // Another product in the same world, with its own text editor.
  extraKit(product: string, clientId: number): Kit;
  propose(kit: Kit, writer: string, actor: Actor, deps: readonly Written[], options?: { pins?: Pin[]; text?: string; snapshot?: Uint8Array; hash?: string }): Written;
  act(writer: string, actor: Actor, kind: string, data: Record<string, unknown>, deps: readonly Written[]): Written;
  fold(entries?: readonly SealedEntry[], ctx?: ReplicaContext, options?: FoldOptions): FoldResult;
}

function fixture(): Fixture {
  const world = createWorld({
    members: [
      { member: 'mbr-lead', roles: ['member', 'staff_lead'], devices: ['LEAD'] },
      { member: 'mbr-p', roles: ['member', 'answers_for:j2'], devices: ['P'] },
      { member: 'mbr-sl', roles: ['member', 'section_lead:j2'], devices: ['SL'] },
      { member: 'mbr-c', name: 'Col Cee', roles: ['member', `decision_for:${COMMANDER}`], devices: ['C'] },
      { member: 'mbr-d', name: 'Col Dee', roles: ['member', `decision_for:${COMMANDER}`], devices: ['D'] },
      { member: 'mbr-f', name: 'Col Eff', roles: ['member', `decision_for:${COMMANDER}`], devices: ['F'] },
      { member: 'mbr-e', name: 'Maj Eee', roles: ['member', 'decision_for:other'], devices: ['E'] },
      { member: 'mbr-x', roles: ['member'], devices: ['X'] },
      { member: 'mbr-h', roles: ['member'], devices: ['H'] }
    ]
  });
  const hub = fixedSigner('H');
  // The static roster of the world, with the hub device allowed to sign checkpoints (only D15 and N6 use one).
  const spec = { ...world.rosterSpec, rosters: world.rosterSpec.rosters.map((roster) => ({ ...roster, checkpointSigners: [hub.writer] })) };
  const ctx = world.ctx({ roster: staticRosterView(spec) });
  const roles = { owner: 'j2-chief', sectionLead: 'j2-lead', releaseGuard: 'release-guard' };
  const kitOf = (product: string, clientId: number, title: string): Kit => {
    const create = world.write('LEAD', { kind: 'product.create', data: { product, section: 'j2', roles, title } });
    const editor = world.editor('P', product, clientId);
    const reg = editor.register({ deps: [create] });
    const typed = editor.insert(0, 'Hello world', { deps: [reg] });
    return { product, create, editor, reg, typed, textNow: () => docText(editor.doc), snapNow: () => snapshotOf(editor.doc) };
  };
  const blobOf = (text: string): string => {
    const blob = sealBlob(world.keyFor(world.stream, 0), world.stream, 0, canonicalBytes({ text, header: { title: 'T' } }));
    world.blobs.set(blob.hash, blob);
    return blob.hash;
  };
  return {
    world,
    kit: kitOf(PRODUCT, 101, 'Intel estimate'),
    hub,
    ctx,
    extraKit: (product, clientId) => kitOf(product, clientId, product),
    propose(kit, writer, actor, deps, options = {}) {
      const text = options.text ?? kit.textNow();
      const pins = options.pins ?? [];
      const data = {
        product: kit.product,
        hash: options.hash ?? replicaVersionHash(text, pins),
        textBlob: blobOf(text),
        snapshot: Buffer.from(options.snapshot ?? kit.snapNow()).toString('base64url'),
        pins
      };
      return world.write(writer, { kind: 'version.propose', data, actor, deps });
    },
    act: (writer, actor, kind, data, deps) => world.write(writer, { kind, data, actor, deps }),
    fold: (entries = world.entries, foldCtx = ctx, options = {}) => foldEntries(entries, foldCtx, { reducers: REDUCERS, ...options })
  };
}

const productsOf = (result: FoldResult): ProductVersions[] => result.families.versions as ProductVersions[];
const productOf = (result: FoldResult, product = PRODUCT): ProductVersions => productsOf(result).find((entry) => entry.product === product) as ProductVersions;
const versionsOf = (result: FoldResult, product = PRODUCT): VersionView[] => productOf(result, product).versions;
const refusalOf = (result: FoldResult, written: Written, product = PRODUCT): string | undefined => productOf(result, product).refusals.find((refusal) => refusal.entry === written.hash)?.reason;

const verdict = (product: string, hash: string, word: string): Record<string, unknown> => ({ product, hash, gate: 'guard', verdict: word, reasons: [] });

// A version taken to awaiting-decision: proposed by the owner agent on P's device, cleared by the guard, submitted to the commander role.
interface Chain { propose: Written; cleared: Written; submit: Written; hash: string }
function toAwaiting(f: Fixture, kit: Kit, deps: readonly Written[], options: { pins?: Pin[] } = {}): Chain {
  const propose = f.propose(kit, 'P', OWNER, deps, options);
  const hash = replicaVersionHash(kit.textNow(), options.pins ?? []);
  const cleared = f.act('P', GUARD, 'version.verdict', verdict(kit.product, hash, 'CLEARED'), [propose]);
  const submit = f.act('P', OWNER, 'version.submit', { product: kit.product, hash, decisionFor: COMMANDER }, [cleared]);
  return { propose, cleared, submit, hash };
}

const seenOf = (...items: readonly Written[]): string[] => items.map((item) => item.hash);

function decide(f: Fixture, writer: string, outcome: 'approve' | 'reject' | 'decline', chain: Chain, deps: readonly Written[], seen: readonly Written[] = [], options: { actor?: Actor; product?: string } = {}): Written {
  return f.act(writer, options.actor ?? PERSON, 'version.decide', { product: options.product ?? PRODUCT, hash: chain.hash, outcome, reasons: outcome === 'reject' ? ['the figure is not sourced'] : [], decisionsSeen: seenOf(...seen) }, deps);
}
function release(f: Fixture, writer: string, chain: Chain, deps: readonly Written[], seen: readonly Written[] = [], options: { actor?: Actor; product?: string } = {}): Written {
  return f.act(writer, options.actor ?? PERSON, 'version.release', { product: options.product ?? PRODUCT, hash: chain.hash, decisionsSeen: seenOf(...seen) }, deps);
}
function withdraw(f: Fixture, writer: string, chain: Chain, deps: readonly Written[], seen: readonly Written[] = [], options: { actor?: Actor; product?: string } = {}): Written {
  return f.act(writer, options.actor ?? PERSON, 'version.withdraw', { product: options.product ?? PRODUCT, hash: chain.hash, reason: 'obsolete', decisionsSeen: seenOf(...seen) }, deps);
}
function supersede(f: Fixture, writer: string, older: Chain, newer: Chain, deps: readonly Written[], options: { actor?: Actor; product?: string } = {}): Written {
  return f.act(writer, options.actor ?? PERSON, 'version.supersede', { product: options.product ?? PRODUCT, hash: older.hash, byHash: newer.hash }, deps);
}

// Approve then release by C: the version is released.
function released(f: Fixture, chain: Chain): { approve: Written; release: Written } {
  const approve = decide(f, 'C', 'approve', chain, [chain.submit]);
  return { approve, release: release(f, 'C', chain, [approve], [approve]) };
}

// Every delivery order of the decision entries gives the same versions, the same refusals and the same digest; returns the result.
function foldAll(f: Fixture, decisions: readonly Written[], ctx: ReplicaContext = f.ctx, options: FoldOptions = {}): FoldResult {
  assert.ok(decisions.length <= 5, 'at most 5 decision entries are permuted exhaustively');
  const skip = new Set(decisions.map((item) => item.entry));
  const base = f.world.entries.filter((entry) => !skip.has(entry));
  let reference: FoldResult | undefined;
  for (const order of permutations(decisions.map((item) => item.entry))) {
    const result = f.fold([...base, ...order], ctx, options);
    if (reference === undefined) {
      reference = result;
      continue;
    }
    assert.deepEqual(result.families.versions, reference.families.versions);
    assert.deepEqual(result.digests, reference.digests);
    assert.deepEqual(result.refused, reference.refused);
    assert.deepEqual(result.rejected, reference.rejected);
    assert.deepEqual(result.held, reference.held);
  }
  return reference as FoldResult;
}

// ---- Task 1: the tracer -------------------------------------------------------------------------------------------------------------------------

test('tracer: the commander role holder approves a guard-cleared version and then releases it, in every delivery order', () => {
  const f = fixture();
  const chain = toAwaiting(f, f.kit, [f.kit.typed]);
  const approve = decide(f, 'C', 'approve', chain, [chain.submit]);

  const approved = foldAll(f, [approve]);
  assert.deepEqual([approved.refused, approved.held, approved.rejected], [[], [], []]);
  const view = versionsOf(approved)[0];
  assert.equal(view.state, 'approved');
  assert.deepEqual(view.decision, { status: 'effective', outcome: 'APPROVE', names: ['Col Cee'], contested: [], effective: [approve.hash], pending: [], held: [], finalBeforeDispute: false });
  assert.equal(view.overlay, undefined);
  assert.equal(productOf(approved).records[0].release.approval?.by.name, 'Col Cee');
  assert.equal(productOf(approved).records[0].release.approval?.by.deviceFingerprint, f.world.writerOf('C'));

  const done = release(f, 'C', chain, [approve], [approve]);
  const result = foldAll(f, [approve, done]);
  assert.equal(versionsOf(result)[0].state, 'released');
  assert.deepEqual(versionsOf(result)[0].decision.names, ['Col Cee']);
  assert.equal(versionsOf(result)[0].decision.outcome, 'APPROVE');
  assert.deepEqual(productOf(result).refusals, []);
});

test('tracer: an agent signing with the device of a decision role holder cannot approve; release.ts itself refuses it agent-cannot-decide', () => {
  const f = fixture();
  const chain = toAwaiting(f, f.kit, [f.kit.typed]);
  const byAgent = decide(f, 'C', 'approve', chain, [chain.submit], [], { actor: { kind: 'agent', member: 'j2-chief', run: 'r-9' } });
  const result = foldAll(f, [byAgent]);
  const view = versionsOf(result)[0];
  assert.equal(view.state, 'awaiting-decision');
  assert.equal(view.decision.status, 'none');
  assert.equal(refusalOf(result, byAgent), 'agent-cannot-decide');
  // The refusal is the machine's own: the same event for the same agent is refused there, and the device's member does hold the role.
  const record = productOf(result).records[0].release;
  assert.equal(transition(record, { type: 'approve', hash: chain.hash }, { kind: 'agent', member: 'j2-chief' }).ok, false);
  const mine = f.ctx.roster.hasRole('mbr-c', `decision_for:${COMMANDER}`, f.world.rosterHash);
  assert.equal(mine, true);
  // A hub is never presented to the machine as a person.
  const hubActor = actorForTransition({ actor: { kind: 'hub', watch: 'w-1' }, member: 'mbr-c', writer: f.world.writerOf('C'), roster: f.world.rosterHash }, f.ctx.roster, record.roles, true);
  assert.equal(hubActor.kind, 'agent');
  assert.equal(personForTransition('mbr-c', COMMANDER, f.world.writerOf('C'), f.world.rosterHash, f.ctx.roster).name, 'Col Cee');
});

test('tracer: the same entries give the same result when the world is folded with the agent act and the person act together', () => {
  const f = fixture();
  const chain = toAwaiting(f, f.kit, [f.kit.typed]);
  const byAgent = decide(f, 'C', 'approve', chain, [chain.submit], [], { actor: { kind: 'agent', member: 'j2-chief', run: 'r-9' } });
  const byPerson = decide(f, 'D', 'approve', chain, [chain.submit]);
  const result = foldAll(f, [byAgent, byPerson]);
  assert.equal(versionsOf(result)[0].state, 'approved');
  assert.deepEqual(versionsOf(result)[0].decision.names, ['Col Dee']);
  assert.equal(refusalOf(result, byAgent), 'agent-cannot-decide');
});

// ---- helpers for rosters and checkpoints ----------------------------------------------------------------------------------------------------------

// A roster change that removes one member's decision role: a roster-stream member.update entry by the lead's device (kept, not folded, in Phase 30), and a
// roster view whose second roster has that entry's hash and lacks the role. The entry cites the first roster and is placed by `deps`.
function removalOf(f: Fixture, member: string, deps: readonly Written[] = []): { removal: Written; ctx: ReplicaContext } {
  const removal = f.world.write('LEAD', { kind: 'member.update', stream: ROSTER_STREAM, deps, data: { member, name: 'Removed Role', rosterPrev: f.world.rosterHash } });
  const first = { ...f.world.rosterSpec.rosters[0], checkpointSigners: [f.hub.writer] };
  const second = { ...first, hash: removal.hash, members: first.members.map((entry) => (entry.member === member ? { ...entry, roles: entry.roles.filter((role) => !role.startsWith('decision_for:')) } : entry)) };
  return { removal, ctx: f.world.ctx({ roster: staticRosterView({ rosters: [first, second] }) }) };
}

// The checkpoint a correct hub would sign over the covered entries: heads, count and the chained order tip of their final order, per stream.
function checkpointOf(f: Fixture, covered: readonly Written[], ctx: ReplicaContext = f.ctx): SignedCheckpoint {
  const entries = covered.map((item) => {
    const outcome = verifyEntry(item.entry, ctx);
    assert.equal(outcome.status, 'verified');
    return (outcome as { entry: VerifiedEntry }).entry;
  });
  const ordered = totalOrder(entries);
  const streams = [...new Set(entries.map((entry) => entry.header.stream))].sort().map((stream) => {
    const heads = new Map<string, Dep>();
    for (const entry of entries.filter((candidate) => candidate.header.stream === stream)) {
      const known = heads.get(entry.header.writer);
      if (known === undefined || known.seq < entry.header.seq) heads.set(entry.header.writer, { writer: entry.header.writer, seq: entry.header.seq, hash: entry.hash });
    }
    const hashes = ordered.filter((entry) => entry.header.stream === stream).map((entry) => entry.hash);
    return { stream, heads: [...heads.values()].sort((x, y) => (x.writer < y.writer ? -1 : 1)), count: hashes.length, orderTip: orderTipOf(hashes) };
  });
  const checkpoint: Checkpoint = { type: 'checkpoint', v: 1, project: 'project-main', signer: f.hub.writer, rosterHead: f.world.rosterHash, streams };
  return signCheckpoint(f.hub.signer, checkpoint);
}

// Two versions of the product, both at awaiting-decision: v1 from the first text, v2 after one more edit.
function twoVersions(f: Fixture): { one: Chain; two: Chain } {
  const one = toAwaiting(f, f.kit, [f.kit.typed]);
  const edit = f.kit.editor.insert(11, '!', { deps: [one.submit] });
  const two = toAwaiting(f, f.kit, [edit]);
  return { one, two };
}

// ---- Task 2: 15.4 rows 6 to 11 ------------------------------------------------------------------------------------------------------------------

test('G6: an effective approve moves awaiting-decision to approved, and an effective reject moves it to rejected with its reasons; a reject without reasons is refused', () => {
  const f = fixture();
  const chain = toAwaiting(f, f.kit, [f.kit.typed]);
  const approve = decide(f, 'C', 'approve', chain, [chain.submit]);
  const approved = foldAll(f, [approve]);
  assert.equal(versionsOf(approved)[0].state, 'approved');
  assert.equal(versionsOf(approved)[0].decision.status, 'effective');

  const g = fixture();
  const other = toAwaiting(g, g.kit, [g.kit.typed]);
  const reject = decide(g, 'C', 'reject', other, [other.submit]);
  const bare = g.act('D', PERSON, 'version.decide', { product: PRODUCT, hash: other.hash, outcome: 'reject', reasons: [], decisionsSeen: [] }, [other.submit]);
  const rejected = foldAll(g, [reject, bare]);
  assert.equal(versionsOf(rejected)[0].state, 'rejected');
  assert.deepEqual(versionsOf(rejected)[0].decision, { status: 'effective', outcome: 'REJECT', names: ['Col Cee'], contested: [], effective: [reject.hash], pending: [], held: [], finalBeforeDispute: false });
  assert.deepEqual(productOf(rejected).records[0].release.rejection?.reasons, ['the figure is not sourced']);
  assert.equal(refusalOf(rejected, bare), 'reasons-required');
});

test('G7: concurrent approve and reject leave the version at awaiting-decision with overlay contested, and neither applies', () => {
  const f = fixture();
  const chain = toAwaiting(f, f.kit, [f.kit.typed]);
  const approve = decide(f, 'C', 'approve', chain, [chain.submit]);
  const reject = decide(f, 'D', 'reject', chain, [chain.submit]);
  const result = foldAll(f, [approve, reject]);
  const view = versionsOf(result)[0];
  assert.deepEqual([view.state, view.overlay, view.decision.status], ['awaiting-decision', 'contested', 'contested']);
  assert.deepEqual(view.decision.contested, [approve.hash, reject.hash].sort());
  assert.equal(view.decision.outcome, undefined);
  assert.equal(productOf(result).records[0].release.approval, undefined);
});

test('G7: a decision concurrent with a withdraw by the owner side is contested as well', () => {
  const f = fixture();
  const chain = toAwaiting(f, f.kit, [f.kit.typed]);
  const approve = decide(f, 'C', 'approve', chain, [chain.submit]);
  const pull = withdraw(f, 'P', chain, [chain.submit], [], { actor: OWNER });
  const result = foldAll(f, [approve, pull]);
  const view = versionsOf(result)[0];
  assert.deepEqual([view.state, view.overlay, view.decision.status], ['awaiting-decision', 'contested', 'contested']);
  assert.deepEqual(productOf(result).refusals, []);
});

test('G8: a fresh decision that saw every contested act settles it, and so does a withdraw that saw them all', () => {
  const f = fixture();
  const chain = toAwaiting(f, f.kit, [f.kit.typed]);
  const approve = decide(f, 'C', 'approve', chain, [chain.submit]);
  const reject = decide(f, 'D', 'reject', chain, [chain.submit]);
  const fresh = decide(f, 'F', 'approve', chain, [approve, reject], [approve, reject]);
  const settled = foldAll(f, [approve, reject, fresh]);
  const view = versionsOf(settled)[0];
  assert.deepEqual([view.state, view.overlay, view.decision.status, view.decision.outcome], ['approved', undefined, 'effective', 'APPROVE']);
  assert.deepEqual(view.decision.names, ['Col Eff']);

  const g = fixture();
  const gc = toAwaiting(g, g.kit, [g.kit.typed]);
  const ga = decide(g, 'C', 'approve', gc, [gc.submit]);
  const gr = decide(g, 'D', 'reject', gc, [gc.submit]);
  const pull = withdraw(g, 'P', gc, [ga, gr], [ga, gr], { actor: OWNER });
  const pulled = foldAll(g, [ga, gr, pull]);
  assert.deepEqual([versionsOf(pulled)[0].state, versionsOf(pulled)[0].decision.outcome], ['withdrawn', 'WITHDRAW']);
});

test('G9: a release with an effective approval of the same hash in its past releases the version; one that did not see the approval is refused no-approval', () => {
  const f = fixture();
  const chain = toAwaiting(f, f.kit, [f.kit.typed]);
  const approve = decide(f, 'C', 'approve', chain, [chain.submit]);
  const early = release(f, 'D', chain, [chain.submit]);
  const done = release(f, 'D', chain, [approve], [approve]);
  const result = foldAll(f, [approve, early, done]);
  assert.equal(versionsOf(result)[0].state, 'released');
  assert.equal(refusalOf(result, early), 'no-approval');
  assert.deepEqual(versionsOf(result)[0].decision.names, ['Col Dee']);
});

test('G10: a released v1 is superseded by a released, higher-numbered v2; naming an unreleased or lower version is refused', () => {
  const f = fixture();
  const { one, two } = twoVersions(f);
  const r1 = released(f, one);
  const r2 = released(f, two);
  const replace = supersede(f, 'D', one, two, [r1.release, r2.release]);
  const result = foldAll(f, [r1.approve, r1.release, r2.approve, r2.release, replace]);
  assert.deepEqual(versionsOf(result).map((view) => [view.number, view.state]), [[1, 'superseded'], [2, 'released']]);
  assert.equal(productOf(result).records[0].release.supersededBy, 2);

  const g = fixture();
  const pair = twoVersions(g);
  const a1 = released(g, pair.one);
  const a2 = g.act('C', PERSON, 'version.decide', { product: PRODUCT, hash: pair.two.hash, outcome: 'approve', reasons: [], decisionsSeen: [] }, [pair.two.submit]);
  const unreleased = supersede(g, 'D', pair.one, pair.two, [a1.release, a2]);
  const lower = supersede(g, 'D', pair.two, pair.one, [a1.release, a2]);
  const lonely = fixture();
  const solo = toAwaiting(lonely, lonely.kit, [lonely.kit.typed]);
  const edit = lonely.kit.editor.insert(11, '!', { deps: [solo.submit] });
  const next = toAwaiting(lonely, lonely.kit, [edit]);
  const only = decide(lonely, 'C', 'approve', solo, [solo.submit]);
  const noRelease = supersede(lonely, 'D', solo, next, [only]);
  const result2 = foldAll(g, [a1.approve, a1.release, a2, unreleased, lower]);
  assert.equal(refusalOf(result2, unreleased), 'not-released');
  assert.equal(refusalOf(result2, lower), 'out-of-order');
  assert.deepEqual(versionsOf(result2).map((view) => view.state), ['released', 'approved']);
  const result3 = foldAll(lonely, [only, noRelease]);
  assert.equal(refusalOf(result3, noRelease), 'not-released');
  assert.equal(versionsOf(result3)[0].state, 'approved');
});

test('G11: the owner side may withdraw before approval; after approval only a person who holds the decision role may, and an agent never may', () => {
  const f = fixture();
  const chain = toAwaiting(f, f.kit, [f.kit.typed]);
  const byAgent = withdraw(f, 'P', chain, [chain.submit], [], { actor: OWNER });
  assert.equal(versionsOf(foldAll(f, [byAgent]))[0].state, 'withdrawn');

  const g = fixture();
  const gc = toAwaiting(g, g.kit, [g.kit.typed]);
  const byOwnerPerson = withdraw(g, 'P', gc, [gc.submit]);
  assert.equal(versionsOf(foldAll(g, [byOwnerPerson]))[0].state, 'withdrawn');

  const h = fixture();
  const hc = toAwaiting(h, h.kit, [h.kit.typed]);
  const stranger = withdraw(h, 'X', hc, [hc.submit]);
  const strangerResult = foldAll(h, [stranger]);
  assert.equal(refusalOf(strangerResult, stranger), 'not-owner-or-person');
  assert.equal(versionsOf(strangerResult)[0].state, 'awaiting-decision');

  const i = fixture();
  const ic = toAwaiting(i, i.kit, [i.kit.typed]);
  const approve = decide(i, 'C', 'approve', ic, [ic.submit]);
  const afterByAgent = withdraw(i, 'P', ic, [approve], [approve], { actor: OWNER });
  const afterByOwnerPerson = withdraw(i, 'P', ic, [approve], [approve]);
  const afterByStranger = withdraw(i, 'X', ic, [approve], [approve]);
  const refused = foldAll(i, [approve, afterByAgent, afterByOwnerPerson, afterByStranger]);
  assert.equal(versionsOf(refused)[0].state, 'approved');
  assert.equal(refusalOf(refused, afterByAgent), 'agent-cannot-decide');
  assert.equal(refusalOf(refused, afterByOwnerPerson), 'not-decision-holder');
  assert.equal(refusalOf(refused, afterByStranger), 'not-decision-holder');
  const afterByHolder = withdraw(i, 'D', ic, [approve], [approve]);
  const done = foldAll(i, [approve, afterByHolder]);
  assert.deepEqual([versionsOf(done)[0].state, versionsOf(done)[0].decision.outcome, versionsOf(done)[0].decision.names], ['withdrawn', 'WITHDRAW', ['Col Dee']]);
});

test('G12: nothing leaves withdrawn or superseded: a later decision is refused terminal', () => {
  const f = fixture();
  const chain = toAwaiting(f, f.kit, [f.kit.typed]);
  const pull = withdraw(f, 'P', chain, [chain.submit], [], { actor: OWNER });
  const late = decide(f, 'C', 'approve', chain, [pull]);
  const result = foldAll(f, [pull, late]);
  assert.equal(versionsOf(result)[0].state, 'withdrawn');
  assert.equal(refusalOf(result, late), 'terminal');

  const g = fixture();
  const { one, two } = twoVersions(g);
  const r1 = released(g, one);
  const r2 = released(g, two);
  const replace = supersede(g, 'D', one, two, [r1.release, r2.release]);
  const after = decide(g, 'C', 'reject', one, [replace]);
  const pullAfter = withdraw(g, 'D', one, [replace]);
  const result2 = foldAll(g, [r1.approve, r1.release, r2.approve, r2.release, replace]);
  assert.equal(versionsOf(result2)[0].state, 'superseded');
  const full = g.fold([...g.world.entries]);
  assert.equal(versionsOf(full)[0].state, 'superseded');
  assert.equal(refusalOf(full, after), 'terminal');
  assert.equal(refusalOf(full, pullAfter), 'terminal');
});

// ---- Task 2: 15.5 transitions through the fold ---------------------------------------------------------------------------------------------------

test('15.5 none to effective (D2) and none to contested (D4)', () => {
  const f = fixture();
  const chain = toAwaiting(f, f.kit, [f.kit.typed]);
  assert.equal(versionsOf(f.fold())[0].decision.status, 'none');
  const approve = decide(f, 'C', 'approve', chain, [chain.submit]);
  assert.deepEqual([versionsOf(foldAll(f, [approve]))[0].decision.status, versionsOf(f.fold())[0].state], ['effective', 'approved']);
  const reject = decide(f, 'D', 'reject', chain, [chain.submit]);
  assert.equal(versionsOf(foldAll(f, [approve, reject]))[0].decision.status, 'contested');
});

test('15.5 effective to effective (D3): a reject that saw the approve replaces it', () => {
  const f = fixture();
  const chain = toAwaiting(f, f.kit, [f.kit.typed]);
  const approve = decide(f, 'C', 'approve', chain, [chain.submit]);
  const reject = decide(f, 'D', 'reject', chain, [approve], [approve]);
  const result = foldAll(f, [approve, reject]);
  const view = versionsOf(result)[0];
  assert.deepEqual([view.state, view.decision.status, view.decision.outcome, view.decision.names], ['rejected', 'effective', 'REJECT', ['Col Dee']]);
});

test('15.5 effective to contested (D14): a reject concurrent with an effective approve contests it', () => {
  const f = fixture();
  const chain = toAwaiting(f, f.kit, [f.kit.typed]);
  const approve = decide(f, 'C', 'approve', chain, [chain.submit]);
  assert.equal(versionsOf(f.fold())[0].decision.status, 'effective');
  const reject = decide(f, 'D', 'reject', chain, [chain.submit]);
  const result = foldAll(f, [approve, reject]);
  assert.deepEqual([versionsOf(result)[0].decision.status, versionsOf(result)[0].state, versionsOf(result)[0].overlay], ['contested', 'awaiting-decision', 'contested']);
});

test('15.5 contested to effective (D11): a fresh decision that saw both settles it, even by the author of one of them', () => {
  const f = fixture();
  const chain = toAwaiting(f, f.kit, [f.kit.typed]);
  const approve = decide(f, 'C', 'approve', chain, [chain.submit]);
  const reject = decide(f, 'D', 'reject', chain, [chain.submit]);
  const fresh = decide(f, 'C', 'reject', chain, [approve, reject], [approve, reject]);
  const result = foldAll(f, [approve, reject, fresh]);
  const view = versionsOf(result)[0];
  assert.deepEqual([view.state, view.decision.status, view.decision.outcome, view.decision.names, view.overlay], ['rejected', 'effective', 'REJECT', ['Col Cee'], undefined]);
});

test('D12: a fresh decision that saw only one of the contested acts leaves the version contested', () => {
  const f = fixture();
  const chain = toAwaiting(f, f.kit, [f.kit.typed]);
  const approve = decide(f, 'C', 'approve', chain, [chain.submit]);
  const reject = decide(f, 'D', 'reject', chain, [chain.submit]);
  const partial = decide(f, 'F', 'approve', chain, [approve], [approve]);
  const result = foldAll(f, [approve, reject, partial]);
  const view = versionsOf(result)[0];
  assert.deepEqual([view.state, view.overlay, view.decision.status], ['awaiting-decision', 'contested', 'contested']);
  assert.deepEqual(view.decision.contested, [partial.hash, reject.hash].sort());
});

test('D15: a decision under a checkpoint prefix and a late concurrent reject still contest, and only finalBeforeDispute is set', () => {
  const f = fixture();
  const chain = toAwaiting(f, f.kit, [f.kit.typed]);
  const approve = decide(f, 'C', 'approve', chain, [chain.submit]);
  const late = decide(f, 'D', 'reject', chain, [chain.submit]);
  const signed = checkpointOf(f, [f.kit.create, f.kit.reg, f.kit.typed, chain.propose, chain.cleared, chain.submit, approve]);
  const result = foldAll(f, [approve, late], f.ctx, { checkpoints: [signed] });
  assert.equal(result.checkpoint, checkpointHash(signed));
  const view = versionsOf(result)[0];
  assert.deepEqual([view.state, view.overlay, view.decision.status, view.decision.finalBeforeDispute], ['awaiting-decision', 'contested', 'contested', true]);
  assert.deepEqual(view.decision.contested, [approve.hash, late.hash].sort());
  // Without the checkpoint the same entries contest and nothing is final.
  assert.equal(versionsOf(f.fold())[0].decision.finalBeforeDispute, false);
});

// ---- Task 2: roster changes in flight (D16 to D21, D24) ------------------------------------------------------------------------------------------

test('D16: a decision concurrent with the removal of its role is pending-confirmation and the state stays awaiting-decision', () => {
  const f = fixture();
  const chain = toAwaiting(f, f.kit, [f.kit.typed]);
  const { removal, ctx } = removalOf(f, 'mbr-c');
  const approve = decide(f, 'C', 'approve', chain, [chain.submit]);
  const result = foldAll(f, [approve, removal], ctx);
  assert.deepEqual(result.kept.filter((item) => item.hash === removal.hash).map((item) => item.reason), ['folded-in-later-phase']);
  const view = versionsOf(result)[0];
  assert.deepEqual([view.state, view.overlay, view.decision.status, view.decision.pending], ['awaiting-decision', 'pending-confirmation', 'none', [approve.hash]]);
  assert.equal(productOf(result).records[0].release.approval, undefined);
});

test('D17 and D18: a confirmed decision that saw the pending one settles it, with its own outcome', () => {
  const f = fixture();
  const chain = toAwaiting(f, f.kit, [f.kit.typed]);
  const { removal, ctx } = removalOf(f, 'mbr-c');
  const pending = decide(f, 'C', 'approve', chain, [chain.submit]);
  const confirm = decide(f, 'D', 'approve', chain, [pending], [pending]);
  const confirmed = foldAll(f, [pending, removal, confirm], ctx);
  const view = versionsOf(confirmed)[0];
  assert.deepEqual([view.state, view.overlay, view.decision.status, view.decision.names, view.decision.pending], ['approved', undefined, 'effective', ['Col Dee'], []]);

  const g = fixture();
  const gc = toAwaiting(g, g.kit, [g.kit.typed]);
  const gone = removalOf(g, 'mbr-c');
  const gp = decide(g, 'C', 'approve', gc, [gc.submit]);
  const turn = decide(g, 'D', 'reject', gc, [gp], [gp]);
  const turned = foldAll(g, [gp, gone.removal, turn], gone.ctx);
  assert.deepEqual([versionsOf(turned)[0].state, versionsOf(turned)[0].decision.outcome, versionsOf(turned)[0].decision.pending], ['rejected', 'REJECT', []]);
});

test('D19: a decline that saw only the pending decision returns the version to none, with nothing pending', () => {
  const f = fixture();
  const chain = toAwaiting(f, f.kit, [f.kit.typed]);
  const { removal, ctx } = removalOf(f, 'mbr-c');
  const pending = decide(f, 'C', 'approve', chain, [chain.submit]);
  const decline = decide(f, 'D', 'decline', chain, [pending], [pending]);
  const result = foldAll(f, [pending, removal, decline], ctx);
  const view = versionsOf(result)[0];
  assert.deepEqual([view.state, view.overlay, view.decision.status, view.decision.pending], ['awaiting-decision', undefined, 'none', []]);
  assert.deepEqual(productOf(result).refusals, []);
});

test('D20: a decision the removal saw stands, and one made after the removal citing the new roster is refused not-decision-holder', () => {
  const f = fixture();
  const chain = toAwaiting(f, f.kit, [f.kit.typed]);
  const approve = decide(f, 'C', 'approve', chain, [chain.submit]);
  const { removal, ctx } = removalOf(f, 'mbr-c', [approve]);
  const after = f.act('F', PERSON, 'version.release', { product: PRODUCT, hash: chain.hash, decisionsSeen: [approve.hash] }, [approve, removal]);
  const cited = f.world.write('C', { kind: 'version.release', data: { product: PRODUCT, hash: chain.hash, decisionsSeen: [approve.hash] }, actor: PERSON, deps: [approve, removal], roster: removal.hash });
  const result = foldAll(f, [approve, removal, cited], ctx);
  const view = versionsOf(result)[0];
  assert.deepEqual([view.state, view.decision.status, view.decision.pending, view.overlay], ['approved', 'effective', [], undefined]);
  assert.equal(refusalOf(result, cited), 'not-decision-holder');
  // The release that still cites the old roster is itself rejected by the chain: it follows the removal and cites an older roster.
  assert.ok(foldAll(f, [approve, removal, after], ctx).rejected.some((item) => item.hash === after.hash && item.reason === 'stale-roster-citation'));
});

test('D21: a decision whose past holds the removal but which cites the older roster is rejected stale-roster-citation at the chain', () => {
  const f = fixture();
  const chain = toAwaiting(f, f.kit, [f.kit.typed]);
  const { removal, ctx } = removalOf(f, 'mbr-c');
  const stale = decide(f, 'C', 'approve', chain, [chain.submit, removal]);
  const result = foldAll(f, [removal, stale], ctx);
  assert.ok(result.rejected.some((item) => item.hash === stale.hash && item.reason === 'stale-roster-citation'));
  const view = versionsOf(result)[0];
  assert.deepEqual([view.state, view.decision.status, view.decision.pending], ['awaiting-decision', 'none', []]);
});

test('D24: a decision that saw an entry this machine does not hold is held until it arrives', () => {
  const f = fixture();
  const chain = toAwaiting(f, f.kit, [f.kit.typed]);
  const theirs = decide(f, 'D', 'approve', chain, [chain.submit]);
  const mine = decide(f, 'C', 'approve', chain, [chain.submit], [theirs]);
  const without = f.fold(f.world.entries.filter((entry) => entry !== theirs.entry));
  const heldView = versionsOf(without)[0];
  assert.deepEqual([heldView.state, heldView.decision.status, heldView.decision.held], ['awaiting-decision', 'none', [{ id: mine.hash, reason: 'unknown-decision-seen' }]]);
  const withBoth = foldAll(f, [theirs, mine]);
  const view = versionsOf(withBoth)[0];
  assert.deepEqual([view.state, view.decision.status, view.decision.held, view.decision.names], ['approved', 'effective', [], ['Col Cee']]);
});
