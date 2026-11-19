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
