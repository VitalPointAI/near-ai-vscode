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
import { SCALE_PRESETS } from '../domain/gate/labels';
import type { Label } from '../domain/gate/labels';
import { REPLICA_KINDS, kindFamily, validateData } from '../domain/replica/kinds';
import {
  BASE_CELL_KINDS, DEFAULT_PRODUCT_LABEL, PREVIEW_WAY_FORWARD_TEXT, PRODUCT_CELL_REFUSALS, baseCellAllows, baseCellHeldProducts, importScopeOf, labelFromText,
  labelText, legacyCellLabel, pinProblem, readLegacyCellLabel, sameLabel
} from '../domain/replica/productCells';
import type { PinCandidate } from '../domain/replica/productCells';
import { projectReducer } from '../domain/replica/projectFold';
import type { ProjectOutput } from '../domain/replica/projectFold';
import type { FoldView } from '../domain/replica/reducers';
import type { ReplicaContext } from '../domain/replica/rosterView';
import { verifyEntry } from '../domain/replica/verify';
import type { VerifiedEntry } from '../domain/replica/verify';
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

// ---- Task 2: scoped imports (D-20) --------------------------------------------------------------------------------------------------------------

const HASH = (letter: string): string => letter.repeat(64);
const LEDGER_LINES = Buffer.from('{"seq":1,"product":"summary","note":"A fictional ledger line."}\n', 'utf8').toString('base64url');
const importBase = { ledger: 'products', legacyHead: HASH('c'), count: 12 };
const reasonOf = (data: unknown): string => {
  const check = validateData('project.import', data);
  assert.equal(check.ok, false, `${JSON.stringify(data).slice(0, 80)} should fail`);
  return check.ok ? '' : check.reason;
};

test('project.import scope: whole with file and mark and cell with file and lines are valid; cell with mark, cell without lines or file, lines without cell and an unknown scope are refused at the field', () => {
  assert.deepEqual(validateData('project.import', importBase), { ok: true });
  assert.deepEqual(validateData('project.import', { ...importBase, scope: 'whole', file: LEDGER_LINES, mark: 'one line mark' }), { ok: true });
  assert.deepEqual(validateData('project.import', { ...importBase, scope: 'whole' }), { ok: true });
  assert.deepEqual(validateData('project.import', { ...importBase, scope: 'cell', file: LEDGER_LINES, lines: 1 }), { ok: true });
  const refusals: Array<[unknown, string]> = [
    [{ ...importBase, scope: 'cell', file: LEDGER_LINES, lines: 1, mark: 'one line mark' }, 'data.mark'],
    [{ ...importBase, scope: 'cell', file: LEDGER_LINES }, 'data.lines'],
    [{ ...importBase, scope: 'cell', lines: 1 }, 'data.file'],
    [{ ...importBase, lines: 1 }, 'data.lines'],
    [{ ...importBase, scope: 'whole', lines: 1 }, 'data.lines'],
    [{ ...importBase, scope: 'part' }, 'data.scope'],
    [{ ...importBase, scope: 7 }, 'data.scope'],
    [{ ...importBase, scope: 'cell', file: LEDGER_LINES, lines: -1 }, 'data.lines'],
    [{ ...importBase, scope: 'cell', file: LEDGER_LINES, lines: 1.5 }, 'data.lines']
  ];
  for (const [data, path] of refusals) {
    const reason = reasonOf(data);
    assert.ok(reason.startsWith('bad-data:') && reason.includes(path), `should name ${path}: ${reason}`);
  }
});

test('project.import scope: the fold lists a scopeless import as whole and a cell import with its lines, both cell imports of one ledger in two streams, and the digest tuple is unchanged', () => {
  const f = cellsFixture();
  const plain = f.world.write('LEAD', { kind: 'project.import', data: importBase });
  const whole = f.world.write('LEAD', { kind: 'project.import', data: { ...importBase, scope: 'whole' } });
  const sameStreamCell = f.world.write('LEAD', { kind: 'project.import', data: { ...importBase, scope: 'cell', file: LEDGER_LINES, lines: 1 } });
  const low = f.world.write('LEAD', { kind: 'project.import', stream: LOW, data: { ...importBase, scope: 'cell', file: LEDGER_LINES, lines: 1 } });
  const high = f.world.write('LEAD', { kind: 'project.import', stream: HIGH, data: { ...importBase, scope: 'cell', file: LEDGER_LINES, lines: 3 } });
  const result = f.fold(f.world.ctx());
  assert.deepEqual([result.refused, result.held, result.rejected], [[], [], []]);
  const output = result.families.project as ProjectOutput;
  const of = (stream: string): Array<[string, string, number | null]> =>
    (output.find((item) => item.stream === stream)?.imports ?? []).map((item): [string, string, number | null] => [item.entry, item.scope, item.lines ?? null]);
  // A scopeless import and a whole one are the same import, listed once (the first in fold order); a cell import of the same ledger is another.
  const base = of(f.world.stream);
  assert.equal(base.length, 2);
  assert.deepEqual(base.map(([, scope]) => scope), ['whole', 'cell']);
  assert.ok([plain.hash, whole.hash].includes(base[0][0]));
  assert.deepEqual(base[1], [sameStreamCell.hash, 'cell', 1]);
  assert.deepEqual(of(LOW), [[low.hash, 'cell', 1]]);
  assert.deepEqual(of(HIGH), [[high.hash, 'cell', 3]]);
  // The digest form keeps its four-item tuple; the entry hash commits to scope and lines.
  assert.deepEqual((projectReducer.canonical(output, LOW) as { imports: unknown[] }).imports, [['products', HASH('c'), 12, low.hash]]);
  assert.equal((projectReducer.canonical(output, f.world.stream) as { imports: unknown[][] }).imports.every((item) => item.length === 4), true);
  // Survives clone, so an incremental fold lists the same scope and lines.
  const view = { ctx: { ...f.world.ctx(), roster: { ...f.world.ctx().roster, hasRole: () => true } } } as unknown as FoldView;
  const state = projectReducer.init();
  for (const written of [plain, sameStreamCell, high]) {
    const outcome = verifyEntry(written.entry, f.world.ctx());
    assert.equal(outcome.status, 'verified');
    assert.deepEqual(projectReducer.apply(state, (outcome as { entry: VerifiedEntry }).entry, view), { status: 'applied' });
  }
  const copied = projectReducer.finish(projectReducer.clone(state), view);
  assert.deepEqual(copied, projectReducer.finish(state, view));
  assert.deepEqual(copied.flatMap((item) => item.imports.map((entry) => [entry.scope, entry.lines ?? null])).sort(), [['cell', 1], ['cell', 3], ['whole', null]].sort());
  assert.equal(importScopeOf({}), 'whole');
  assert.equal(importScopeOf({ scope: 'whole' }), 'whole');
  assert.equal(importScopeOf({ scope: 'cell' }), 'cell');
  assert.equal(importScopeOf({ scope: 'part' }), 'whole');
});

// ---- Task 2: the base cell (D-15, D-16, D-22 revised) -------------------------------------------------------------------------------------------

test('baseCellAllows: every roster kind, project.genesis, the integrity kinds, session.certify and device.kem; never a product, text or import kind, and the closed list stays at 72', () => {
  assert.equal(REPLICA_KINDS.length, 72, 'roster.require (POST-01), hub.readmit (D-42) and session.certify (D-62), Phase 33; device.kem, 33.2 D-03; 14 roster and 2 personnel kinds of Phase 33.1; cell.access.commit');
  for (const kind of REPLICA_KINDS) {
    const family = kindFamily(kind);
    if (family === 'roster' || family === 'integrity' || family === 'session' || family === 'device') assert.equal(baseCellAllows(kind), true, kind);
    if (family === 'versions' || family === 'doc') assert.equal(baseCellAllows(kind), false, kind);
  }
  for (const kind of ['project.genesis', 'equivocation.proof', 'digest.report', 'member.admit', 'cell.create', 'hub.grant']) assert.equal(baseCellAllows(kind), true, kind);
  for (const kind of ['project.import', 'product.create', 'doc.client', 'doc.update', 'version.propose', 'register.row', 'not.a.kind', '__proto__']) assert.equal(baseCellAllows(kind), false, kind);
  assert.equal(BASE_CELL_KINDS.every((kind) => REPLICA_KINDS.includes(kind as typeof REPLICA_KINDS[number])), true);
  assert.equal(new Set(BASE_CELL_KINDS).size, BASE_CELL_KINDS.length);
  assert.equal(DEFAULT_PRODUCT_LABEL, 'org/Internal');
});

test('baseCellHeldProducts: a fold built like a 0.4.35 conversion (products in the project\'s own stream) is true; products only in label cells, and an empty fold, are false', () => {
  const f = cellsFixture();
  const base = f.world.stream;
  const genesis = f.world.write('LEAD', { kind: 'project.genesis', data: { project: streamId('project'), name: 'Exercise Northwind', profile: 'staff-j2', labelMapHash: HASH('a'), lead: { member: 'mbr-lead', writer: f.world.writerOf('LEAD') } } });
  const summary = f.product(LOW, 'summary', 301, 'Exercise summary.');
  f.propose(summary, [summary.typed]);
  const cells = f.fold(f.world.ctx());
  assert.ok(cells.applied.includes(genesis.hash));
  assert.equal(baseCellHeldProducts(cells, base), false);
  assert.equal(baseCellHeldProducts(cells, LOW), true);
  assert.equal(baseCellHeldProducts(foldEntries([], f.world.ctx(), REDUCERS), base), false);
  assert.equal(baseCellHeldProducts({ families: {} }, base), false);

  // The preview conversion: product.create, doc.client, doc.update and version.propose in the project's own stream.
  const preview = f.product(base, 'estimate', 302, 'Exercise estimate.');
  f.propose(preview, [preview.typed]);
  const previewFold = f.fold(f.world.ctx());
  assert.equal(baseCellHeldProducts(previewFold, base), true);
  // A plain versions output works too.
  assert.equal(baseCellHeldProducts(previewFold.families.versions as ProductVersions[], base), true);
  assert.equal(baseCellHeldProducts(cells.families.versions as ProductVersions[], base), false);
});

test('baseCellHeldProducts: held product-family entries of the base stream count, from a real fold and from the held list alone; other families and other streams do not', () => {
  const f = cellsFixture();
  const base = f.world.stream;
  // A product entry with no product.create, and a text update from a client that never registered: both held in the base stream.
  const orphanOwner = f.world.write('LEAD', { kind: 'product.owner', data: { product: 'orphan', owner: 'j2-chief' } });
  const editor = f.world.editor('P', 'orphan', 401);
  const orphanText = editor.insert(0, 'Exercise text.', {});
  const result = f.fold(f.world.ctx());
  assert.deepEqual(result.held.map((item) => [item.hash, item.family]).sort(), [[orphanOwner.hash, 'versions'], [orphanText.hash, 'doc']].sort());
  assert.deepEqual(result.families.versions, []);
  assert.equal(baseCellHeldProducts(result, base), true);
  assert.equal(baseCellHeldProducts(result, LOW), false);
  // The structural form: a doc entry held missing-key, a versions entry held product-unknown, and entries that do not count.
  assert.equal(baseCellHeldProducts({ families: {}, held: [{ stream: base, family: 'doc' }] }, base), true);
  assert.equal(baseCellHeldProducts({ families: {}, held: [{ stream: base, family: 'versions' }] }, base), true);
  assert.equal(baseCellHeldProducts({ families: {}, held: [{ stream: base, family: 'project' }, { stream: base }, { stream: LOW, family: 'doc' }] }, base), false);
  assert.equal(baseCellHeldProducts({ families: { versions: [{ stream: LOW }], doc: [{ stream: base }] } }, base), true);
  assert.equal(baseCellHeldProducts({ families: { versions: 'not a list', doc: [null, 7, { stream: LOW }] } }, base), false);
  assert.equal(baseCellHeldProducts([], base), false);
  assert.equal(baseCellHeldProducts([{ stream: LOW }, { stream: base }], base), true);
});

test('PREVIEW_WAY_FORWARD_TEXT is the D-22 sentence word for word', () => {
  assert.equal(PREVIEW_WAY_FORWARD_TEXT, 'This project was made shared by an earlier preview, and its products sit in the part of the project the hub must read. Make a single-machine copy and make that copy multi-user again; the new shared project keeps each product in its own part.');
});

// ---- Task 2: label text helpers (D-15, D-17, D-20) ----------------------------------------------------------------------------------------------

const label = (scale: string, level: string, compartments: string[] = [], releasability: string[] = [], handling: string[] = []): Label => ({ scale, level, compartments, releasability, handling });

test('labelText and labelFromText: scale/level with compartments and releasability, the default label parses, an unknown level does not', () => {
  assert.equal(labelText(label('org', 'Confidential', ['ALPHA'], ['CAN'])), 'org/Confidential//ALPHA//REL CAN');
  assert.equal(labelText(label('org', 'Internal')), 'org/Internal');
  assert.equal(labelText(label('org', 'Restricted', ['BRAVO', 'ALPHA'], ['GBR', 'CAN'])), 'org/Restricted//ALPHA/BRAVO//REL CAN, GBR');
  assert.equal(labelText(label('org', 'Confidential', [], ['CAN'])), 'org/Confidential//REL CAN');
  assert.deepEqual(labelFromText('org/Internal', SCALE_PRESETS), label('org', 'Internal'));
  assert.deepEqual(labelFromText(DEFAULT_PRODUCT_LABEL, SCALE_PRESETS), label('org', 'Internal'));
  assert.deepEqual(labelFromText('ca-classified/Top Secret', SCALE_PRESETS), label('ca-classified', 'Top Secret'));
  for (const bad of ['org/Nope', 'org', '', '/Internal', 'nope/Internal', '__proto__/Internal', 'org/Internal//ALPHA', 7, undefined]) {
    assert.equal(labelFromText(bad, SCALE_PRESETS), undefined, String(bad));
  }
});

test('sameLabel ignores token order and compares every part; legacyCellLabel is sorted without duplicates and readLegacyCellLabel reads only that shape', () => {
  assert.equal(sameLabel(label('org', 'Confidential', ['BRAVO', 'ALPHA'], ['GBR', 'CAN']), label('org', 'Confidential', ['ALPHA', 'BRAVO'], ['CAN', 'GBR'])), true);
  assert.equal(sameLabel(label('org', 'Confidential'), label('org', 'Internal')), false);
  assert.equal(sameLabel(label('org', 'Confidential'), label('ca-classified', 'Confidential')), false);
  assert.equal(sameLabel(label('org', 'Confidential', ['ALPHA']), label('org', 'Confidential')), false);
  assert.equal(sameLabel(label('org', 'Confidential', [], ['CAN']), label('org', 'Confidential')), false);
  assert.equal(sameLabel(label('org', 'Confidential', [], [], ['local-only']), label('org', 'Confidential')), false);
  assert.equal(sameLabel(undefined, label('org', 'Internal')), false);

  const internal = label('org', 'Internal');
  const confidential = label('org', 'Confidential', ['BRAVO', 'ALPHA'], ['CAN']);
  const legacy = legacyCellLabel([confidential, internal, label('org', 'Internal'), label('org', 'Confidential', ['ALPHA', 'BRAVO'], ['CAN'])]);
  assert.equal(legacy.legacy, 1);
  assert.equal(legacy.labels.length, 2);
  assert.deepEqual(legacy, legacyCellLabel([internal, confidential]), 'the same set in any order gives the same form');
  assert.deepEqual(legacy.labels.find((item) => item.level === 'Confidential')?.compartments, ['ALPHA', 'BRAVO']);
  assert.deepEqual(legacyCellLabel([]), { legacy: 1, labels: [] });

  const read = readLegacyCellLabel(JSON.parse(JSON.stringify(legacy)) as unknown, SCALE_PRESETS);
  assert.ok(read !== undefined);
  assert.equal(read.length, 2);
  assert.ok(read.some((item) => sameLabel(item, internal)) && read.some((item) => sameLabel(item, confidential)));
  assert.deepEqual(readLegacyCellLabel({ legacy: 1, labels: [] }, SCALE_PRESETS), []);
  for (const bad of [
    internal, undefined, null, 'legacy', [internal],
    { legacy: 2, labels: [] }, { legacy: '1', labels: [] }, { legacy: 1 }, { labels: [] },
    { legacy: 1, labels: [internal], extra: true }, { legacy: 1, labels: internal }, { legacy: 1, labels: [label('org', 'Nope')] },
    JSON.parse('{"legacy":1,"labels":[],"__proto__":{"x":1}}') as unknown
  ]) {
    assert.equal(readLegacyCellLabel(bad, SCALE_PRESETS), undefined, JSON.stringify(bad));
  }
});
