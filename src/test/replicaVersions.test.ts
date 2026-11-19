// Products and versions on the replica layer (plan 30-08): a proposal must pin text that was really in the document (15.4 forbidden act "proposal of
// text never in the document"), numbering and "changes since" are fold outputs, and the gate chain up to awaiting-decision runs per version through
// release.ts (15.4 rows 1 to 5). Tests pass the reducer list explicitly; plan 30-12 registers versionsReducer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalBytes } from '../domain/team/canonical';
import { docText, snapshotOf } from '../domain/replica/doc';
import { sealBlob } from '../domain/replica/entry';
import type { Actor } from '../domain/replica/entry';
import { foldEntries } from '../domain/replica/fold';
import type { FoldResult } from '../domain/replica/fold';
import { validateData } from '../domain/replica/kinds';
import { OWNER_PROMPT_THRESHOLD, replicaVersionHash, versionsReducer } from '../domain/replica/versions';
import type { Pin, ProductVersions, VersionView } from '../domain/replica/versions';
import { textReducer } from '../domain/replica/textFold';
import { createWorld, permutations, rng, shuffled } from './helpers/replicaWorld';
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
      { member: 'mbr-lead', roles: ['member', 'staff_lead'], devices: ['LEAD'] },
      { member: 'mbr-dep', roles: ['member', 'deputy_lead'], devices: ['DEP'] },
      { member: 'mbr-p', roles: ['member', 'answers_for:j2'], devices: ['P'] },
      { member: 'mbr-sl', roles: ['member', 'section_lead:j2'], devices: ['SL'] },
      { member: 'mbr-q', roles: ['member', 'answers_for:j3'], devices: ['Q'] },
      { member: 'mbr-x', roles: ['member'], devices: ['X'] }
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
