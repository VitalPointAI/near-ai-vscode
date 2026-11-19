// The forbidden acts of DESIGN 15.4 (plan 30-10, T-30-39 to T-30-42, D-06, D-24): no agent or hub actor decides, a person without the role does not, and
// approvals never count for another version. Each agent case runs on the device of a member who DOES hold the decision role, and again on the device of one
// who does not, so the refusal cannot come from the roster check. Every result is asserted under all delivery orders of the decision entries.
// The world builders are local copies (the shared helper is not edited).
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalBytes } from '../domain/team/canonical';
import { docText, snapshotOf } from '../domain/replica/doc';
import { sealBlob } from '../domain/replica/entry';
import type { Actor, SealedEntry } from '../domain/replica/entry';
import { foldEntries } from '../domain/replica/fold';
import type { FoldOptions, FoldResult } from '../domain/replica/fold';
import { staticRosterView } from '../domain/replica/rosterView';
import type { ReplicaContext } from '../domain/replica/rosterView';
import { textReducer } from '../domain/replica/textFold';
import { actorForTransition, personForTransition, replicaVersionHash, versionsReducer } from '../domain/replica/versions';
import type { Pin, ProductVersions, VersionView } from '../domain/replica/versions';
import { transition } from '../domain/staff/release';
import type { ProductRecord, StaffActor } from '../domain/staff/release';
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

// Two versions of the product, both at awaiting-decision: v1 from the first text, v2 after one more edit.
function twoVersions(f: Fixture): { one: Chain; two: Chain } {
  const one = toAwaiting(f, f.kit, [f.kit.typed]);
  const edit = f.kit.editor.insert(11, '!', { deps: [one.submit] });
  const two = toAwaiting(f, f.kit, [edit]);
  return { one, two };
}


const AGENT: Actor = { kind: 'agent', member: 'j2-chief', run: 'r-9' };
const HUB: Actor = { kind: 'hub', watch: 'w-1' };

// ---- F1 to F4: no agent or hub actor approves, rejects, releases or supersedes ---------------------------------------------------------------------------

// The version at awaiting-decision, with the act under test written by `actor` on each of the two devices.
function agentActsOnTwoDevices(make: (f: Fixture, writer: string, actor: Actor) => { written: Written; chain: Chain; before: Written[] }): void {
  for (const actor of [AGENT, HUB]) {
    for (const writer of ['C', 'X']) {
      const f = fixture();
      const { written, chain, before } = make(f, writer, actor);
      const result = foldAll(f, [written]);
      const view = versionsOf(result)[0];
      if (actor.kind === 'hub') {
        // The fold keeps a hub entry and never gives it to a reducer: it cannot reach a decision at all.
        assert.deepEqual(result.kept.filter((item) => item.hash === written.hash).map((item) => item.reason), ['hub-actor']);
        assert.equal(refusalOf(result, written), undefined);
      } else {
        assert.equal(refusalOf(result, written), 'agent-cannot-decide', `${actor.kind} on ${writer}`);
      }
      // Nothing the act asked for happened: the version is where the acts before it left it.
      assert.equal(before.every((item) => view.decision.effective.includes(item.hash) || !view.decision.effective.includes(written.hash)), true);
      assert.equal(view.decision.effective.includes(written.hash), false);
      assert.equal(view.hash, chain.hash);
    }
  }
}

test('F1 an agent or a hub actor cannot approve, whether or not the signing device holds the decision role', () => {
  const f = fixture();
  assert.equal(f.ctx.roster.hasRole('mbr-c', `decision_for:${COMMANDER}`, f.world.rosterHash), true);
  assert.equal(f.ctx.roster.hasRole('mbr-x', `decision_for:${COMMANDER}`, f.world.rosterHash), false);
  agentActsOnTwoDevices((g, writer, actor) => {
    const chain = toAwaiting(g, g.kit, [g.kit.typed]);
    return { written: decide(g, writer, 'approve', chain, [chain.submit], [], { actor }), chain, before: [] };
  });
  const g = fixture();
  const chain = toAwaiting(g, g.kit, [g.kit.typed]);
  const byAgent = decide(g, 'C', 'approve', chain, [chain.submit], [], { actor: AGENT });
  assert.equal(versionsOf(foldAll(g, [byAgent]))[0].state, 'awaiting-decision');
});

test('F2 an agent or a hub actor cannot reject', () => {
  agentActsOnTwoDevices((g, writer, actor) => {
    const chain = toAwaiting(g, g.kit, [g.kit.typed]);
    return { written: decide(g, writer, 'reject', chain, [chain.submit], [], { actor }), chain, before: [] };
  });
  const f = fixture();
  const chain = toAwaiting(f, f.kit, [f.kit.typed]);
  const byAgent = decide(f, 'C', 'reject', chain, [chain.submit], [], { actor: AGENT });
  const result = foldAll(f, [byAgent]);
  assert.deepEqual([versionsOf(result)[0].state, versionsOf(result)[0].decision.status], ['awaiting-decision', 'none']);
});

test('F3 an agent or a hub actor cannot release an approved version', () => {
  agentActsOnTwoDevices((g, writer, actor) => {
    const chain = toAwaiting(g, g.kit, [g.kit.typed]);
    const approve = decide(g, 'C', 'approve', chain, [chain.submit]);
    return { written: release(g, writer, chain, [approve], [approve], { actor }), chain, before: [approve] };
  });
  const f = fixture();
  const chain = toAwaiting(f, f.kit, [f.kit.typed]);
  const approve = decide(f, 'C', 'approve', chain, [chain.submit]);
  const byAgent = release(f, 'C', chain, [approve], [approve], { actor: AGENT });
  const result = foldAll(f, [approve, byAgent]);
  assert.deepEqual([versionsOf(result)[0].state, versionsOf(result)[0].decision.outcome], ['approved', 'APPROVE']);
  assert.equal(refusalOf(result, byAgent), 'agent-cannot-decide');
});

test('F4 an agent or a hub actor cannot supersede a released version', () => {
  agentActsOnTwoDevices((g, writer, actor) => {
    const { one, two } = twoVersions(g);
    const r1 = released(g, one);
    const r2 = released(g, two);
    return { written: supersede(g, writer, one, two, [r1.release, r2.release], { actor }), chain: one, before: [r1.approve, r1.release, r2.approve, r2.release] };
  });
  const f = fixture();
  const { one, two } = twoVersions(f);
  const r1 = released(f, one);
  const r2 = released(f, two);
  const byAgent = supersede(f, 'D', one, two, [r1.release, r2.release], { actor: AGENT });
  const result = foldAll(f, [r1.approve, r1.release, r2.approve, r2.release, byAgent]);
  assert.deepEqual(versionsOf(result).map((view) => view.state), ['released', 'released']);
  assert.equal(refusalOf(result, byAgent), 'agent-cannot-decide');
});

test('F1 the refusal is release.ts itself: every human-only event for an agent or a hub shown to the machine is refused agent-cannot-decide, in every state', () => {
  const f = fixture();
  const chain = toAwaiting(f, f.kit, [f.kit.typed]);
  const record = productOf(f.fold()).records[0].release as ProductRecord;
  const hubActor: StaffActor = actorForTransition({ actor: HUB, member: 'mbr-c', writer: f.world.writerOf('C'), roster: f.world.rosterHash }, f.ctx.roster, record.roles, true);
  const agentActor: StaffActor = actorForTransition({ actor: AGENT, member: 'mbr-c', writer: f.world.writerOf('C'), roster: f.world.rosterHash }, f.ctx.roster, record.roles, true);
  for (const actor of [hubActor, agentActor]) {
    assert.equal(actor.kind, 'agent');
    for (const event of [{ type: 'approve', hash: chain.hash }, { type: 'reject', reasons: ['x'] }, { type: 'release', hash: chain.hash }, { type: 'supersede', byVersion: 2 }] as const) {
      const result = transition(record, event, actor);
      assert.deepEqual(result.ok ? null : result.reason, 'agent-cannot-decide');
    }
  }
});

// ---- the other forbidden acts -------------------------------------------------------------------------------------------------------------------

test('F1 a person who does not hold the decision role cannot approve, reject or release either (not-decision-holder)', () => {
  const f = fixture();
  const chain = toAwaiting(f, f.kit, [f.kit.typed]);
  const byX = decide(f, 'X', 'approve', chain, [chain.submit]);
  const byOtherRole = decide(f, 'E', 'reject', chain, [chain.submit]);
  const byOwnerSide = decide(f, 'P', 'approve', chain, [chain.submit]);
  const result = foldAll(f, [byX, byOtherRole, byOwnerSide]);
  for (const item of [byX, byOtherRole, byOwnerSide]) assert.equal(refusalOf(result, item), 'not-decision-holder');
  assert.deepEqual([versionsOf(result)[0].state, versionsOf(result)[0].decision.status], ['awaiting-decision', 'none']);
});

test('F5 approve without a guard clear is refused wrong-state, after a HOLD, after nothing and after a CLEARED that was not submitted', () => {
  const f = fixture();
  const propose = f.propose(f.kit, 'P', OWNER, [f.kit.typed]);
  const hash = replicaVersionHash(f.kit.textNow(), []);
  const chain: Chain = { propose, cleared: propose, submit: propose, hash };
  const bare = decide(f, 'C', 'approve', chain, [propose]);
  const hold = f.act('P', GUARD, 'version.verdict', { product: PRODUCT, hash, gate: 'guard', verdict: 'HOLD', reasons: ['no source'] }, [propose]);
  const afterHold = decide(f, 'D', 'approve', chain, [hold]);
  const result = foldAll(f, [bare, afterHold]);
  assert.equal(refusalOf(result, bare), 'wrong-state');
  assert.equal(refusalOf(result, afterHold), 'wrong-state');
  assert.deepEqual([versionsOf(result)[0].state, versionsOf(result)[0].held?.gate], ['draft', 'guard']);

  const g = fixture();
  const gp = g.propose(g.kit, 'P', OWNER, [g.kit.typed]);
  const gh = replicaVersionHash(g.kit.textNow(), []);
  const cleared = g.act('P', GUARD, 'version.verdict', { product: PRODUCT, hash: gh, gate: 'guard', verdict: 'CLEARED', reasons: [] }, [gp]);
  const early = decide(g, 'C', 'approve', { propose: gp, cleared, submit: cleared, hash: gh }, [cleared]);
  const earlyResult = foldAll(g, [early]);
  assert.equal(refusalOf(earlyResult, early), 'wrong-state');
  assert.equal(versionsOf(earlyResult)[0].state, 'guard-checked');
});

test('F6 release without an approval is refused no-approval, at awaiting-decision and after a reject', () => {
  const f = fixture();
  const chain = toAwaiting(f, f.kit, [f.kit.typed]);
  const bare = release(f, 'C', chain, [chain.submit]);
  const bareResult = foldAll(f, [bare]);
  assert.equal(refusalOf(bareResult, bare), 'no-approval');
  assert.equal(versionsOf(bareResult)[0].state, 'awaiting-decision');

  const g = fixture();
  const gc = toAwaiting(g, g.kit, [g.kit.typed]);
  const reject = decide(g, 'C', 'reject', gc, [gc.submit]);
  const after = release(g, 'D', gc, [reject], [reject]);
  const result = foldAll(g, [reject, after]);
  assert.equal(refusalOf(result, after), 'no-approval');
  assert.equal(versionsOf(result)[0].state, 'rejected');
});

test('F7 an approval of v1 never counts toward the release of v2, and a decision naming a hash the product does not have is refused stale-version', () => {
  const f = fixture();
  const { one, two } = twoVersions(f);
  const approveOne = decide(f, 'C', 'approve', one, [one.submit]);
  const releaseTwo = release(f, 'D', two, [approveOne, two.submit], [approveOne]);
  const unknown = f.act('D', PERSON, 'version.decide', { product: PRODUCT, hash: OTHER_HASH, outcome: 'approve', reasons: [], decisionsSeen: [] }, [two.submit]);
  const result = foldAll(f, [approveOne, releaseTwo, unknown]);
  assert.deepEqual(versionsOf(result).map((view) => [view.number, view.state]), [[1, 'approved'], [2, 'awaiting-decision']]);
  assert.equal(refusalOf(result, releaseTwo), 'no-approval');
  assert.equal(refusalOf(result, unknown), 'stale-version');
  assert.deepEqual(versionsOf(result)[1].decision.effective, []);
});

test('F8 a proposal of text that never was in the document is still refused text-not-in-document when decisions exist on an earlier version', () => {
  const f = fixture();
  const chain = toAwaiting(f, f.kit, [f.kit.typed]);
  const approve = decide(f, 'C', 'approve', chain, [chain.submit]);
  const forged = f.propose(f.kit, 'P', OWNER, [approve], { text: 'The enemy has surrendered' });
  const result = foldAll(f, [approve, forged]);
  assert.deepEqual(result.refused, [{ hash: forged.hash, reason: 'text-not-in-document', family: 'versions' }]);
  assert.deepEqual(versionsOf(result).map((view) => [view.number, view.state]), [[1, 'approved']]);
});

test('F9 a decision whose role was removed concurrently stays pending-confirmation and never moves the state, for an approve and for a reject', () => {
  for (const outcome of ['approve', 'reject'] as const) {
    const f = fixture();
    const chain = toAwaiting(f, f.kit, [f.kit.typed]);
    const removal = f.world.write('LEAD', { kind: 'member.update', stream: ROSTER_STREAM, data: { member: 'mbr-c', name: 'Removed Role', rosterPrev: f.world.rosterHash } });
    const first = { ...f.world.rosterSpec.rosters[0], checkpointSigners: [f.hub.writer] };
    const second = { ...first, hash: removal.hash, members: first.members.map((entry) => (entry.member === 'mbr-c' ? { ...entry, roles: ['member'] } : entry)) };
    const ctx = f.world.ctx({ roster: staticRosterView({ rosters: [first, second] }) });
    const pending = decide(f, 'C', outcome, chain, [chain.submit]);
    const result = foldAll(f, [pending, removal], ctx);
    const view = versionsOf(result)[0];
    assert.deepEqual([view.state, view.overlay, view.decision.status, view.decision.pending, view.decision.effective], ['awaiting-decision', 'pending-confirmation', 'none', [pending.hash], []]);
    assert.equal(productOf(result).records[0].release.approval, undefined);
    assert.equal(productOf(result).records[0].release.rejection, undefined);
    assert.deepEqual(productOf(result).refusals, []);
  }
});
