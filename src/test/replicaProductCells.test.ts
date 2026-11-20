// Products in several cells (plan 32-08; D-15 to D-18, D-20, D-22 revised, D-67). The fold already keys a product and its text by (stream, product);
// what this file checks is the rules that assume more than one place: a version may pin only a product at its own label or below (pin-above-cell),
// a project.import may carry one cell's part of a ledger, and a 0.4.35 preview project (products in the base cell) can be told from a Phase 32 one.
// Fictional exercise data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalBytes } from '../domain/team/canonical';
import { docText, snapshotOf } from '../domain/replica/doc';
import { sealBlob } from '../domain/replica/entry';
import type { Actor } from '../domain/replica/entry';
import { foldEntries } from '../domain/replica/fold';
import type { FoldResult } from '../domain/replica/fold';
import { PRODUCT_CELL_REFUSALS, pinProblem } from '../domain/replica/productCells';
import type { PinCandidate } from '../domain/replica/productCells';
import { projectReducer } from '../domain/replica/projectFold';
import type { ReplicaContext } from '../domain/replica/rosterView';
import { textReducer } from '../domain/replica/textFold';
import { VERSION_REFUSALS, replicaVersionHash, versionsReducer } from '../domain/replica/versions';
import type { Pin, ProductVersions } from '../domain/replica/versions';
import { createWorld, streamId } from './helpers/replicaWorld';
import type { Editor, World, Written } from './helpers/replicaWorld';

// Two label cells: HIGH dominates LOW, LOW dominates nothing else, and every cell may cite itself.
const LOW = streamId('cell-low');
const HIGH = streamId('cell-high');
const SIDE = streamId('cell-side');
const ORDER = (citing: string, cited: string): boolean => citing === cited || (citing === HIGH && cited === LOW);
const PERSON: Actor = { kind: 'person' };
const REDUCERS = { reducers: [textReducer, projectReducer, versionsReducer] };
const OTHER_HASH = 'a'.repeat(64);

interface CellProduct { stream: string; name: string; editor: Editor; create: Written; typed: Written }

interface CellsFixture {
  world: World;
  product(stream: string, name: string, client: number, text: string): CellProduct;
  propose(product: CellProduct, deps: readonly Written[], pins?: Pin[]): Written;
  fold(ctx?: ReplicaContext): FoldResult;
  // A machine that holds every key except the given streams' (a member below those cells, D-23).
  without(...streams: string[]): ReplicaContext;
}

function cellsFixture(): CellsFixture {
  const world = createWorld({
    members: [
      { member: 'mbr-lead', roles: ['member', 'staff_lead'], devices: ['LEAD'] },
      { member: 'mbr-p', roles: ['member', 'answers_for:j2'], devices: ['P'] }
    ]
  });
  const roles = { owner: 'j2-chief', sectionLead: 'j2-lead', releaseGuard: 'release-guard' };
  const blobOf = (stream: string, text: string, header: Record<string, unknown>): string => {
    const blob = sealBlob(world.keyFor(stream, 0), stream, 0, canonicalBytes({ text, header }));
    world.blobs.set(blob.hash, blob);
    return blob.hash;
  };
  return {
    world,
    product(stream, name, client, text) {
      const create = world.write('LEAD', { kind: 'product.create', stream, data: { product: name, section: 'j2', roles, title: `Exercise ${name}` } });
      const editor = world.editor('P', name, client);
      const reg = editor.register({ deps: [create], stream });
      const typed = editor.insert(0, text, { deps: [reg], stream });
      return { stream, name, editor, create, typed };
    },
    propose(product, deps, pins = []) {
      const text = docText(product.editor.doc);
      const data = {
        product: product.name,
        hash: replicaVersionHash(text, pins),
        textBlob: blobOf(product.stream, text, { title: `Exercise ${product.name}` }),
        snapshot: Buffer.from(snapshotOf(product.editor.doc)).toString('base64url'),
        pins
      };
      return world.write('P', { kind: 'version.propose', stream: product.stream, data, actor: PERSON, deps });
    },
    fold: (ctx = world.ctx({ cellOrder: ORDER })) => foldEntries(world.entries, ctx, REDUCERS),
    without(...streams) {
      const full = world.ctx();
      return world.ctx({ cellOrder: ORDER, keys: (stream, epoch) => (streams.includes(stream) ? undefined : full.keys(stream, epoch)) });
    }
  };
}

const productsOf = (result: FoldResult): ProductVersions[] => result.families.versions as ProductVersions[];
const versionHashes = (result: FoldResult, stream: string, product: string): string[] =>
  productsOf(result).find((item) => item.stream === stream && item.product === product)?.versions.map((version) => version.hash) ?? [];

// ---- Task 1: pins follow write up, never down (D-18, D-67) ------------------------------------------------------------------------------------

test('pin-above-cell tracer: a version in the higher cell may pin the lower product, a version in the lower cell pinning the higher product is refused, and a machine without the higher key agrees', () => {
  const f = cellsFixture();
  const summary = f.product(LOW, 'summary', 201, 'Exercise summary of the northern sector.');
  const estimate = f.product(HIGH, 'estimate', 202, 'Exercise estimate for the northern sector.');
  const s1 = f.propose(summary, [summary.typed]);
  const e1 = f.propose(estimate, [estimate.typed]);
  const summaryHash = replicaVersionHash('Exercise summary of the northern sector.', []);
  const estimateHash = replicaVersionHash('Exercise estimate for the northern sector.', []);
  // Write up: the estimate's version cites the summary version it pins.
  const up = f.propose(estimate, [e1, s1], [{ product: 'summary', hash: summaryHash }]);
  // Write down through a pin: its deps stay in its own cell, so only the pin rule can catch it.
  const down = f.propose(summary, [s1], [{ product: 'estimate', hash: estimateHash }]);

  const full = f.fold();
  assert.ok(full.applied.includes(up.hash), 'the version pinning a product below its own cell is applied');
  assert.deepEqual(full.refused, [{ hash: down.hash, reason: 'pin-above-cell', family: 'versions' }]);
  assert.deepEqual(versionHashes(full, LOW, 'summary'), [summaryHash]);
  assert.deepEqual(versionHashes(full, HIGH, 'estimate'), [estimateHash, replicaVersionHash('Exercise estimate for the northern sector.', [{ product: 'summary', hash: summaryHash }])]);

  // A member below HIGH never holds its key: the estimate is unknown there, and an unknown pin counts as above, so both machines decide the same.
  const below = f.fold(f.without(HIGH));
  assert.deepEqual(below.refused, [{ hash: down.hash, reason: 'pin-above-cell', family: 'versions' }]);
  assert.deepEqual(versionHashes(below, LOW, 'summary'), [summaryHash]);
  assert.equal(below.digests[LOW], full.digests[LOW]);
  assert.equal(VERSION_REFUSALS['pin-above-cell'], PRODUCT_CELL_REFUSALS['pin-above-cell']);
});

test('pin-above-cell: with a cell order a pin to a hash no accepted version has is refused, and without one the same entries apply as in Phase 30', () => {
  const f = cellsFixture();
  const summary = f.product(LOW, 'summary', 211, 'Exercise summary.');
  const estimate = f.product(HIGH, 'estimate', 212, 'Exercise estimate.');
  const s1 = f.propose(summary, [summary.typed]);
  const ghost = f.propose(estimate, [estimate.typed, s1], [{ product: 'summary', hash: OTHER_HASH }]);
  const sideways = f.propose(summary, [s1], [{ product: 'nowhere', hash: OTHER_HASH }]);

  const ordered = f.fold();
  assert.deepEqual(ordered.refused.map((item) => [item.hash, item.reason]).sort(), [[ghost.hash, 'pin-above-cell'], [sideways.hash, 'pin-above-cell']].sort());

  // No cell order: nothing about pins is checked, as before this plan.
  const open = f.fold(f.world.ctx());
  assert.deepEqual(open.refused, []);
  assert.ok(open.applied.includes(ghost.hash) && open.applied.includes(sideways.hash));
});

test('pin-above-cell: a product in an incomparable cell (neither dominates the other) cannot be pinned', () => {
  const f = cellsFixture();
  const summary = f.product(LOW, 'summary', 221, 'Exercise summary.');
  const side = f.product(SIDE, 'logistics', 222, 'Exercise logistics.');
  const l1 = f.propose(side, [side.typed]);
  const s1 = f.propose(summary, [summary.typed]);
  const logisticsHash = replicaVersionHash('Exercise logistics.', []);
  const across = f.propose(summary, [s1], [{ product: 'logistics', hash: logisticsHash }]);
  const result = f.fold();
  assert.ok(result.applied.includes(l1.hash));
  assert.deepEqual(result.refused, [{ hash: across.hash, reason: 'pin-above-cell', family: 'versions' }]);
});

test('pinProblem: no pins, no cell order, own stream and a dominated stream pass; an incomparable stream, an unknown product and an unknown hash are pin-above-cell', () => {
  const candidates: PinCandidate[] = [
    { stream: LOW, product: 'summary', hashes: new Set(['1'.repeat(64)]) },
    { stream: HIGH, product: 'estimate', hashes: new Set(['2'.repeat(64)]) },
    { stream: SIDE, product: 'logistics', hashes: new Set(['3'.repeat(64)]) },
    // The same product name in two cells: the pin passes when either copy is one the citing cell may see and it holds the hash.
    { stream: SIDE, product: 'shared-name', hashes: new Set(['4'.repeat(64)]) },
    { stream: LOW, product: 'shared-name', hashes: new Set(['5'.repeat(64)]) }
  ];
  assert.equal(pinProblem(LOW, [], candidates, ORDER), undefined);
  assert.equal(pinProblem(LOW, [{ product: 'estimate', hash: '2'.repeat(64) }], candidates), undefined, 'without a cell order nothing is checked');
  assert.equal(pinProblem(LOW, [{ product: 'summary', hash: '1'.repeat(64) }], candidates, ORDER), undefined, 'own stream');
  assert.equal(pinProblem(HIGH, [{ product: 'summary', hash: '1'.repeat(64) }, { product: 'estimate', hash: '2'.repeat(64) }], candidates, ORDER), undefined, 'dominated stream');
  assert.equal(pinProblem(LOW, [{ product: 'estimate', hash: '2'.repeat(64) }], candidates, ORDER), 'pin-above-cell', 'higher stream');
  assert.equal(pinProblem(HIGH, [{ product: 'logistics', hash: '3'.repeat(64) }], candidates, ORDER), 'pin-above-cell', 'incomparable stream');
  assert.equal(pinProblem(HIGH, [{ product: 'unknown', hash: '1'.repeat(64) }], candidates, ORDER), 'pin-above-cell', 'unknown product');
  assert.equal(pinProblem(HIGH, [{ product: 'summary', hash: '9'.repeat(64) }], candidates, ORDER), 'pin-above-cell', 'unknown hash');
  assert.equal(pinProblem(HIGH, [{ product: 'shared-name', hash: '5'.repeat(64) }], candidates, ORDER), undefined, 'the copy in a dominated cell holds the hash');
  assert.equal(pinProblem(HIGH, [{ product: 'shared-name', hash: '4'.repeat(64) }], candidates, ORDER), 'pin-above-cell', 'only the incomparable copy holds the hash');
  // One bad pin among good ones is enough.
  assert.equal(pinProblem(HIGH, [{ product: 'summary', hash: '1'.repeat(64) }, { product: 'logistics', hash: '3'.repeat(64) }], candidates, ORDER), 'pin-above-cell');
  assert.match(PRODUCT_CELL_REFUSALS['pin-above-cell'], /^This version pins a product that is not in its own part of the project/);
});
