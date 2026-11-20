// Products and versions on the replica layer (plan 30-08): a proposal must pin text that was really in the document (15.4 forbidden act "proposal of
// text never in the document"), numbering and "changes since" are fold outputs, and the gate chain up to awaiting-decision runs per version through
// release.ts (15.4 rows 1 to 5). Tests pass the reducer list explicitly; plan 30-12 registers versionsReducer.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { canonicalBytes } from '../domain/team/canonical';
import { docText, snapshotOf } from '../domain/replica/doc';
import { sealBlob } from '../domain/replica/entry';
import { MAX_STATE_BYTES } from '../domain/replica/kindSchemas/doc';
import * as stateKeys from '../domain/state/keys';
import type { Actor } from '../domain/replica/entry';
import { addEntries, createFoldState, foldEntries } from '../domain/replica/fold';
import type { FoldResult } from '../domain/replica/fold';
import { validateData } from '../domain/replica/kinds';
import { MAX_ACTS_PER_WRITER_VERSION, MAX_PROPOSALS_PER_WRITER_PRODUCT, OWNER_PROMPT_THRESHOLD, replicaVersionHash, versionsReducer } from '../domain/replica/versions';
import type { Pin, ProductVersions, VersionsState, VersionView } from '../domain/replica/versions';
import type { AnyReducer } from '../domain/replica/reducers';
import { textReducer } from '../domain/replica/textFold';
import { createWorld, permutations, rng, shuffled, streamId } from './helpers/replicaWorld';
import type { Editor, Written, World } from './helpers/replicaWorld';
import type { ReplicaContext } from '../domain/replica/rosterView';
import type { SealedEntry } from '../domain/replica/entry';

const PRODUCT = 'intel-estimate';
const REDUCERS = [textReducer, versionsReducer];
const OWNER: Actor = { kind: 'agent', member: 'j2-chief', run: 'r-1' };
const GUARD: Actor = { kind: 'agent', member: 'release-guard', run: 'r-g' };
const TRADECRAFT: Actor = { kind: 'agent', member: 'tradecraft', run: 'r-t' };
const SECTION_LEAD_AGENT: Actor = { kind: 'agent', member: 'j2-lead', run: 'r-l' };
const OTHER_HASH = 'a'.repeat(64);

interface Fixture {
  world: World;
  editor: Editor;
  create: Written;
  reg: Written;
  // The first text update, written by the person on device P.
  typed: Written;
  textNow(): string;
  snapNow(): Uint8Array;
  // A proposal of the text the document has now, with the snapshot of now.
  propose(writer: string, actor: Actor, deps: readonly Written[], options?: { pins?: Pin[]; product?: string; text?: string; snapshot?: Uint8Array; hash?: string; header?: Record<string, unknown> }): Written;
  act(writer: string, actor: Actor, kind: string, data: Record<string, unknown>, deps: readonly Written[]): Written;
  fold(entries?: readonly SealedEntry[], ctx?: ReplicaContext): FoldResult;
}

function fixture(options: { tradecraft?: boolean } = {}): Fixture {
  const world = createWorld({
    members: [
      { member: 'mbr-lead', roles: ['member', 'staff_lead'], devices: ['LEAD'], agentSeats: ['j2-chief'] },
      { member: 'mbr-dep', roles: ['member', 'deputy_lead'], devices: ['DEP'] },
      { member: 'mbr-p', roles: ['member', 'answers_for:j2'], devices: ['P'], agentSeats: ['j2-chief', 'j2-chief-2', 'j2-lead', 'some-other-agent', 'release-guard'] },
      { member: 'mbr-sl', roles: ['member', 'section_lead:j2'], devices: ['SL'], agentSeats: ['j2-chief', 'j2-lead', 'release-guard', 'tradecraft'] },
      { member: 'mbr-q', roles: ['member', 'answers_for:j3'], devices: ['Q'], agentSeats: ['j2-chief'] },
      { member: 'mbr-x', roles: ['member'], devices: ['X'], agentSeats: ['j2-chief'] }
    ]
  });
  const roles = options.tradecraft === false
    ? { owner: 'j2-chief', sectionLead: 'j2-lead', releaseGuard: 'release-guard' }
    : { owner: 'j2-chief', sectionLead: 'j2-lead', releaseGuard: 'release-guard', tradecraftReviewer: 'tradecraft' };
  const create = world.write('LEAD', { kind: 'product.create', data: { product: PRODUCT, section: 'j2', roles, title: 'Intel estimate' } });
  const editor = world.editor('P', PRODUCT, 101);
  const reg = editor.register({ deps: [create] });
  const typed = editor.insert(0, 'Hello world', { deps: [reg] });
  const blobOf = (text: string, header: Record<string, unknown>): string => {
    const blob = sealBlob(world.keyFor(world.stream, 0), world.stream, 0, canonicalBytes({ text, header }));
    world.blobs.set(blob.hash, blob);
    return blob.hash;
  };
  const fixtureValue: Fixture = {
    world, editor, create, reg, typed,
    textNow: () => docText(editor.doc),
    snapNow: () => snapshotOf(editor.doc),
    propose(writer, actor, deps, extra = {}) {
      const text = extra.text ?? docText(editor.doc);
      const pins = extra.pins ?? [];
      const data = {
        product: extra.product ?? PRODUCT,
        hash: extra.hash ?? replicaVersionHash(text, pins),
        textBlob: blobOf(text, extra.header ?? { title: 'Intel estimate' }),
        snapshot: Buffer.from(extra.snapshot ?? snapshotOf(editor.doc)).toString('base64url'),
        pins
      };
      return world.write(writer, { kind: 'version.propose', data, actor, deps });
    },
    act: (writer, actor, kind, data, deps) => world.write(writer, { kind, data, actor, deps }),
    fold: (entries = world.entries, ctx = world.ctx()) => foldEntries(entries, ctx, { reducers: REDUCERS })
  };
  return fixtureValue;
}

const productsOf = (result: FoldResult): ProductVersions[] => result.families.versions as ProductVersions[];
const versionsOf = (result: FoldResult, product = PRODUCT): VersionView[] => productsOf(result).find((entry) => entry.product === product)?.versions ?? [];
const refusalsOf = (result: FoldResult): string[] => result.refused.map((refused) => refused.reason).sort();
const gateRefusals = (result: FoldResult): Array<[string, string]> => productsOf(result)[0].refusals.map((refusal): [string, string] => [refusal.entry, refusal.reason]);
const verdict = (product: string, hash: string, gate: 'guard' | 'tradecraft', word: string, reasons: string[] = []): Record<string, unknown> => ({ product, hash, gate, verdict: word, reasons });

// ---- Task 1: the tracer -------------------------------------------------------------------------------------------------------------------------

test('the owner agent on a person\'s device proposes v1 of a co-edited product, and the fold shows it as version 1 in draft with the pinned hash', () => {
  const f = fixture();
  const proposal = f.propose('P', OWNER, [f.typed]);
  const result = f.fold();
  assert.deepEqual([result.held, result.rejected, result.refused, result.kept], [[], [], [], []]);
  assert.ok(result.applied.includes(proposal.hash));
  const [version] = versionsOf(result);
  assert.equal(version.number, 1);
  assert.equal(version.state, 'draft');
  assert.equal(version.hash, replicaVersionHash('Hello world', []));
  assert.equal(version.entry, proposal.hash);
  assert.deepEqual(version.pins, []);
  assert.deepEqual(version.header, { title: 'Intel estimate' });
  assert.equal(replicaVersionHash('a\r\nb', []), replicaVersionHash('a\nb', []));
  assert.notEqual(replicaVersionHash('a', []), replicaVersionHash('a', [{ product: 'other', hash: OTHER_HASH }]));
});

test('F8: a proposal of text that never was in the document, with a correct hash and a real snapshot, is refused text-not-in-document', () => {
  const f = fixture();
  const good = f.propose('P', OWNER, [f.typed]);
  const forged = f.propose('P', OWNER, [good], { text: 'Hello world, and the enemy has surrendered' });
  const result = f.fold();
  assert.deepEqual(result.refused, [{ hash: forged.hash, reason: 'text-not-in-document', family: 'versions' }]);
  assert.deepEqual(versionsOf(result).map((version) => version.number), [1]);
  assert.equal(versionsOf(result)[0].hash, replicaVersionHash('Hello world', []));
});

// ---- Task 2: authority, held and refused proposals ----------------------------------------------------------------------------------------------

test('G1: the owner agent on an answering person\'s device, an answering person and the section lead can each propose', () => {
  const f = fixture();
  const v1 = f.propose('P', OWNER, [f.typed]);
  const more = f.editor.insert(11, '!', { deps: [v1] });
  const v2 = f.propose('P', { kind: 'person' }, [more]);
  const more2 = f.editor.insert(12, '?', { deps: [v2] });
  const v3 = f.propose('SL', { kind: 'person' }, [more2]);
  const result = f.fold();
  assert.deepEqual([result.refused, result.held], [[], []]);
  assert.deepEqual(versionsOf(result).map((version) => [version.number, version.entry]), [[1, v1.hash], [2, v2.hash], [3, v3.hash]]);
});

test('G1: a person of another section, an agent that is not the owner seat, and the owner seat on a device of someone who does not answer are refused not-owner', () => {
  const f = fixture();
  f.propose('Q', { kind: 'person' }, [f.typed]);
  f.propose('P', { kind: 'agent', member: 'some-other-agent', run: 'r-9' }, [f.typed]);
  f.propose('Q', OWNER, [f.typed]);
  f.propose('X', OWNER, [f.typed]);
  f.propose('P', SECTION_LEAD_AGENT, [f.typed]);
  const result = f.fold();
  assert.deepEqual(refusalsOf(result), ['not-owner', 'not-owner', 'not-owner', 'not-owner', 'not-owner']);
  assert.deepEqual(versionsOf(result), []);
});

test('G1: a missing blob is held missing-blob, a snapshot naming updates not in the set is held updates-missing, an unknown product is held product-unknown, and a wrong hash is refused hash-mismatch', () => {
  const f = fixture();
  const noBlob = f.propose('P', OWNER, [f.typed]);
  const blobless = f.world.ctx({ blobs: () => undefined });
  const heldBlob = f.fold([...f.world.entries], blobless);
  assert.deepEqual(heldBlob.held.filter((entry) => entry.hash === noBlob.hash).map((entry) => entry.reason), ['missing-blob']);
  assert.deepEqual(versionsOf(heldBlob), []);

  // A snapshot taken over an update the fold is never given: SL writes without a dep on it.
  const hidden = f.editor.insert(11, ' (hidden)', { deps: [f.typed] });
  const gap = f.propose('SL', { kind: 'person' }, [f.create], { text: f.textNow() });
  const ghost = f.propose('SL', { kind: 'person' }, [], { product: 'ghost' });
  const wrong = f.propose('SL', { kind: 'person' }, [f.create], { text: f.textNow(), hash: OTHER_HASH });
  const withoutHidden = f.world.entries.filter((entry) => entry !== hidden.entry);
  const result = f.fold(withoutHidden);
  const reasonOf = (written: Written): string | undefined => result.held.find((entry) => entry.hash === written.hash)?.reason;
  assert.equal(reasonOf(gap), 'updates-missing');
  assert.equal(reasonOf(ghost), 'product-unknown');
  assert.deepEqual(result.refused.filter((entry) => entry.hash === wrong.hash).map((entry) => entry.reason), ['hash-mismatch']);
  assert.deepEqual(versionsOf(result).map((version) => version.entry), [noBlob.hash]);
});

test('D-34: after a delete-only edit the post-delete text with the post-delete snapshot is accepted, and with the pre-delete snapshot is refused text-not-in-document', () => {
  const f = fixture();
  const filled = f.editor.insert(6, 'brave ', { deps: [f.typed] });
  const before = f.snapNow();
  const removed = f.editor.remove(6, 6, { deps: [filled] });
  const after = f.snapNow();
  assert.equal(f.textNow(), 'Hello world');
  assert.notDeepEqual(Buffer.from(before), Buffer.from(after));
  const stale = f.propose('P', OWNER, [removed], { snapshot: before, pins: [{ product: 'other', hash: OTHER_HASH }] });
  const fresh = f.propose('P', OWNER, [stale], { snapshot: after });
  const result = f.fold();
  assert.deepEqual(result.refused, [{ hash: stale.hash, reason: 'text-not-in-document', family: 'versions' }]);
  assert.deepEqual(versionsOf(result).map((version) => [version.number, version.entry]), [[1, fresh.hash]]);
});

test('N1: three sequential proposals are numbered 1, 2 and 3 in fold order', () => {
  const f = fixture();
  const v1 = f.propose('P', OWNER, [f.typed]);
  const e1 = f.editor.insert(11, '1', { deps: [v1] });
  const v2 = f.propose('P', OWNER, [e1]);
  const e2 = f.editor.insert(12, '2', { deps: [v2] });
  const v3 = f.propose('P', OWNER, [e2]);
  const result = f.fold();
  assert.deepEqual(versionsOf(result).map((version) => [version.number, version.entry, version.proposedAtSameTimeAs]), [[1, v1.hash, []], [2, v2.hash, []], [3, v3.hash, []]]);
});

test('N2: two concurrent proposals are both kept and numbered consecutively, the later is marked proposedAtSameTimeAs the earlier, in both delivery orders', () => {
  const f = fixture();
  const a = f.propose('P', OWNER, [f.typed]);
  const b = f.propose('SL', { kind: 'person' }, [f.typed], { pins: [{ product: 'other', hash: OTHER_HASH }] });
  const forward = f.fold([...f.world.entries]);
  const backward = f.fold([...f.world.entries].reverse());
  assert.deepEqual(forward.refused, []);
  const views = versionsOf(forward);
  assert.deepEqual(views.map((version) => version.number), [1, 2]);
  assert.deepEqual(new Set(views.map((version) => version.entry)), new Set([a.hash, b.hash]));
  assert.deepEqual(views.map((version) => version.proposedAtSameTimeAs), [[], [1]]);
  assert.deepEqual(versionsOf(backward), views);
  assert.deepEqual(backward.digests, forward.digests);
});

test('G4: a new proposal with the same hash as the current version is refused no-change', () => {
  const f = fixture();
  const v1 = f.propose('P', OWNER, [f.typed]);
  const again = f.propose('P', OWNER, [v1]);
  const result = f.fold();
  assert.deepEqual(result.refused, [{ hash: again.hash, reason: 'no-change', family: 'versions' }]);
  assert.equal(versionsOf(result).length, 1);
});

test('N3: edits after a proposal never change that version, and changesSince grows by one per accepted update not in its causal past', () => {
  const f = fixture();
  const v1 = f.propose('P', OWNER, [f.typed]);
  const first = f.fold();
  const reference = versionsOf(first)[0];
  assert.deepEqual([reference.changesSince, reference.othersChangesSince], [0, 0]);
  const x = f.world.editor('X', PRODUCT, 303);
  const xr = x.register({ deps: [v1] });
  let last: Written = xr;
  const seen: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    last = x.insert(0, `x${index}`, { deps: [last] });
    const view = versionsOf(f.fold())[0];
    seen.push(view.changesSince);
    assert.equal(view.hash, reference.hash);
    assert.deepEqual(view.header, reference.header);
    assert.equal(view.entry, v1.hash);
  }
  assert.deepEqual(seen, [1, 2, 3]);
  // An update that came before the proposal does not count: only the three after it.
  assert.equal(versionsOf(f.fold())[0].othersChangesSince, 3);
});

test('N4: the owner prompt is due at 20 updates from writers other than the owner side, not at 19, never counts the owner side\'s own edits, and withdraws nothing', () => {
  assert.equal(OWNER_PROMPT_THRESHOLD, 20);
  const f = fixture();
  const v1 = f.propose('P', OWNER, [f.typed]);
  const x = f.world.editor('X', PRODUCT, 303);
  let last: Written = x.register({ deps: [v1] });
  for (let index = 0; index < 19; index += 1) last = x.insert(0, 'x', { deps: [last] });
  const nineteen = versionsOf(f.fold())[0];
  assert.deepEqual([nineteen.othersChangesSince, nineteen.ownerPromptDue], [19, false]);
  last = x.insert(0, 'x', { deps: [last] });
  const twenty = versionsOf(f.fold())[0];
  assert.deepEqual([twenty.othersChangesSince, twenty.ownerPromptDue], [20, true]);
  // The owner side keeps editing: those updates count as changes since, and not as other writers' changes.
  const own1 = f.editor.insert(0, 'p', { deps: [v1] });
  f.editor.insert(0, 'q', { deps: [own1] });
  const result = f.fold();
  const view = versionsOf(result)[0];
  assert.deepEqual([view.changesSince, view.othersChangesSince, view.ownerPromptDue], [22, 20, true]);
  assert.equal(view.state, 'draft');
  assert.equal(result.applied.some((hash) => hash === last.hash), true);
  assert.equal(productsOf(result)[0].records[0].acts.length, 0);
});

test('product.create needs a section lead of that section, the staff lead or the deputy lead; a second create is refused product-exists', () => {
  const f = fixture();
  const create = (writer: string, product: string, section: string, actor: Actor = { kind: 'person' }): Written =>
    f.world.write(writer, { kind: 'product.create', actor, data: { product, section, roles: { owner: 'j2-chief', sectionLead: 'j2-lead', releaseGuard: 'release-guard' }, title: 'T' } });
  create('X', 'made-by-x', 'j2');
  create('P', 'made-by-p', 'j2');
  create('SL', 'made-by-sl-j3', 'j3');
  create('LEAD', 'made-by-agent', 'j2', OWNER);
  create('LEAD', PRODUCT, 'j2');
  const okSl = create('SL', 'made-by-sl', 'j2');
  const okDep = create('DEP', 'made-by-dep', 'j2');
  const result = f.fold();
  assert.deepEqual(refusalsOf(result), ['not-authorised', 'not-authorised', 'not-authorised', 'not-authorised', 'product-exists']);
  assert.ok(result.applied.includes(okSl.hash) && result.applied.includes(okDep.hash));
  assert.deepEqual(productsOf(result).map((entry) => entry.product), ['intel-estimate', 'made-by-dep', 'made-by-sl']);
});

test('product.owner by the section lead or staff lead changes the owner seat for later proposals; anyone else is refused not-authorised; the owner cannot become the guard', () => {
  const f = fixture();
  const byX = f.world.write('X', { kind: 'product.owner', data: { product: PRODUCT, owner: 'j2-chief-2' }, deps: [f.create] });
  const bad = f.world.write('SL', { kind: 'product.owner', data: { product: PRODUCT, owner: 'release-guard' }, deps: [f.create] });
  const changed = f.world.write('SL', { kind: 'product.owner', data: { product: PRODUCT, owner: 'j2-chief-2' }, deps: [f.typed] });
  const oldSeat = f.propose('P', OWNER, [changed]);
  const newSeat = f.propose('P', { kind: 'agent', member: 'j2-chief-2', run: 'r-2' }, [changed]);
  const result = f.fold();
  const reasons = Object.fromEntries(result.refused.map((entry) => [entry.hash, entry.reason]));
  assert.equal(reasons[byX.hash], 'not-authorised');
  assert.equal(reasons[bad.hash], 'bad-roles');
  assert.equal(reasons[oldSeat.hash], 'not-owner');
  assert.equal(result.applied.includes(newSeat.hash), true);
  assert.equal(productsOf(result)[0].roles.owner, 'j2-chief-2');
  assert.deepEqual(versionsOf(result).map((version) => version.entry), [newSeat.hash]);
});

test('the version data shapes are closed and bounded', () => {
  const hash = 'b'.repeat(64);
  const snapshot = Buffer.from([0, 0]).toString('base64url');
  const roles = { owner: 'j2-chief', sectionLead: 'j2-lead', releaseGuard: 'release-guard' };
  const valid: Array<[string, unknown]> = [
    ['product.create', { product: PRODUCT, section: 'j2', roles: { ...roles, tradecraftReviewer: 'tradecraft' }, title: 'T' }],
    ['product.owner', { product: PRODUCT, owner: 'j2-chief-2' }],
    ['version.propose', { product: PRODUCT, hash, textBlob: hash, snapshot, pins: [{ product: 'other', hash }] }],
    ['version.verdict', { product: PRODUCT, hash, gate: 'guard', verdict: 'HOLD', reasons: ['no source'] }],
    ['version.verdict', { product: PRODUCT, hash, gate: 'tradecraft', verdict: 'SIGN-OFF', reasons: [] }],
    ['version.submit', { product: PRODUCT, hash, decisionFor: 'commander' }],
    ['version.withdraw', { product: PRODUCT, hash, reason: 'obsolete', decisionsSeen: [hash] }],
    ['version.decide', { product: PRODUCT, hash, outcome: 'approve', reasons: [], decisionsSeen: [] }],
    ['version.release', { product: PRODUCT, hash, decisionsSeen: [] }],
    ['version.supersede', { product: PRODUCT, hash, byHash: hash }]
  ];
  for (const [kind, data] of valid) assert.deepEqual(validateData(kind, data), { ok: true }, kind);
  const bad = (kind: string, data: unknown): boolean => !validateData(kind, data).ok;
  assert.ok(bad('product.create', { product: PRODUCT, section: 'j2', roles, title: 'T', extra: 1 }));
  assert.ok(bad('product.create', { product: PRODUCT, section: 'not-a-section', roles, title: 'T' }));
  assert.ok(bad('product.create', { product: PRODUCT, section: 'j2', roles: { ...roles, releaseGuard: 'j2-chief' }, title: 'T' }));
  assert.ok(bad('product.create', { product: PRODUCT, section: 'j2', roles: { ...roles, tradecraftReviewer: 'release-guard' }, title: 'T' }));
  assert.ok(bad('version.propose', { product: PRODUCT, hash, textBlob: hash, snapshot: 'not base64url!', pins: [] }));
  assert.ok(bad('version.propose', { product: PRODUCT, hash, textBlob: hash, snapshot, pins: Array.from({ length: 33 }, () => ({ product: 'other', hash })) }));
  assert.ok(bad('version.verdict', { product: PRODUCT, hash, gate: 'guard', verdict: 'SIGN-OFF', reasons: [] }));
  assert.ok(bad('version.decide', { product: PRODUCT, hash, outcome: 'approve', reasons: [], decisionsSeen: Array.from({ length: 65 }, () => hash) }));
  assert.ok(bad('version.submit', { product: PRODUCT, hash, decisionFor: 'Not A Slug' }));
  assert.ok(bad('version.supersede', { product: PRODUCT, hash }));
  assert.ok(bad('version.propose', 'text'));
});

// ---- Task 3: the gate chain per version ---------------------------------------------------------------------------------------------------------

test('G2: a guard HOLD or a tradecraft NOT READY with reasons holds the version; no reasons, a non-guard agent and another hash are refused', () => {
  const f = fixture();
  const v1 = f.propose('P', OWNER, [f.typed]);
  const hash = replicaVersionHash('Hello world', []);
  f.act('P', GUARD, 'version.verdict', verdict(PRODUCT, hash, 'guard', 'HOLD', ['no source for the figure']), [v1]);
  const held = versionsOf(f.fold())[0];
  assert.deepEqual([held.state, held.held], ['draft', { gate: 'guard', reasons: ['no source for the figure'] }]);

  const g = fixture();
  const w1 = g.propose('P', OWNER, [g.typed]);
  g.act('SL', TRADECRAFT, 'version.verdict', verdict(PRODUCT, hash, 'tradecraft', 'NOT READY', ['assessment not sourced']), [w1]);
  assert.deepEqual(versionsOf(g.fold())[0].held, { gate: 'tradecraft', reasons: ['assessment not sourced'] });

  const h = fixture();
  const x1 = h.propose('P', OWNER, [h.typed]);
  const noReasons = h.act('P', GUARD, 'version.verdict', verdict(PRODUCT, hash, 'guard', 'HOLD', []), [x1]);
  const notGuard = h.act('SL', SECTION_LEAD_AGENT, 'version.verdict', verdict(PRODUCT, hash, 'guard', 'CLEARED'), [x1]);
  const stale = h.act('SL', GUARD, 'version.verdict', verdict(PRODUCT, OTHER_HASH, 'guard', 'HOLD', ['x']), [x1]);
  const result = h.fold();
  assert.equal(versionsOf(result)[0].held, undefined);
  assert.deepEqual(gateRefusals(result).sort(), ([[noReasons.hash, 'reasons-required'], [notGuard.hash, 'not-gate-member'], [stale.hash, 'stale-version']] as Array<[string, string]>).sort());
});

test('G3: a guard CLEARED moves a version to guard-checked; with a tradecraft reviewer, CLEARED before SIGN-OFF is refused tradecraft-required and after it is accepted', () => {
  const plain = fixture({ tradecraft: false });
  const p1 = plain.propose('P', OWNER, [plain.typed]);
  const hash = replicaVersionHash('Hello world', []);
  plain.act('P', GUARD, 'version.verdict', verdict(PRODUCT, hash, 'guard', 'CLEARED'), [p1]);
  assert.equal(versionsOf(plain.fold())[0].state, 'guard-checked');

  const f = fixture();
  const v1 = f.propose('P', OWNER, [f.typed]);
  const early = f.act('P', GUARD, 'version.verdict', verdict(PRODUCT, hash, 'guard', 'CLEARED'), [v1]);
  const refusedFirst = f.fold();
  assert.equal(versionsOf(refusedFirst)[0].state, 'draft');
  assert.deepEqual(gateRefusals(refusedFirst), [[early.hash, 'tradecraft-required']]);
  const signOff = f.act('SL', TRADECRAFT, 'version.verdict', verdict(PRODUCT, hash, 'tradecraft', 'SIGN-OFF'), [v1]);
  f.act('P', GUARD, 'version.verdict', verdict(PRODUCT, hash, 'guard', 'CLEARED'), [signOff]);
  const accepted = f.fold();
  assert.equal(versionsOf(accepted)[0].state, 'guard-checked');
  assert.deepEqual(gateRefusals(accepted), [[early.hash, 'tradecraft-required']]);
});

test('G4: after a HOLD the owner proposes v2 with a new hash; v1 stays held and v2 is proposed', () => {
  const f = fixture();
  const v1 = f.propose('P', OWNER, [f.typed]);
  const hash = replicaVersionHash('Hello world', []);
  const hold = f.act('P', GUARD, 'version.verdict', verdict(PRODUCT, hash, 'guard', 'HOLD', ['fix the header']), [v1]);
  const edit = f.editor.insert(11, ' again', { deps: [hold] });
  const v2 = f.propose('P', OWNER, [edit]);
  const views = versionsOf(f.fold());
  assert.deepEqual(views.map((version) => [version.number, version.state, version.held?.gate ?? null, version.entry]), [[1, 'draft', 'guard', v1.hash], [2, 'draft', null, v2.hash]]);
});

test('G5: version.submit naming a decision role moves a guard-checked version to awaiting-decision; a submit on a version that is not guard-checked is refused wrong-state', () => {
  const f = fixture({ tradecraft: false });
  const v1 = f.propose('P', OWNER, [f.typed]);
  const hash = replicaVersionHash('Hello world', []);
  const tooSoon = f.act('P', OWNER, 'version.submit', { product: PRODUCT, hash, decisionFor: 'commander' }, [v1]);
  const cleared = f.act('P', GUARD, 'version.verdict', verdict(PRODUCT, hash, 'guard', 'CLEARED'), [tooSoon]);
  const stranger = f.act('Q', { kind: 'person' }, 'version.submit', { product: PRODUCT, hash, decisionFor: 'commander' }, [cleared]);
  f.act('P', OWNER, 'version.submit', { product: PRODUCT, hash, decisionFor: 'commander' }, [cleared]);
  const result = f.fold();
  const view = versionsOf(result)[0];
  assert.deepEqual([view.state, view.decisionFor], ['awaiting-decision', 'commander']);
  assert.deepEqual(gateRefusals(result).sort(), ([[tooSoon.hash, 'wrong-state'], [stranger.hash, 'not-owner-or-lead']] as Array<[string, string]>).sort());

  // The owner side's person can submit too: a person who answers for the section is presented to the machine as the owner seat.
  const g = fixture({ tradecraft: false });
  const w1 = g.propose('P', OWNER, [g.typed]);
  const c = g.act('P', GUARD, 'version.verdict', verdict(PRODUCT, hash, 'guard', 'CLEARED'), [w1]);
  g.act('SL', { kind: 'person' }, 'version.submit', { product: PRODUCT, hash, decisionFor: 'commander' }, [c]);
  assert.equal(versionsOf(g.fold())[0].state, 'awaiting-decision');
});

test('D-37: concurrent HOLD and CLEARED leave a version held in every delivery order, until a fresh CLEARED that saw both', () => {
  const f = fixture({ tradecraft: false });
  const v1 = f.propose('P', OWNER, [f.typed]);
  const hash = replicaVersionHash('Hello world', []);
  f.act('P', GUARD, 'version.verdict', verdict(PRODUCT, hash, 'guard', 'HOLD', ['figure unsourced']), [v1]);
  const cleared = f.act('SL', GUARD, 'version.verdict', verdict(PRODUCT, hash, 'guard', 'CLEARED'), [v1]);
  const random = rng(30_08);
  const orders = [[...f.world.entries], [...f.world.entries].reverse(), ...Array.from({ length: 12 }, () => shuffled(f.world.entries, random))];
  const reference = f.fold(orders[0]);
  for (const order of orders) {
    const result = f.fold(order);
    assert.deepEqual(versionsOf(result), versionsOf(reference));
    assert.deepEqual(result.digests, reference.digests);
  }
  const view = versionsOf(reference)[0];
  assert.deepEqual([view.state, view.held?.gate, view.verdictConflict], ['draft', 'guard', true]);

  f.act('P', GUARD, 'version.verdict', verdict(PRODUCT, hash, 'guard', 'CLEARED'), [cleared]);
  const settled = versionsOf(f.fold())[0];
  assert.deepEqual([settled.state, settled.held, settled.verdictConflict], ['guard-checked', undefined, undefined]);
});

test('every one of the 24 delivery orders of propose, SIGN-OFF, CLEARED and submit gives the same versions and the same digest', () => {
  const f = fixture();
  const hash = replicaVersionHash('Hello world', []);
  const base = [...f.world.entries];
  const v1 = f.propose('P', OWNER, [f.typed]);
  const signOff = f.act('SL', TRADECRAFT, 'version.verdict', verdict(PRODUCT, hash, 'tradecraft', 'SIGN-OFF'), [v1]);
  const cleared = f.act('P', GUARD, 'version.verdict', verdict(PRODUCT, hash, 'guard', 'CLEARED'), [signOff]);
  const submit = f.act('SL', OWNER, 'version.submit', { product: PRODUCT, hash, decisionFor: 'commander' }, [cleared]);
  const reference = f.fold();
  const view = versionsOf(reference)[0];
  assert.deepEqual([view.state, view.decisionFor], ['awaiting-decision', 'commander']);
  assert.deepEqual(reference.refused, []);
  for (const order of permutations([v1.entry, signOff.entry, cleared.entry, submit.entry])) {
    const result = f.fold([...base, ...order]);
    assert.deepEqual(versionsOf(result), versionsOf(reference));
    assert.deepEqual(result.digests, reference.digests);
  }
});

test('release.ts and its tests are not part of this change: the gate steps all run through transition()', () => {
  // The module under test imports the machine and never copies it: a gate step that release.ts refuses must be refused here with its reason.
  const f = fixture();
  const v1 = f.propose('P', OWNER, [f.typed]);
  const hash = replicaVersionHash('Hello world', []);
  const person = f.act('P', { kind: 'person' }, 'version.verdict', verdict(PRODUCT, hash, 'guard', 'CLEARED'), [v1]);
  const noGate = fixture({ tradecraft: false });
  const w1 = noGate.propose('P', OWNER, [noGate.typed]);
  const none = noGate.act('SL', TRADECRAFT, 'version.verdict', verdict(PRODUCT, hash, 'tradecraft', 'SIGN-OFF'), [w1]);
  assert.deepEqual(gateRefusals(f.fold()), [[person.hash, 'not-gate-member']]);
  assert.deepEqual(gateRefusals(noGate.fold()), [[none.hash, 'no-tradecraft-gate']]);
});

// ---- Plan 30-12: no output depends on a global position -------------------------------------------------------------------------------------------

test('regression: an unrelated stream changes no recorded act position, because positions count only the product\'s own stream', () => {
  const f = fixture();
  const v1 = f.propose('P', OWNER, [f.typed]);
  f.act('SL', TRADECRAFT, 'version.verdict', verdict(PRODUCT, replicaVersionHash('Hello world', []), 'tradecraft', 'SIGN-OFF'), [v1]);
  const before = f.fold();
  // Entries in another stream with a low lamport sort in between the product's own entries in the total order of every stream together.
  f.world.write('X', { kind: 'future.thing', data: { n: 1 }, stream: streamId('elsewhere') });
  f.world.write('Q', { kind: 'future.thing', data: { n: 2 }, stream: streamId('elsewhere') });
  const after = f.fold();
  assert.equal(after.order.length, before.order.length + 2);
  assert.deepEqual(after.families.versions, before.families.versions);
  const positions = (result: FoldResult): number[] => productsOf(result).flatMap((product) => product.records.flatMap((record) => record.acts.map((act) => act.position)));
  assert.ok(positions(before).length >= 1);
  assert.deepEqual(positions(after), positions(before));
});

// ---- plan 31-07: one inspection per proposal, proposal and act caps (WR-05 versions part, WR-06 cap) ---------------------------------------------

// The versions reducer with its working state captured at finish, to read the test-only counters.
function capturingVersions(): { reducers: AnyReducer[]; state(): VersionsState } {
  let captured: VersionsState | undefined;
  const wrapped: AnyReducer = {
    ...versionsReducer,
    finish(state, view) {
      captured = state as VersionsState;
      return versionsReducer.finish(state as VersionsState, view);
    }
  };
  return {
    reducers: [textReducer, wrapped],
    state: () => {
      assert.ok(captured !== undefined, 'the versions reducer finished');
      return captured;
    }
  };
}

// Folded whole and delivered in chunks, the result is the same; returns the whole fold.
function incrementalAgrees(f: Fixture, chunks: number): FoldResult {
  const ctx = f.world.ctx();
  const fresh = foldEntries(f.world.entries, ctx, { reducers: REDUCERS });
  let state = createFoldState(ctx, { reducers: REDUCERS });
  const size = Math.ceil(f.world.entries.length / chunks);
  for (let start = 0; start < f.world.entries.length; start += size) state = addEntries(state, f.world.entries.slice(start, start + size));
  assert.deepEqual(state.result.families, fresh.families, 'families');
  assert.deepEqual(state.result.digests, fresh.digests, 'digests');
  assert.deepEqual(state.result.refused, fresh.refused, 'refused');
  assert.deepEqual(state.result.held, fresh.held, 'held');
  return fresh;
}

test('WR-05: a proposal costs one snapshot inspection, and finishing the fold costs none, with versions and attribution as before', () => {
  const f = fixture();
  const v1 = f.propose('P', OWNER, [f.typed]);
  const more = f.editor.insert(11, '!', { deps: [v1] });
  const v2 = f.propose('P', OWNER, [more]);
  const more2 = f.editor.insert(12, '?', { deps: [v2] });
  f.propose('SL', { kind: 'person' }, [more2]);
  const capture = capturingVersions();
  const result = foldEntries(f.world.entries, f.world.ctx(), { reducers: capture.reducers });
  assert.deepEqual([result.refused, result.held], [[], []]);
  assert.deepEqual(versionsOf(result).map((version) => version.hash), ['Hello world', 'Hello world!', 'Hello world!?'].map((text) => replicaVersionHash(text, [])));
  // Every character is the person on P's device, whose registration is a person registration.
  for (const version of versionsOf(result)) assert.deepEqual(version.attribution.map((row) => [row.member, row.actor, row.characters]), [['mbr-p', 'person', version.number === 1 ? 11 : version.number === 2 ? 12 : 13]]);
  const product = capture.state().products.get(`${f.world.stream}/${PRODUCT}`);
  assert.equal(product?.snapshotReports, 3);
  assert.deepEqual(incrementalAgrees(f, 4).digests, result.digests);
});

test('WR-05: the 201st proposal by one writer on one product is refused too-many before its blob is read; another writer still proposes', () => {
  assert.equal(MAX_PROPOSALS_PER_WRITER_PRODUCT, 200);
  const f = fixture();
  const first = f.propose('P', OWNER, [f.typed]);
  // 199 more of the same text: each passes the owner check and is refused no-change, so each counts.
  let last: Written = first;
  for (let index = 1; index < MAX_PROPOSALS_PER_WRITER_PRODUCT; index += 1) last = f.propose('P', OWNER, [last]);
  const edit = f.editor.insert(11, '!', { deps: [last] });
  const over = f.propose('P', OWNER, [edit]);
  const other = f.propose('SL', { kind: 'person' }, [over]);
  const capture = capturingVersions();
  const result = foldEntries(f.world.entries, f.world.ctx(), { reducers: capture.reducers });
  const reasons = new Map(result.refused.map((item) => [item.hash, item.reason]));
  assert.equal(result.refused.length, MAX_PROPOSALS_PER_WRITER_PRODUCT);
  assert.equal([...reasons.values()].filter((reason) => reason === 'no-change').length, MAX_PROPOSALS_PER_WRITER_PRODUCT - 1);
  assert.equal(reasons.get(over.hash), 'too-many');
  assert.deepEqual(versionsOf(result).map((version) => [version.number, version.entry]), [[1, first.hash], [2, other.hash]]);
  // Only the two proposals that reached the snapshot check built a scratch document.
  const product = capture.state().products.get(`${f.world.stream}/${PRODUCT}`);
  assert.equal(product?.snapshotReports, 2);
  assert.equal(product?.proposalCounts.get(f.world.writerOf('P')), MAX_PROPOSALS_PER_WRITER_PRODUCT);
  incrementalAgrees(f, 5);
});

test('WR-05: a held proposal does not count toward the cap, and is counted once it is judged', () => {
  const f = fixture();
  const proposal = f.propose('P', OWNER, [f.typed]);
  const blobs = new Map(f.world.blobs);
  f.world.blobs.clear();
  const capture = capturingVersions();
  const heldResult = foldEntries(f.world.entries, f.world.ctx(), { reducers: capture.reducers });
  assert.deepEqual(heldResult.held.map((item) => [item.hash, item.reason]), [[proposal.hash, 'missing-blob']]);
  assert.equal(capture.state().products.get(`${f.world.stream}/${PRODUCT}`)?.proposalCounts.size, 0);
  for (const [hash, blob] of blobs) f.world.blobs.set(hash, blob);
  const later = capturingVersions();
  foldEntries(f.world.entries, f.world.ctx(), { reducers: later.reducers });
  assert.equal(later.state().products.get(`${f.world.stream}/${PRODUCT}`)?.proposalCounts.get(f.world.writerOf('P')), 1);
});

test('WR-06: the 33rd act by one writer on one version is refused too-many-acts; another writer\'s act on it still counts', () => {
  assert.equal(MAX_ACTS_PER_WRITER_VERSION, 32);
  const f = fixture({ tradecraft: false });
  const proposal = f.propose('P', OWNER, [f.typed]);
  const hash = replicaVersionHash('Hello world', []);
  let last = proposal;
  const holds: Written[] = [];
  for (let index = 0; index < MAX_ACTS_PER_WRITER_VERSION; index += 1) {
    last = f.act('P', GUARD, 'version.verdict', verdict(PRODUCT, hash, 'guard', 'HOLD', [`reason ${index}`]), [last]);
    holds.push(last);
  }
  const overCleared = f.act('P', GUARD, 'version.verdict', verdict(PRODUCT, hash, 'guard', 'CLEARED'), [last]);
  const result = foldEntries(f.world.entries, f.world.ctx(), { reducers: REDUCERS });
  assert.deepEqual(result.refused, [{ hash: overCleared.hash, reason: 'too-many-acts', family: 'versions' }]);
  assert.deepEqual([versionsOf(result)[0].state, versionsOf(result)[0].held?.reasons], ['draft', [`reason ${MAX_ACTS_PER_WRITER_VERSION - 1}`]]);
  assert.equal(productsOf(result)[0].records[0].acts.length, MAX_ACTS_PER_WRITER_VERSION);
  // The section lead's device runs the release guard too; its CLEARED, made after every HOLD, clears the version.
  const cleared = f.act('SL', GUARD, 'version.verdict', verdict(PRODUCT, hash, 'guard', 'CLEARED'), [overCleared]);
  const after = incrementalAgrees(f, 4);
  assert.deepEqual(after.refused, [{ hash: overCleared.hash, reason: 'too-many-acts', family: 'versions' }]);
  assert.equal(versionsOf(after)[0].state, 'guard-checked');
  assert.ok(after.applied.includes(cleared.hash));
  // The cap is per version: the same device's first act on another version hash is applied (and refused stale-version in finish, as before).
  const elsewhere = f.act('P', GUARD, 'version.verdict', verdict(PRODUCT, OTHER_HASH, 'guard', 'CLEARED'), [cleared]);
  const third = f.fold();
  assert.ok(third.applied.includes(elsewhere.hash));
  assert.ok(gateRefusals(third).some(([entry, reason]) => entry === elsewhere.hash && reason === 'stale-version'));
  assert.equal(holds.length, MAX_ACTS_PER_WRITER_VERSION);
});

// ---- plan 31-07: the proposal text blob is size-gated before it is opened (31-RESEARCH new defect 1) ---------------------------------------------

test('new defect 1: a proposal whose text blob is over MAX_STATE_BYTES is refused too-large without being decrypted; an honest one is opened', () => {
  const f = fixture();
  const honest = f.propose('P', OWNER, [f.typed]);
  const more = f.editor.insert(11, '!', { deps: [honest] });
  // The blob holds a correct { text, header } whose text is over the limit; the hash in the entry even matches it.
  const text = 'y'.repeat(MAX_STATE_BYTES + 1);
  const oversized = f.propose('P', OWNER, [more], { text });
  const blobs = [...f.world.blobs.values()];
  const ivs = new Map(blobs.map((blob) => [Buffer.from(blob.bytes, 'base64url').subarray(0, 12).toString('hex'), blob]));
  const opens = mock.method(stateKeys, 'openRaw');
  let result: FoldResult;
  let opened: string[];
  try {
    result = f.fold();
    opened = opens.mock.calls.map((call) => (call.arguments[1] as { iv: Buffer }).iv.toString('hex'));
  } finally {
    opens.mock.restore();
  }
  assert.deepEqual(result.refused, [{ hash: oversized.hash, reason: 'too-large', family: 'versions' }]);
  assert.deepEqual(versionsOf(result).map((version) => version.entry), [honest.hash]);
  const openedBlobs = opened.map((iv) => ivs.get(iv)).filter((blob) => blob !== undefined);
  const big = blobs.filter((blob) => blob.bytes.length > MAX_STATE_BYTES);
  assert.equal(big.length, 1);
  assert.equal(openedBlobs.includes(big[0]), false);
  // The honest proposal's text blob is opened, so the spy sees opens.
  assert.ok(openedBlobs.some((blob) => blob !== big[0] && blob.bytes.length < 1000));
});
