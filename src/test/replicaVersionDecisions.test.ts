// Decisions on versions through the fold (plan 30-10, D-24, D-25, D-37; DESIGN 15.4 rows 6 to 11, 15.5): real signed entries, the decision algebra of
// 30-07 and release.ts's transition() together. Every test asserts one result under every delivery order of its decision entries.
// The world builders are local to this file (the shared helper is not edited).
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalBytes } from '../domain/team/canonical';
import { docText, snapshotOf } from '../domain/replica/doc';
import { sealBlob } from '../domain/replica/entry';
import type { Actor, SealedEntry } from '../domain/replica/entry';
import { buildCausalGraph } from '../domain/replica/causal';
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

// ---- keep these helpers exported to the later tests in this file ------------------------------------------------------------------------------------
void [buildCausalGraph, checkpointHash, orderTipOf, signCheckpoint, totalOrder, verifyEntry, ROSTER_STREAM, OTHER_HASH, released, withdraw, supersede];
export type { Checkpoint, SignedCheckpoint, VerifiedEntry };
