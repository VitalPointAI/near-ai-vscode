// Make This Staff Project Multi-User (plan 31-19; MUS-06, D-28 to D-34, D-46). A staff project built by today's single-machine host (signed product
// ledger with its head mark, decision log, calculator ledger, wargame ledger, product files and the files no replica kind covers yet) is converted, and
// the tests check: verify first, import whole with the right head, re-verify every import with today's verifiers forever, reconstruct products, files
// as projections equal to today's, nothing deleted, and a conversion interrupted after any step reaching exactly the same entries, digests and files.
// Since plan 32-10 (D-15 to D-21) each product goes into the cell for its label, the whole ledgers into the lead-only legacy cell, each label cell gets
// a products import of its own lines, and the conversion refuses only the labels the lead's declared clearance does not cover.
import assert from 'node:assert/strict';
import { clientReplicaFeatures } from '../staff/replica/clientFeatures';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { x25519PrivateFromSeed } from '../domain/replica/cellKeys';
import { entryHash, openBody } from '../domain/replica/entry';
import { BASE_CELL_KINDS, baseCellAllows } from '../domain/replica/productCells';
import { REPLICA_KINDS } from '../domain/replica/kinds';
import type { ProjectOutput } from '../domain/replica/projectFold';
import type { ProductTextOutput } from '../domain/replica/textFold';
import type { ProductVersions } from '../domain/replica/versions';
import type { StaffSectionId } from '../domain/staff/doctrine';
import { parseLedgerHeadMark, productHash, replayLedger } from '../domain/staff/ledger';
import type { ProductState } from '../domain/staff/ledger';
import { replayCalcLedger } from '../domain/staff/logistics';
import type { PlanningFactor } from '../domain/staff/logistics';
import { LEGACY_DIR, REPLICA_DIR, multiUserNoticeLines } from '../domain/staff/multiUser';
import { replayPersonDecisions } from '../domain/staff/personDecisions';
import type { PersonActor } from '../domain/staff/release';
import type { KeyStatusLookup } from '../domain/team/keyStatus';
import { verifyPayload } from '../domain/team/signedPayload';
import type { DeviceIdentity } from '../team/identity';
import { identityDir } from '../team/identity';
import { localKeyStatus } from '../team/keyHistory';
import { NOT_CLEARED_TEXT } from '../staff/replica/labelCells';
import { BASE_CELL_LABEL, LEGACY_LEDGERS, MIGRATION_REFUSALS, MIGRATION_STEPS, PASSTHROUGH_LEDGERS, isMigrationRefused, ledgerHeadKey, makeMultiUser, migrationComplete, projectionInputOf, verifyLegacyLedgers } from '../staff/replica/migrate';
import type { MigrationDeps, MigrationOptions, MigrationRefused, MigrationResult, MigrationStep } from '../staff/replica/migrate';
import { IMPORTED_APPROVAL_TEXT, PROJECTION_LEFT_REASONS, importOf, importedFile, ledgerLinesOf, projectLedgerReplay, projectProductFile } from '../staff/replica/projection';
import type { ProjectedProductState, ProjectionInput } from '../staff/replica/projection';
import { ReplicaProject, isProjectRefused } from '../staff/replica/replicaProject';
import { ReplicaStore } from '../staff/replica/store';
import { LEDGER_DIR, LEDGER_FILE, StaffHost, WARGAME_DIR, WARGAME_FILE, productPath } from '../staff/staffHost';
import type { StaffTeamInfo } from '../staff/staffHost';
import { callLogistics, callTool, CLEAN_BODY, hashIn, J5_TEAM, memorySecrets, trusting, writeBody, writeFactors } from './helpers/staffFixtures';
import type { StaffWorld } from './helpers/staffFixtures';
import { bringIn, orgClearance, project as keptProject, streamEntries, syncTo } from './helpers/labelCellWorld';
import type { Install, Seat } from './helpers/labelCellWorld';

const NOW = '2026-11-20T10:00:00.000Z';
const NAME = 'Exercise Northwind';
const CONOPS = 'concept-of-operations';
const ANNEX = 'annex-b';
const ANNEX_BODY = '# Annex B\n\nThe force moves in two phases, as the concept of operations sets out.\n';
const DECISION_ROLE = 'commander';
// Each product goes into the cell for its label (D-15): the released product is org/Public, the pinned one org/Internal, so the conversion makes two
// label cells, and the calculator and wargame ledgers go into the org/Internal one (D-20).
const PUBLIC = 'org/Public';
const INTERNAL = 'org/Internal';
// The clearance the staff lead declares when converting (D-19): it covers every label the full template needs.
const LEAD_CLEARANCE = orgClearance('Internal');
const CONVERT: MigrationOptions = { name: NAME, leadClearance: LEAD_CLEARANCE };
const OPTIONS = [{ label: 'COA 1', risk: 'Moderate risk to the flank' }, { label: 'COA 2', risk: 'Slower, but the flank is covered' }];
const DISSENT = ['The red team holds COA 2 is safer.'];
const J4_TEAM: StaffTeamInfo = { slug: 'j4-logistics', section: 'j4', sectionLead: 'j4-director', members: ['j4-director', 'log-plans-officer', 'jloc-chief', 'release-guard'] };
const FUEL: PlanningFactor = { id: 'fuel-cargo-truck', what: 'Fuel for one cargo truck', rate: 250, unit: 'litres', per: 'vehicle per day', enteredBy: 'A. Demo' };
const GENERATOR: PlanningFactor = { id: 'fuel-generator', what: 'Fuel for one generator', rate: 50, unit: 'litres', per: 'generator per day', enteredBy: 'A. Demo' };
const FUEL_CALC = { id: 'fuel-phase-1', title: 'Class III (bulk) for phase 1', lines: [{ factor: 'fuel-cargo-truck', count: 40, item: 'cargo trucks' }, { factor: 'fuel-generator', count: 10, item: 'generators' }], days: 3, onHand: 21000 };
const TURN = { coa: 'coa-a', enemyCoa: 'mlcoa', turn: 1, phase: 'action', hHourOffsetMinutes: 0, moves: [], results: [], decisionPoints: [] };
// Files no replica kind covers yet (D-32): they must stay where they are, byte for byte.
const UNTOUCHED: Readonly<Record<string, string>> = {
  '.planning/staff/observations/feed-a/segment-0001.jsonl': '{"id":"obs-1","at":"2026-11-18T12:00:00.000Z","text":"Convoy seen at the bridge."}\n',
  '.planning/staff/products/j2/pir-register.json': '{"entries":[]}\n',
  '.planning/staff/proposals/concept-of-operations/draft-note.md': '# Note\n\nA member proposal kept as written.\n',
  '.planning/.near-ai/project.json': '{"staff":{"profile":"nato-ca","level":"tactical"}}\n'
};

type Secrets = ReturnType<typeof memorySecrets>;

/** One install with a staff project: the project folder, the extension's global storage, its secret storage, and the device that signs. */
interface Env {
  readonly root: string;
  readonly global: string;
  readonly secrets: Secrets;
  readonly signer: DeviceIdentity;
  readonly deps: MigrationDeps;
}

function envAt(root: string, global: string, secrets: Secrets, signer: DeviceIdentity): Env {
  return { root, global, secrets, signer, deps: { secrets, globalStorageDir: global, now: () => new Date(NOW), staffKeyStatus: async () => trusting(signer) } };
}

/** Today's host over the env's project, signed by the env's device (the same key the replica writes with), its head kept in the env's secrets. */
function worldOf(env: Env): StaffWorld {
  const clock = { now: Date.parse('2026-11-18T12:00:00.000Z') };
  const make = (): StaffHost => new StaffHost({ root: env.root, signer: async () => env.signer, keyStatus: async () => trusting(env.signer), headStore: env.secrets, now: () => { clock.now += 1000; return clock.now; } });
  const world: StaffWorld = {
    root: env.root, signer: env.signer, clock, host: make(), headStore: env.secrets,
    reload: () => { world.host = make(); return world.host; },
    person: (name = 'A. Demo', role = DECISION_ROLE): PersonActor => ({ kind: 'person', name, role, deviceFingerprint: env.signer.fingerprint })
  };
  return world;
}

async function freshEnv(label: string): Promise<Env> {
  const base = mkdtempSync(path.join(tmpdir(), `near-ai-migrate-${label}-`));
  const root = path.join(base, 'project');
  await mkdir(root, { recursive: true });
  const global = path.join(base, 'global');
  const secrets = memorySecrets();
  const device = await ReplicaProject.localDevice({ secrets, globalStorageDir: global, now: () => new Date(NOW) });
  return envAt(root, global, secrets, device.signer);
}

function must(result: { ok: boolean; text: string }, what: string): string {
  assert.ok(result.ok, `${what}: ${result.text}`);
  return result.text;
}

/** A product proposed, guard-cleared, submitted, approved and released by today's host. */
async function releasedProduct(world: StaffWorld): Promise<void> {
  await writeBody(world.root, 'j5', CONOPS, CLEAN_BODY);
  const hash = hashIn(must(await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: CONOPS, kind: 'plan', label: PUBLIC }, 'lead-planner'), 'propose'));
  must(await callTool(world, J5_TEAM, 'mcp__staff-products__verdict', { product: CONOPS, gate: 'guard', verdict: 'CLEARED', hash }, 'release-guard'), 'verdict');
  must(await callTool(world, J5_TEAM, 'mcp__staff-products__submit', { product: CONOPS, decisionFor: DECISION_ROLE, options: OPTIONS, dissent: DISSENT }, 'lead-planner'), 'submit');
  const approved = await world.host.decide(world.person(), { product: CONOPS, action: 'approve', hash });
  assert.ok(approved.ok, approved.ok ? '' : approved.message);
  const released = await world.host.decide(world.person(), { product: CONOPS, action: 'release', hash });
  assert.ok(released.ok, released.ok ? '' : released.message);
}

/** A second product, labelled org/Internal, pinned to the released org/Public version of the first (a pin down to a lower cell, D-18). */
async function pinnedProduct(world: StaffWorld): Promise<void> {
  await writeBody(world.root, 'j5', ANNEX, ANNEX_BODY);
  must(await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: ANNEX, kind: 'annex', label: INTERNAL, dependsOn: [`${CONOPS}@1`] }, 'lead-planner'), 'propose annex');
}

async function otherLedgers(world: StaffWorld, which: { decisions?: boolean; calculator?: boolean; wargame?: boolean }): Promise<void> {
  if (which.decisions) {
    const decided = await world.host.signWatchDecision(world.person(), { watch: 'watch-bridge', decision: 'approved', wording: createHash('sha256').update('watch the bridge').digest('hex'), reasons: [] });
    assert.ok(decided.ok, decided.ok ? '' : decided.message);
  }
  if (which.calculator) {
    await writeFactors(world.root, [FUEL, GENERATOR]);
    must(await callLogistics(world, J4_TEAM, 'calc_run', FUEL_CALC, 'log-plans-officer'), 'calc_run');
  }
  if (which.wargame) {
    must(await callTool(world, J5_TEAM, 'mcp__staff-products__wargame', { action: 'record', phase: TURN }, 'plans-writer'), 'wargame');
    // A damaged line today's host leaves out: the import counts the readable lines only and keeps the file whole.
    await appendFile(path.join(world.root, WARGAME_DIR, WARGAME_FILE), 'not a turn\n');
  }
}

async function writeUntouched(root: string): Promise<void> {
  for (const [relative, text] of Object.entries(UNTOUCHED)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
}

/** The template every full test copies: one released product, one pinned product, all four ledgers, and files no replica kind covers. */
let fullTemplate: Promise<Env> | undefined;
function full(): Promise<Env> {
  fullTemplate ??= (async () => {
    const env = await freshEnv('template');
    const world = worldOf(env);
    await writeUntouched(env.root);
    await releasedProduct(world);
    await pinnedProduct(world);
    await otherLedgers(world, { decisions: true, calculator: true, wargame: true });
    return env;
  })();
  return fullTemplate;
}

/** A copy of a template install: the same project bytes, the same device and keys, the product ledger's head mark under the copy's own key. */
async function cloneOf(template: Env, label: string): Promise<Env> {
  const base = mkdtempSync(path.join(tmpdir(), `near-ai-migrate-${label}-`));
  const root = path.join(base, 'project');
  const global = path.join(base, 'global');
  cpSync(template.root, root, { recursive: true });
  cpSync(template.global, global, { recursive: true });
  const secrets = memorySecrets();
  const markKey = ledgerHeadKey(template.root);
  for (const [key, value] of template.secrets.values) secrets.values.set(key === markKey ? ledgerHeadKey(root) : key, value);
  return envAt(root, global, secrets, template.signer);
}

async function migrate(env: Env, options: MigrationOptions = {}): Promise<MigrationResult> {
  const result = await makeMultiUser(env.root, env.deps, { ...CONVERT, ...options });
  assert.ok(!isMigrationRefused(result), isMigrationRefused(result) ? result.message : '');
  return result as MigrationResult;
}

async function opened(env: Env): Promise<ReplicaProject> {
  const project = await ReplicaProject.open(env.root, env.deps);
  assert.ok(project instanceof ReplicaProject, `the shared project opens (${isProjectRefused(project) ? project.message : String(project)})`);
  return project;
}

async function projection(env: Env): Promise<ProjectionInput> {
  const project = await opened(env);
  try {
    return await projectionInputOf(project, env.deps);
  } finally {
    await project.close();
  }
}

function importsOf(input: ProjectionInput): ProjectOutput[number]['imports'] {
  return (input.fold.families.project as ProjectOutput).flatMap((item) => item.imports);
}

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

/** Every file under `.planning`, by path, with the sha256 of its bytes; the replica store and lock files left out unless asked. */
function tree(root: string, withStore = false): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (!withStore && relative.startsWith(REPLICA_DIR)) continue;
      if (statSync(file).isDirectory()) walk(file);
      else if (!name.endsWith('.lock')) out.set(relative, sha256(readFileSync(file)));
    }
  };
  walk(path.join(root, '.planning'));
  return out;
}

/** Today's answers before a conversion: the product replay and files, the decisions, the calculator records and the wargame turns. */
async function todaysAnswers(env: Env) {
  const host = worldOf(env).host;
  const files = new Map<string, Buffer>();
  for (const [product, section] of [[CONOPS, 'j5'], [ANNEX, 'j5']] as const) files.set(product, readFileSync(path.join(env.root, productPath(section as StaffSectionId, product))));
  const records = await host.logistics().records();
  return {
    replay: await host.replay(),
    files,
    decisions: await host.pirDecisions(),
    wargame: await host.wargameEntries(),
    calculator: { verified: [...records.verified].sort(), records: [...records.records.entries()] }
  };
}

function withoutImported(state: ProjectedProductState | undefined): ProductState | undefined {
  if (state === undefined) return undefined;
  const { imported: _imported, ...rest } = state;
  return rest;
}

// ---- Task 1: one approved product becomes multi-user, and its files are the same afterwards -------------------------------------------------------

/** Every own entry of a kind in a project, with its stream and hash. */
async function placed(project: ReplicaProject, kind: string): Promise<Array<{ stream: string; hash: string; data: Record<string, unknown> }>> {
  return (await project.findOwnAll(kind, () => true)).map((item) => ({ stream: item.stream, hash: item.hash, data: item.data as Record<string, unknown> }));
}

/** The lines of a product ledger file naming one of the products, each byte for byte as in the file. */
function linesFor(bytes: Buffer, products: readonly string[]): string[] {
  return bytes.toString('utf8').split('\n').filter((line) => line.trim() !== '' && products.includes((JSON.parse(line) as { payload: { product: string } }).payload.product));
}

/** The kind of every entry of a stream, each opened with the key this project holds for its epoch. */
function kindsIn(project: ReplicaProject, root: string, stream: string): string[] {
  return streamEntries({ root } as Install, stream).map((entry) => {
    const key = project.keys.epochKey(stream, entry.header.epoch);
    assert.ok(key !== undefined, 'the entry opens with a key this device holds');
    const plain = openBody(key, entry.header, Buffer.from(entry.body, 'base64url'));
    assert.ok(plain !== undefined, 'the entry opens with that key');
    return (JSON.parse(plain.toString('utf8')) as { kind: string }).kind;
  });
}

test('tracer: label cells: the org/Public product goes into an org/Public cell, the org/Internal one into an org/Internal cell with the calculator and wargame ledgers, and the whole ledgers into the legacy cell', async () => {
  const env = await cloneOf(await full(), 'tracer');
  const before = await todaysAnswers(env);
  const original = readFileSync(path.join(env.root, LEDGER_DIR, LEDGER_FILE));
  const mark = env.secrets.values.get(ledgerHeadKey(env.root));
  assert.ok(mark !== undefined, 'today\'s host keeps a head mark for the product ledger');

  const result = await migrate(env);
  assert.equal(result.completed, 'complete');
  assert.deepEqual(result.cells.map((item) => [item.label, item.legacy, item.products]), [
    [INTERNAL, undefined, [ANNEX]],
    [PUBLIC, undefined, [CONOPS]],
    [undefined, [INTERNAL, PUBLIC], [ANNEX, CONOPS]]
  ]);
  const [internal, publicCell, legacy] = result.cells.map((item) => item.cell);
  assert.equal(new Set([internal, publicCell, legacy, result.project]).size, 4, 'three cells of their own, none of them the base cell');

  const input = await projection(env);
  const outputs = input.fold.families.project as ProjectOutput;
  const imports = (stream: string) => outputs.find((item) => item.stream === stream)?.imports ?? [];
  assert.ok(outputs.find((item) => item.stream === result.project)?.genesis, 'the genesis is in the base cell');
  assert.deepEqual(imports(result.project as string), [], 'nothing imported into the base cell');
  assert.deepEqual(imports(legacy).map((item) => [item.ledger, item.scope]), [['decisions', 'whole'], ['products', 'whole']]);
  assert.deepEqual(imports(publicCell).map((item) => [item.ledger, item.scope]), [['products', 'cell']]);
  assert.deepEqual(imports(internal).map((item) => [item.ledger, item.scope]).sort(), [['calculator', 'whole'], ['products', 'cell'], ['wargame', 'whole']]);

  // The whole product ledger, with today's head, count, mark and file, in the legacy cell only.
  const whole = imports(legacy).find((item) => item.ledger === 'products');
  assert.ok(whole !== undefined);
  assert.equal(whole.legacyHead, before.replay.head);
  assert.equal(whole.count, before.replay.entries);
  assert.equal(whole.marked, true);
  assert.equal(whole.fileHash, sha256(original));
  assert.equal((input.entries.get(whole.entry)?.data as { mark?: string }).mark, mark, 'the signed head mark is carried as it is');

  // Each label cell's products import holds exactly its products' lines, byte for byte, with the whole ledger's head and count.
  const cellImport = new Map<string, string>();
  for (const [cell, products] of [[publicCell, [CONOPS]], [internal, [ANNEX]]] as const) {
    const scoped = imports(cell).find((item) => item.ledger === 'products');
    assert.ok(scoped !== undefined && scoped.scope === 'cell');
    const lines = linesFor(original, products);
    assert.ok(lines.length > 0);
    assert.equal(scoped.lines, lines.length);
    assert.equal(scoped.legacyHead, before.replay.head);
    assert.equal(scoped.count, before.replay.entries);
    assert.equal(scoped.marked, false);
    assert.equal(scoped.fileHash, sha256(`${lines.join('\n')}\n`));
    assert.equal(importedFile(scoped, input.entries)?.toString('utf8'), `${lines.join('\n')}\n`);
    cellImport.set(cell, scoped.entry);
  }

  const project = await opened(env);
  try {
    // Every entry of a product is in its label cell and cites that cell's products import.
    const cellOf = new Map([[CONOPS, publicCell], [ANNEX, internal]]);
    let written = 0;
    for (const kind of ['product.create', 'doc.client', 'doc.update', 'version.propose']) {
      for (const entry of await placed(project, kind)) {
        const cell = cellOf.get(entry.data.product as string) as string;
        assert.equal(entry.stream, cell, `${kind} of ${String(entry.data.product)} is in its label cell`);
        assert.ok(input.entries.get(entry.hash)?.deps?.includes(cellImport.get(cell) as string), `${kind} cites its cell's import`);
        written += 1;
      }
    }
    assert.ok(written >= 8, `the reconstruct entries are in the store (${written})`);
    // The lead's role and clearance changes are roster entries in the base cell and cite no import.
    const importEntries = new Set([...input.entries.entries()].filter(([, entry]) => entry.kind === 'project.import').map(([hash]) => hash));
    const updates = await placed(project, 'member.update');
    assert.equal(updates.length, 2, 'one clearance change and one role change');
    for (const update of updates) {
      assert.equal(update.stream, result.project);
      assert.deepEqual((input.entries.get(update.hash)?.deps ?? []).filter((dep) => importEntries.has(dep)), [], 'the lead\'s change cites no import');
    }
    // Opened with the base key, every base cell entry is the genesis or a roster or integrity kind (D-15, D-16).
    const kinds = kindsIn(project, env.root, result.project as string);
    assert.ok(kinds.includes('project.genesis') && kinds.includes('cell.create'));
    for (const kind of kinds) assert.ok(baseCellAllows(kind), `${kind} may be in the base cell`);
    assert.ok(BASE_CELL_KINDS.includes('member.update'));
  } finally {
    await project.close();
  }

  // The original moved, byte for byte; nothing at its usual path; the head mark left as it is.
  assert.deepEqual(readFileSync(path.join(env.root, LEGACY_DIR, 'ledger', LEDGER_FILE)), original);
  assert.equal(existsSync(path.join(env.root, LEDGER_DIR, LEDGER_FILE)), false);
  assert.equal(env.secrets.values.get(ledgerHeadKey(env.root)), mark);
  // The product files are byte for byte what they were.
  for (const [product, bytes] of before.files) assert.deepEqual(readFileSync(path.join(env.root, productPath('j5', product))), bytes, product);
});

test('the projected replay equals today\'s replay for every product, and an approved product carries the imported approval wording', async () => {
  const env = await cloneOf(await full(), 'replay');
  const before = await todaysAnswers(env);
  await migrate(env);
  const input = await projection(env);
  const replay = projectLedgerReplay(input);
  for (const product of [CONOPS, ANNEX]) {
    const projected = replay.products.get(product) as ProjectedProductState | undefined;
    const legacy = before.replay.products.get(product) as ProductState;
    assert.ok(projected !== undefined, product);
    assert.deepEqual(projected.record, legacy.record, `${product} record`);
    assert.deepEqual(projected.meta, legacy.meta, `${product} meta`);
    assert.deepEqual(projected.approvedVersions, legacy.approvedVersions, `${product} approvedVersions`);
    assert.deepEqual(projected.older, legacy.older, `${product} older`);
    assert.deepEqual(withoutImported(projected), legacy, `${product}: the whole state, history and gate marks included`);
    // The file a host writes for the projected state is the file on disk.
    const body = readFileSync(path.join(env.root, productPath('j5', product)), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
    assert.equal(projectProductFile(projected, body), readFileSync(path.join(env.root, productPath('j5', product)), 'utf8'));
  }
  const conops = replay.products.get(CONOPS) as ProjectedProductState;
  assert.equal(conops.record.state, 'released');
  assert.equal(conops.imported?.approval, IMPORTED_APPROVAL_TEXT);
  // The wording's load-bearing phrases: where and when it was approved, and who verified it at import.
  assert.match(IMPORTED_APPROVAL_TEXT, /approved on this machine/);
  assert.match(IMPORTED_APPROVAL_TEXT, /before the project became multi-user/);
  assert.match(IMPORTED_APPROVAL_TEXT, /verified at import by the staff lead/);
  const annex = replay.products.get(ANNEX) as ProjectedProductState;
  assert.equal(annex.imported?.approval, undefined, 'a product never approved carries no approval wording');
  assert.equal(annex.imported?.ledger, 'products');
});

test('each reconstructed version\'s text, with its pins mapped back to today\'s versions, gives today\'s product hash', async () => {
  const env = await cloneOf(await full(), 'pins');
  const before = await todaysAnswers(env);
  const result = await migrate(env);
  assert.deepEqual(result.versions, [ANNEX, CONOPS]);
  const input = await projection(env);
  const versions = input.fold.families.versions as ProductVersions[];
  const legacyVersionOf = (product: string, hash: string): number => {
    const view = versions.find((item) => item.product === product)?.versions.find((candidate) => candidate.hash === hash);
    assert.ok(view !== undefined, `the pinned version of ${product} is in the fold`);
    // Only the current version of a product is reconstructed, so a pin names today's current version of it.
    return (before.replay.products.get(product) as ProductState).record.version;
  };
  for (const product of [CONOPS, ANNEX]) {
    const views = versions.find((item) => item.product === product)?.versions ?? [];
    assert.equal(views.length, 1, `${product} has one reconstructed version`);
    const [view] = views;
    const text = input.texts?.get(view.hash);
    assert.ok(text !== undefined, `${product}: the version text opens`);
    const dependsOn = view.pins.map((pin) => ({ product: pin.product, version: legacyVersionOf(pin.product, pin.hash) }));
    assert.equal(productHash(text, dependsOn), (before.replay.products.get(product) as ProductState).record.hash, product);
  }
  const annexView = versions.find((item) => item.product === ANNEX)?.versions[0];
  assert.equal(annexView?.pins.length, 1, 'the annex pins the concept of operations by hash');
  // The org/Internal annex pins down into the org/Public cell, which its label dominates (D-18): it gets its version, in its own cell.
  assert.equal(versions.find((item) => item.product === ANNEX)?.stream, result.cells.find((item) => item.label === INTERNAL)?.cell);
  assert.equal(versions.find((item) => item.product === CONOPS)?.stream, result.cells.find((item) => item.label === PUBLIC)?.cell);
  assert.deepEqual(result.unversioned, []);
});

test('the result lists the notices every multi-user result shows, the imports and the moved files', async () => {
  const env = await cloneOf(await full(), 'notices');
  const result = await migrate(env);
  assert.deepEqual(result.notices, multiUserNoticeLines());
  assert.deepEqual(result.imported.map((item) => item.ledger), ['products', 'decisions', 'calculator', 'wargame']);
  assert.deepEqual(result.moved, LEGACY_LEDGERS.map((item) => item.legacyPath));
  assert.deepEqual(result.products, [ANNEX, CONOPS]);
  // One item per ledger in imported (the whole import); the products import of each label cell is listed in scoped.
  const cellOf = new Map(result.cells.map((item) => [item.cell, item.label ?? 'legacy']));
  const original = readFileSync(path.join(env.root, LEGACY_DIR, 'ledger', LEDGER_FILE));
  assert.deepEqual(result.scoped.map((item) => [item.ledger, cellOf.get(item.cell), item.lines]).sort(), [
    ['products', INTERNAL, linesFor(original, [ANNEX]).length],
    ['products', PUBLIC, linesFor(original, [CONOPS]).length]
  ]);
  assert.ok(result.imported.every((item) => !result.scoped.some((scoped) => scoped.entry === item.entry)), 'imported names the whole imports');
  assert.deepEqual(result.unversioned, []);
});

// ---- Task 2: all four ledgers ----------------------------------------------------------------------------------------------------------------------

test('all four ledgers: four imports; decisions and calculator heads are their last entry digests, the wargame head is the file hash and its count the readable lines; only products is marked', async () => {
  const env = await cloneOf(await full(), 'four');
  const host = worldOf(env).host;
  const status = trusting(env.signer);
  const bytes = (relative: string): Buffer => readFileSync(path.join(env.root, ...relative.split('/')));
  const decisions = replayPersonDecisions(ledgerLinesOf(bytes(LEGACY_LEDGERS[1].path)), (envelope) => verifyPayload(envelope, { purpose: 'staff-decision', status }));
  const calculator = replayCalcLedger(ledgerLinesOf(bytes(LEGACY_LEDGERS[2].path)), (envelope) => verifyPayload(envelope, { purpose: 'staff-ledger', status }));
  const wargame = bytes(LEGACY_LEDGERS[3].path);
  const turns = (await host.wargameEntries()).length;
  assert.equal(turns, 1);
  assert.equal(wargame.toString('utf8').split('\n').filter(Boolean).length, 2, 'the wargame file also holds a damaged line');

  await migrate(env);
  const all = importsOf(await projection(env));
  // One whole import per ledger, and the products import of each of the two label cells (D-20).
  const imports = all.filter((item) => item.scope === 'whole');
  assert.equal(imports.length, 4);
  assert.deepEqual(all.filter((item) => item.scope === 'cell').map((item) => item.ledger), ['products', 'products']);
  const by = new Map(imports.map((item) => [item.ledger, item]));
  assert.equal(by.get('decisions')?.legacyHead, decisions.head);
  assert.equal(by.get('decisions')?.count, decisions.entries);
  assert.equal(by.get('calculator')?.legacyHead, calculator.head);
  assert.equal(by.get('calculator')?.count, calculator.entries);
  assert.equal(by.get('wargame')?.legacyHead, sha256(wargame));
  assert.equal(by.get('wargame')?.count, turns);
  assert.deepEqual(imports.filter((item) => item.marked).map((item) => item.ledger), ['products']);
  for (const item of imports) assert.ok(item.fileHash !== undefined, `${item.ledger} carries its whole file`);
});

test('re-verification: every import, opened from the fold, verifies with today\'s verifier and key status and ends at its legacy head', async () => {
  const env = await cloneOf(await full(), 'reverify');
  const before = await todaysAnswers(env);
  await migrate(env);
  const input = await projection(env);
  const status: KeyStatusLookup = trusting(env.signer);
  const original = readFileSync(path.join(env.root, LEGACY_DIR, 'ledger', LEDGER_FILE));
  // Each cell import: every line verifies on its own with today's verifier and key status, the seqs rise, and with the other cells' lines it is the
  // whole ledger (D-20).
  const cellLines: Array<{ seq: number; line: string }> = [];
  for (const record of importsOf(input).filter((item) => item.scope === 'cell')) {
    const bytes = importedFile(record, input.entries);
    assert.ok(bytes !== undefined, 'the cell import opens from the fold and matches its hash');
    let last = -1;
    const lines = bytes.toString('utf8').split('\n').filter((item) => item.trim() !== '');
    assert.equal(record.lines, lines.length);
    for (const line of lines) {
      const verdict = verifyPayload(JSON.parse(line) as unknown, { purpose: 'staff-ledger', status });
      assert.ok(verdict.ok, 'the line verifies on its own');
      const seq = (verdict.payload as { seq: number }).seq;
      assert.ok(seq > last, 'the seqs rise');
      last = seq;
      cellLines.push({ seq, line });
    }
  }
  assert.deepEqual(cellLines.sort((a, b) => a.seq - b.seq).map((item) => item.line), original.toString('utf8').split('\n').filter((item) => item.trim() !== ''), 'the cell imports together are the whole ledger');
  for (const record of importsOf(input).filter((item) => item.scope === 'whole')) {
    const bytes = importedFile(record, input.entries);
    assert.ok(bytes !== undefined, `${record.ledger}: the file opens from the fold and matches its hash`);
    const lines = ledgerLinesOf(bytes);
    switch (record.ledger) {
      case 'products': {
        const markText = (input.entries.get(record.entry)?.data as { mark: string }).mark;
        const markVerdict = verifyPayload(JSON.parse(markText) as unknown, { purpose: 'staff-ledger-head', status });
        assert.ok(markVerdict.ok, 'the carried head mark verifies with today\'s key status');
        const mark = parseLedgerHeadMark(markVerdict.payload);
        const replay = replayLedger(lines, (envelope) => verifyPayload(envelope, { purpose: 'staff-ledger', status }), mark);
        assert.equal(replay.broken, undefined);
        assert.equal(replay.head, record.legacyHead);
        assert.equal(replay.entries, record.count);
        assert.deepEqual(replay.products, before.replay.products);
        break;
      }
      case 'decisions': {
        const replay = replayPersonDecisions(lines, (envelope) => verifyPayload(envelope, { purpose: 'staff-decision', status }));
        assert.equal(replay.broken, undefined);
        assert.equal(replay.head, record.legacyHead);
        assert.deepEqual(replay.decisions, before.decisions);
        break;
      }
      case 'calculator': {
        const replay = replayCalcLedger(lines, (envelope) => verifyPayload(envelope, { purpose: 'staff-ledger', status }));
        assert.equal(replay.broken, undefined);
        assert.equal(replay.head, record.legacyHead);
        assert.equal(replay.entries, record.count);
        break;
      }
      case 'wargame': {
        assert.equal(sha256(bytes), record.legacyHead);
        // Today's reader over the imported bytes gives the same turns as before.
        const elsewhere = await freshEnv('wargame-read');
        await mkdir(path.join(elsewhere.root, WARGAME_DIR), { recursive: true });
        await writeFile(path.join(elsewhere.root, WARGAME_DIR, WARGAME_FILE), bytes);
        assert.deepEqual(await worldOf(elsewhere).host.wargameEntries(), before.wargame);
        break;
      }
      default:
        assert.fail(`unexpected import ${record.ledger}`);
    }
    // A key this computer does not trust fails the same import: the check is real.
    if (record.ledger !== 'wargame') {
      const untrusted: KeyStatusLookup = () => ({ state: 'unknown' });
      const verdict = verifyPayload(lines[0], { purpose: record.ledger === 'decisions' ? 'staff-decision' : 'staff-ledger', status: untrusted });
      assert.equal(verdict.ok, false, `${record.ledger}: an untrusted key does not verify`);
    }
  }
});

test('decisions, calculator and wargame ledgers are written back byte for byte at their usual paths, and today\'s readers answer as before', async () => {
  const env = await cloneOf(await full(), 'passthrough');
  const before = await todaysAnswers(env);
  const originals = new Map(PASSTHROUGH_LEDGERS.map((ledger) => [ledger.path, readFileSync(path.join(env.root, ...ledger.path.split('/')))]));
  const result = await migrate(env);
  for (const [relative, bytes] of originals) {
    assert.deepEqual(readFileSync(path.join(env.root, ...relative.split('/'))), bytes, `${relative} at its usual path`);
    const legacy = LEGACY_LEDGERS.find((item) => item.path === relative)?.legacyPath as string;
    assert.deepEqual(readFileSync(path.join(env.root, ...legacy.split('/'))), bytes, `${legacy} kept`);
    assert.ok(result.projections?.written.includes(relative), `${relative} was written back`);
  }
  const after = await todaysAnswers(env);
  assert.deepEqual(after.decisions, before.decisions);
  assert.deepEqual(after.wargame, before.wargame);
  assert.deepEqual(after.calculator, before.calculator);
  assert.ok(after.calculator.verified.includes('fuel-phase-1'), 'the calculator record is still vouched for');
});

test('a project missing some ledgers imports only the ones present', async () => {
  const env = await freshEnv('partial');
  const world = worldOf(env);
  await writeBody(env.root, 'j5', CONOPS, CLEAN_BODY);
  must(await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: CONOPS, kind: 'plan', label: PUBLIC }, 'lead-planner'), 'propose');
  await otherLedgers(world, { wargame: true });
  const result = await migrate(env);
  assert.deepEqual(result.imported.map((item) => item.ledger), ['products', 'wargame']);
  const imports = importsOf(await projection(env));
  assert.deepEqual(imports.filter((item) => item.scope === 'whole').map((item) => item.ledger).sort(), ['products', 'wargame']);
  // The org/Public product's cell gets its products import; the wargame ledger goes whole into the org/Internal cell, which holds no product.
  assert.deepEqual(imports.filter((item) => item.scope === 'cell').map((item) => item.ledger), ['products']);
  assert.deepEqual(result.cells.map((item) => [item.label, item.legacy, item.products]), [[INTERNAL, undefined, []], [PUBLIC, undefined, [CONOPS]], [undefined, [PUBLIC], [CONOPS]]]);
  assert.deepEqual(result.moved, [LEGACY_LEDGERS[0].legacyPath, LEGACY_LEDGERS[3].legacyPath]);
  assert.equal(existsSync(path.join(env.root, LEGACY_DIR, 'ledger', 'decisions.jsonl')), false);
});

/** Changes one byte of the first ledger line, inside its signed payload (a digit of the genesis prev). */
async function breakOneByte(file: string): Promise<void> {
  const text = await readFile(file, 'utf8');
  const at = text.indexOf('"prev":"') + '"prev":"'.length + 5;
  assert.ok(at > 20 && text[at] === '0', 'the first line chains to the genesis');
  await writeFile(file, `${text.slice(0, at)}1${text.slice(at + 1)}`);
}

async function refusedWithNothingWritten(env: Env, options: MigrationOptions = CONVERT): Promise<MigrationRefused> {
  const files = tree(env.root, true);
  const keys = [...env.secrets.values.keys()].sort();
  const globalFiles = existsSync(env.global) ? readdirSync(env.global, { recursive: true }).map(String).sort() : [];
  const refused = await makeMultiUser(env.root, env.deps, options);
  assert.ok(isMigrationRefused(refused), 'the conversion is refused');
  assert.deepEqual(tree(env.root, true), files, 'no file written, moved or changed');
  assert.equal(existsSync(path.join(env.root, REPLICA_DIR)), false, 'no replica folder');
  assert.deepEqual([...env.secrets.values.keys()].sort(), keys, 'no secret storage key added');
  assert.deepEqual(existsSync(env.global) ? readdirSync(env.global, { recursive: true }).map(String).sort() : [], globalFiles, 'nothing pinned');
  return refused;
}

test('a broken product ledger (one changed byte) stops the conversion at verify: nothing written, today\'s wording with the Set Aside way out', async () => {
  const env = await cloneOf(await full(), 'broken-products');
  await breakOneByte(path.join(env.root, LEDGER_DIR, LEDGER_FILE));
  const refused = await refusedWithNothingWritten(env);
  assert.equal(refused.refused, 'ledger-broken');
  assert.equal(refused.ledger, 'products');
  // Today's host refuses a write to the same ledger with the same sentence.
  const world = worldOf(env);
  await writeBody(env.root, 'j5', 'annex-z', CLEAN_BODY);
  const today = await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: 'annex-z', kind: 'annex' }, 'lead-planner');
  assert.match(today.text, /^The staff ledger cannot be trusted from entry 1:/);
  assert.equal(refused.message, `${MIGRATION_REFUSALS['ledger-broken']} ${today.text}`);
  assert.match(refused.message, /Set Aside the Product Ledger/);
});

test('a broken decision log stops the conversion at verify too, with today\'s wording, and nothing is written', async () => {
  const env = await cloneOf(await full(), 'broken-decisions');
  await breakOneByte(path.join(env.root, LEDGER_DIR, 'decisions.jsonl'));
  const refused = await refusedWithNothingWritten(env);
  assert.equal(refused.refused, 'ledger-broken');
  assert.equal(refused.ledger, 'decisions');
  const today = await worldOf(env).host.signWatchDecision(worldOf(env).person(), { watch: 'watch-ford', decision: 'approved', wording: sha256('ford'), reasons: [] });
  assert.equal(today.ok, false);
  assert.equal(refused.message, `${MIGRATION_REFUSALS['ledger-broken']} ${today.ok ? '' : today.message}`);
});

test('a product ledger cut short against its head mark is refused with the Use This Branch\'s Ledger way out first', async () => {
  const env = await cloneOf(await full(), 'truncated');
  const file = path.join(env.root, LEDGER_DIR, LEDGER_FILE);
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  await writeFile(file, `${lines.slice(0, -1).join('\n')}\n`);
  const refused = await refusedWithNothingWritten(env);
  assert.match(refused.message, /Use This Branch's Ledger[\s\S]*Otherwise: A person can set it aside/);
});

test('observations are not imported, and registers, calculator records, gate reports, proposals and settings stay unchanged where they are', async () => {
  const env = await cloneOf(await full(), 'untouched');
  const ledgers = new Set(LEGACY_LEDGERS.map((item) => item.path));
  const productFiles = new Set([productPath('j5', CONOPS), productPath('j5', ANNEX)]);
  const kept = (files: Map<string, string>) => new Map([...files].filter(([file]) => !ledgers.has(file) && !productFiles.has(file) && !file.startsWith(LEGACY_DIR)));
  const before = kept(tree(env.root));
  assert.ok([...before.keys()].some((file) => file.startsWith('.planning/staff/calculator/')), 'a calculator record is among them');
  for (const relative of Object.keys(UNTOUCHED)) assert.ok(before.has(relative), relative);
  await migrate(env);
  assert.deepEqual(kept(tree(env.root)), before);
  // Only the conversion's own kinds are in the store: no observation, register or watch entry.
  const project = await opened(env);
  try {
    const kinds = new Set<string>();
    for (const kind of REPLICA_KINDS) await project.findOwn(kind, () => { kinds.add(kind); return false; });
    assert.deepEqual([...kinds].sort(), ['cell.create', 'doc.client', 'doc.update', 'member.update', 'product.create', 'project.genesis', 'project.import', 'roster.require', 'version.propose'], 'roster.require follows the genesis (Phase 33 D-08)');
  } finally {
    await project.close();
  }
});

test('a folder with no staff project is refused no-staff-project and nothing is written', async () => {
  const env = await freshEnv('empty');
  const refused = await makeMultiUser(env.root, env.deps);
  assert.ok(isMigrationRefused(refused));
  assert.equal(refused.refused, 'no-staff-project');
  assert.equal(existsSync(path.join(env.root, '.planning')), false);
});

// ---- Task 3: idempotent ----------------------------------------------------------------------------------------------------------------------------

// Fixed randomness for one conversion, so two installs that start from the same bytes write the same entries: every random draw is a hash of the place
// in the code that asks and how many times that place has asked. A place that asks a different number of times on two runs (a lock token, a temporary
// file name) cannot move another place's draws. X25519 and P-256 key pairs are made from such a draw as a seed, and so is the ML-KEM-768
// encapsulation of a cell-wrap/v2 wrap (33.2: new shared work starts post-quantum), whose randomness OpenSSL does not take from outside: nothing in a
// conversion opens its own wraps (it keeps the keys it made), so a drawn ciphertext and secret stand in for it here. The probe runs once before, on the
// real functions. The real functions are put back afterwards.
const nodeCrypto = require('node:crypto') as typeof import('node:crypto');
const realRandomBytes = nodeCrypto.randomBytes;
const realKeyPair = nodeCrypto.generateKeyPairSync;
const realEncapsulate = (nodeCrypto as unknown as { encapsulate: unknown }).encapsulate;
const P256_PKCS8_PREFIX = Buffer.from('3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420', 'hex');

async function withFixedRandomness<T>(work: () => Promise<T>): Promise<T> {
  clientReplicaFeatures();
  const counters = new Map<string, number>();
  const draw = (site: string, size: number): Buffer => {
    const count = counters.get(site) ?? 0;
    counters.set(site, count + 1);
    const out = Buffer.alloc(size);
    for (let block = 0, filled = 0; filled < size; block += 1, filled += 32) createHash('sha256').update(`${site}#${count}#${block}`).digest().copy(out, filled);
    return out;
  };
  const caller = (): string => (new Error().stack ?? '').split('\n')[3] ?? '';
  (nodeCrypto as { randomBytes: unknown }).randomBytes = (size: number, callback?: (error: Error | null, bytes: Buffer) => void) => {
    const bytes = draw(caller(), size);
    if (callback === undefined) return bytes;
    process.nextTick(callback, null, bytes);
    return undefined;
  };
  (nodeCrypto as { generateKeyPairSync: unknown }).generateKeyPairSync = (type: string, options?: unknown) => {
    if (type === 'ec' && (options as { namedCurve?: string } | undefined)?.namedCurve === 'prime256v1') {
      const privateKey = nodeCrypto.createPrivateKey({ key: Buffer.concat([P256_PKCS8_PREFIX, draw(caller(), 32)]), format: 'der', type: 'pkcs8' });
      return { privateKey, publicKey: nodeCrypto.createPublicKey(privateKey) };
    }
    if (type !== 'x25519') return (realKeyPair as (type: string, options?: unknown) => unknown)(type, options);
    const privateKey = x25519PrivateFromSeed(draw(caller(), 32));
    return { privateKey, publicKey: nodeCrypto.createPublicKey(privateKey) };
  };
  (nodeCrypto as unknown as { encapsulate: unknown }).encapsulate = () => ({ sharedKey: draw(caller(), 32), ciphertext: draw(caller(), 1088) });
  try {
    return await work();
  } finally {
    nodeCrypto.randomBytes = realRandomBytes;
    nodeCrypto.generateKeyPairSync = realKeyPair;
    (nodeCrypto as unknown as { encapsulate: unknown }).encapsulate = realEncapsulate;
  }
}

interface Capture {
  /** Every stored entry hash, by stream and writer, in seq order. */
  entries: string[];
  digests: Record<string, string>;
  proofs: number;
  imports: Array<[string, string, number, string]>;
  importEntries: number;
  cellCreates: number;
  files: Map<string, string>;
  replay: Array<[string, unknown]>;
}

async function capture(env: Env): Promise<Capture> {
  const store = await ReplicaStore.open(env.root, {
    secrets: env.secrets, signer: async () => env.signer, keyStatus: () => localKeyStatus(identityDir(env.global), env.secrets), now: () => new Date(NOW)
  });
  assert.ok(store instanceof ReplicaStore, 'the store opens');
  const entries = store.entries().map((entry) => ({ key: `${entry.header.stream}/${entry.header.writer}`, seq: entry.header.seq, hash: entryHash(entry.header) }))
    .sort((a, b) => (a.key === b.key ? a.seq - b.seq : a.key < b.key ? -1 : 1)).map((item) => `${item.key}/${item.seq}/${item.hash}`);
  const project = await opened(env);
  try {
    const { fold } = await project.state();
    let importEntries = 0;
    await project.findOwn('project.import', () => { importEntries += 1; return false; });
    const cellCreates = (await project.findOwnAll('cell.create', () => true)).length;
    const input = await projectionInputOf(project, env.deps);
    return {
      entries,
      digests: fold.digests,
      proofs: fold.proofs.length,
      imports: importsOf(input).map((item) => [item.ledger, item.legacyHead, item.count, item.entry]),
      importEntries,
      cellCreates,
      files: tree(env.root),
      replay: [...projectLedgerReplay(input).products.entries()].map(([name, state]) => [name, withoutImported(state)])
    };
  } finally {
    await project.close();
  }
}

/** One conversion run without a stop, from the full template, with fixed randomness. */
let uninterrupted: Promise<Capture> | undefined;
function reference(): Promise<Capture> {
  uninterrupted ??= (async () => {
    const env = await cloneOf(await full(), 'reference');
    await withFixedRandomness(() => migrate(env));
    return capture(env);
  })();
  return uninterrupted;
}

async function interruptedAfter(step: MigrationStep): Promise<void> {
  const env = await cloneOf(await full(), `stop-${step}`);
  await withFixedRandomness(async () => {
    const stopped = await migrate(env, { stopAfter: step });
    assert.equal(stopped.completed, step);
    const again = await makeMultiUser(env.root, env.deps, CONVERT);
    if (step === 'complete') {
      // A run after a finished conversion is refused already-shared, and writes nothing.
      assert.ok(isMigrationRefused(again) && again.refused === 'already-shared', 'refused already-shared');
    } else {
      assert.ok(!isMigrationRefused(again), isMigrationRefused(again) ? again.message : '');
      assert.equal(again.completed, 'complete');
    }
  });
  const got = await capture(env);
  const want = await reference();
  assert.deepEqual(got.entries, want.entries, 'the same entries, in the same order per writer');
  assert.deepEqual(got.digests, want.digests, 'the same fold digests');
  assert.deepEqual(got.files, want.files, 'the same files');
  assert.deepEqual(got.replay, want.replay, 'the same projected products');
  assert.deepEqual(got.imports, want.imports);
  assert.equal(got.proofs, 0, 'no equivocation proof');
  // Four whole imports and the products import of each of the two label cells, never a second of any.
  assert.equal(got.importEntries, 6, 'one import entry per ledger, scope and cell, never a second');
  assert.equal(got.cellCreates, 3, 'one cell.create per label and one for the legacy cell, never a second');
}

test('interrupted after verify, then run again: the same entries, digests and files as one run', async () => { await interruptedAfter('verify'); });
test('interrupted after genesis, then run again: the same entries, digests and files as one run', async () => { await interruptedAfter('genesis'); });
test('interrupted after cells, then run again: the same entries, digests and files as one run, and one cell.create per label', async () => { await interruptedAfter('cells'); });
test('interrupted after import, then run again: the same entries, digests and files as one run, and no second import', async () => { await interruptedAfter('import'); });
test('interrupted after reconstruct, then run again: the same entries, digests and files as one run', async () => { await interruptedAfter('reconstruct'); });
test('interrupted after move-legacy, then run again: the same entries, digests and files as one run', async () => { await interruptedAfter('move-legacy'); });
test('interrupted after projections, then run again: the same entries, digests and files as one run', async () => { await interruptedAfter('projections'); });
test('interrupted after complete, then run again: refused already-shared and the same entries, digests and files as one run', async () => { await interruptedAfter('complete'); });

test('the interruption tests cover every step, in the order the conversion runs them', () => {
  assert.deepEqual([...MIGRATION_STEPS], ['verify', 'genesis', 'cells', 'import', 'reconstruct', 'move-legacy', 'projections', 'complete']);
});

test('a project already made multi-user is refused already-shared and nothing changes', async () => {
  const env = await cloneOf(await full(), 'shared');
  await migrate(env);
  const files = tree(env.root, true);
  const secrets = new Map(env.secrets.values);
  const refused = await makeMultiUser(env.root, env.deps, CONVERT);
  assert.ok(isMigrationRefused(refused));
  assert.equal(refused.refused, 'already-shared');
  assert.equal(refused.message, MIGRATION_REFUSALS['already-shared']);
  assert.deepEqual(tree(env.root, true), files);
  assert.deepEqual(env.secrets.values, secrets);
});

test('a resumed move never writes over or duplicates a file already in the legacy folder, and a file a member put at a usual path is left as it is', async () => {
  const env = await cloneOf(await full(), 'resumed-move');
  await migrate(env, { stopAfter: 'move-legacy' });
  const legacy = new Map(LEGACY_LEDGERS.map((item) => [item.legacyPath, readFileSync(path.join(env.root, ...item.legacyPath.split('/')))]));
  // A member writes a decisions file at the usual path before the conversion is run again.
  const stray = path.join(env.root, ...LEGACY_LEDGERS[1].path.split('/'));
  await writeFile(stray, 'a member wrote this\n');
  const result = await migrate(env);
  for (const [relative, bytes] of legacy) assert.deepEqual(readFileSync(path.join(env.root, ...relative.split('/'))), bytes, `${relative} not written over`);
  const files = [...tree(env.root).keys()].filter((file) => file.startsWith(LEGACY_DIR)).sort();
  assert.deepEqual(files, LEGACY_LEDGERS.map((item) => item.legacyPath).sort(), 'one legacy file per ledger, no copies');
  assert.equal(readFileSync(stray, 'utf8'), 'a member wrote this\n', 'the member\'s file stands');
  assert.ok(result.projections?.left.some((item) => item.path === LEGACY_LEDGERS[1].path), 'and it is listed as left');
  assert.equal(existsSync(path.join(env.root, LEDGER_DIR, LEDGER_FILE)), false);
});

test('the legacy paths keep each ledger\'s path under .planning/staff inside the legacy folder', () => {
  assert.deepEqual(LEGACY_LEDGERS.map((item) => [item.ledger, item.path, item.legacyPath, item.marked]), [
    ['products', '.planning/staff/ledger/products.jsonl', '.planning/staff/legacy/ledger/products.jsonl', true],
    ['decisions', '.planning/staff/ledger/decisions.jsonl', '.planning/staff/legacy/ledger/decisions.jsonl', false],
    ['calculator', '.planning/staff/ledger/calculator.jsonl', '.planning/staff/legacy/ledger/calculator.jsonl', false],
    ['wargame', '.planning/staff/wargame/ledger.jsonl', '.planning/staff/legacy/wargame/ledger.jsonl', false]
  ]);
  assert.deepEqual(PASSTHROUGH_LEDGERS.map((item) => item.ledger), ['decisions', 'calculator', 'wargame']);
});

// ---- D-19: the lead converts only what the lead is declared cleared for -------------------------------------------------------------------------

/** A project of today's host holding the products given, each proposed with its label and pins, and the other ledgers asked for. */
async function labelled(label: string, products: ReadonlyArray<{ product: string; label?: string; dependsOn?: string[] }>, ledgers: { decisions?: boolean; calculator?: boolean; wargame?: boolean } = {}): Promise<Env> {
  const env = await freshEnv(label);
  const world = worldOf(env);
  for (const item of products) {
    await writeBody(env.root, 'j5', item.product, item.product === CONOPS ? CLEAN_BODY : ANNEX_BODY);
    const input = { product: item.product, kind: item.product === CONOPS ? 'plan' : 'annex', ...(item.label === undefined ? {} : { label: item.label }), ...(item.dependsOn === undefined ? {} : { dependsOn: item.dependsOn }) };
    must(await callTool(world, J5_TEAM, 'mcp__staff-products__propose', input, 'lead-planner'), `propose ${item.product}`);
  }
  await otherLedgers(world, ledgers);
  return env;
}

const NO_CLEARANCE: MigrationOptions = { name: NAME };

test('not-cleared-for-label: a product labelled nato/NATO Unclassified, with the lead declared org/Internal, stops the conversion at verify with the D-19 sentence naming it; nothing written; without it the project converts', async () => {
  // No label given for the concept of operations: today's host labels it org/Internal.
  const env = await labelled('label', [{ product: CONOPS }, { product: ANNEX, label: PUBLIC }, { product: 'annex-c', label: 'nato/NATO Unclassified' }]);
  // The command checks the ledgers with verifyLegacyLedgers before its dialog: the same refusal comes back there.
  const early = await verifyLegacyLedgers(env.root, env.deps, { leadClearance: LEAD_CLEARANCE });
  assert.ok(isMigrationRefused(early), 'refused before the dialog');
  const refused = await refusedWithNothingWritten(env);
  assert.deepEqual(early, refused);
  assert.equal(refused.refused, 'not-cleared-for-label');
  assert.equal(refused.message, `${MIGRATION_REFUSALS['not-cleared-for-label']} ${NOT_CLEARED_TEXT('nato/NATO Unclassified')} Products with that label: annex-c.`);
  assert.deepEqual(refused.labels, ['nato/NATO Unclassified']);
  assert.match(MIGRATION_REFUSALS['not-cleared-for-label'], /not made multi-user/);
  assert.match(MIGRATION_REFUSALS['not-cleared-for-label'], /Nothing was written\./);
  assert.ok(!refused.message.includes('\u2014'), 'no em-dash');
  // The base cell label check is gone (D-21): the base cell keeps its label for the roster only.
  assert.equal(Object.hasOwn(MIGRATION_REFUSALS, 'label-above-base'), false);
  assert.equal(BASE_CELL_LABEL, PUBLIC);

  const without = await labelled('label-without', [{ product: CONOPS }, { product: ANNEX, label: PUBLIC }]);
  const result = await migrate(without);
  assert.equal(result.completed, 'complete');
  assert.deepEqual(result.cells.map((item) => [item.label, item.legacy, item.products]), [
    [INTERNAL, undefined, [CONOPS]],
    [PUBLIC, undefined, [ANNEX]],
    [undefined, [INTERNAL, PUBLIC], [ANNEX, CONOPS]]
  ]);
});

test('not-cleared-for-label with no declared clearance: an all org/Public project converts into the org/Public cell; an org/Internal product or a calculator ledger is refused naming org/Internal (D-68)', async () => {
  const allPublic = await labelled('no-clearance-public', [{ product: CONOPS, label: PUBLIC }], { decisions: true });
  const converted = await makeMultiUser(allPublic.root, allPublic.deps, NO_CLEARANCE);
  assert.ok(!isMigrationRefused(converted), isMigrationRefused(converted) ? converted.message : '');
  assert.equal(converted.completed, 'complete');
  assert.deepEqual(converted.cells.map((item) => [item.label, item.legacy, item.products]), [[PUBLIC, undefined, [CONOPS]], [undefined, [PUBLIC], [CONOPS]]]);
  const project = await opened(allPublic);
  try {
    // No clearance was declared for the lead, so the only member.update is the role change.
    assert.equal((await placed(project, 'member.update')).length, 1);
  } finally {
    await project.close();
  }

  const internalProduct = await labelled('no-clearance-internal', [{ product: CONOPS }]);
  const refused = await refusedWithNothingWritten(internalProduct, NO_CLEARANCE);
  assert.equal(refused.refused, 'not-cleared-for-label');
  assert.equal(refused.message, `${MIGRATION_REFUSALS['not-cleared-for-label']} ${NOT_CLEARED_TEXT(INTERNAL)} Products with that label: ${CONOPS}.`);

  const calculator = await labelled('no-clearance-calculator', [{ product: CONOPS, label: PUBLIC }], { calculator: true });
  const byLedger = await refusedWithNothingWritten(calculator, NO_CLEARANCE);
  assert.equal(byLedger.refused, 'not-cleared-for-label');
  assert.ok(byLedger.message.startsWith(`${MIGRATION_REFUSALS['not-cleared-for-label']} ${NOT_CLEARED_TEXT(INTERNAL)} `), byLedger.message);
  assert.match(byLedger.message, /calculator/);
  assert.deepEqual(byLedger.labels, [INTERNAL]);
});

test('verifyLegacyLedgers returns the labels a conversion needs: the product labels, and org/Internal when a calculator or wargame ledger is present, sorted', async () => {
  const env = await cloneOf(await full(), 'labels');
  const verified = await verifyLegacyLedgers(env.root, env.deps, { leadClearance: LEAD_CLEARANCE });
  assert.ok(!isMigrationRefused(verified), isMigrationRefused(verified) ? verified.message : '');
  assert.deepEqual(verified.labels, [INTERNAL, PUBLIC]);
  const publicOnly = await labelled('labels-public', [{ product: CONOPS, label: PUBLIC }]);
  const plain = await verifyLegacyLedgers(publicOnly.root, publicOnly.deps);
  assert.ok(!isMigrationRefused(plain), isMigrationRefused(plain) ? plain.message : '');
  assert.deepEqual(plain.labels, [PUBLIC]);
  const wargame = await labelled('labels-wargame', [{ product: CONOPS, label: PUBLIC }], { wargame: true });
  const withGame = await verifyLegacyLedgers(wargame.root, wargame.deps, { leadClearance: LEAD_CLEARANCE });
  assert.ok(!isMigrationRefused(withGame), isMigrationRefused(withGame) ? withGame.message : '');
  assert.deepEqual(withGame.labels, [INTERNAL, PUBLIC]);
  assert.ok(isMigrationRefused(await verifyLegacyLedgers(wargame.root, wargame.deps)), 'with no declared clearance the wargame ledger is refused');
});

test('pins across cells: a product labelled org/Public that pins an org/Internal one keeps its live text only and is listed unversioned with pin-above-cell (D-18)', async () => {
  // The concept of operations has no label given: org/Internal. The annex, org/Public, pins it.
  const env = await labelled('pin-above', [{ product: CONOPS }, { product: ANNEX, label: PUBLIC, dependsOn: [`${CONOPS}@1`] }]);
  const result = await migrate(env);
  assert.deepEqual(result.products, [ANNEX, CONOPS]);
  assert.deepEqual(result.versions, [CONOPS]);
  assert.deepEqual(result.unversioned, [{ product: ANNEX, reason: 'pin-above-cell' }]);
  const input = await projection(env);
  assert.equal(foldTextOf(input, ANNEX), ANNEX_BODY, 'the live text is there');
  const annex = (input.fold.families.versions as ProductVersions[]).find((item) => item.product === ANNEX);
  assert.ok(annex !== undefined, 'the product is there');
  assert.deepEqual(annex.versions, [], 'with no version');
  assert.equal(annex.stream, result.cells.find((item) => item.label === PUBLIC)?.cell);
});

test('CR-02: a product whose ledger lines name a product above its cell keeps them out of its cell import and is listed withheld; the cell\'s other products keep theirs, the lead still sees it whole, and an org/Public member holds no line naming the higher product', async () => {
  // The annex (org/Public) depends on the concept of operations (org/Internal); the notice (org/Public) depends on nothing.
  const NOTICE = 'public-notice';
  const env = await labelled('names-above', [{ product: CONOPS }, { product: ANNEX, label: PUBLIC, dependsOn: [`${CONOPS}@1`] }, { product: NOTICE, label: PUBLIC }]);
  const original = readFileSync(path.join(env.root, LEDGER_DIR, LEDGER_FILE));
  const result = await migrate(env);
  const cell = (label: string): string => result.cells.find((item) => item.label === label)?.cell as string;
  assert.deepEqual(result.withheld, [{ product: ANNEX, cell: cell(PUBLIC), lines: linesFor(original, [ANNEX]).length, reason: 'names-above-cell' }]);
  assert.deepEqual(result.unversioned, [{ product: ANNEX, reason: 'pin-above-cell' }]);
  assert.deepEqual(result.scoped.map((item) => [item.cell, item.lines]).sort(), [[cell(INTERNAL), linesFor(original, [CONOPS]).length], [cell(PUBLIC), linesFor(original, [NOTICE]).length]].sort());

  const input = await projection(env);
  const scoped = importsOf(input).find((item) => item.scope === 'cell' && item.entry === result.scoped.find((found) => found.cell === cell(PUBLIC))?.entry);
  assert.ok(scoped !== undefined, 'the org/Public cell holds its products import');
  const bytes = importedFile(scoped, input.entries);
  assert.ok(bytes !== undefined, 'its file matches its hash');
  assert.equal(bytes.toString('utf8'), `${linesFor(original, [NOTICE]).join('\n')}\n`, 'only the notice\'s lines, byte for byte');
  assert.ok(!bytes.toString('utf8').includes(CONOPS), 'no line of the org/Public cell names the org/Internal product');
  // The lead holds the whole ledger in the legacy cell, so the annex is shown whole, its dependency included.
  const leadAnnex = projectLedgerReplay(input).products.get(ANNEX);
  assert.deepEqual(leadAnnex?.meta.dependsOn, [{ product: CONOPS, version: 1 }]);

  // A member cleared for org/Public: the notice is shown from the cell import with the lead's state; the annex is its live text only.
  const lead = await leadSeat(env);
  const plain = await bringIn(lead, 'names-above-public', 'P. Demo', orgClearance('Public'));
  await syncTo(lead, plain, [cell(PUBLIC)]);
  const seen = await projectionInputOf(plain.p, plain.at.deps);
  const replay = projectLedgerReplay(seen);
  assert.deepEqual([...replay.products.keys()], [NOTICE]);
  assert.equal(replay.products.get(NOTICE)?.tampered, undefined);
  assert.equal(foldTextOf(seen, ANNEX), ANNEX_BODY, 'the annex\'s live text is there');
  for (const [hash, entry] of seen.entries) {
    const data = entry.data as { file?: unknown };
    const file = typeof data?.file === 'string' ? Buffer.from(data.file, 'base64url').toString('utf8') : '';
    assert.ok(!`${JSON.stringify(entry.data)}\n${file}`.includes(CONOPS), `entry ${hash} names no org/Internal product`);
  }
});

/** The staff lead's seat over a converted project, for bringing people in with the label cell world. */
async function leadSeat(env: Env): Promise<Seat> {
  const p = keptProject(await ReplicaProject.open(env.root, env.deps));
  const at = { root: env.root, global: env.global, secrets: env.secrets, deps: env.deps, clock: { now: new Date(NOW) } } as unknown as Install;
  return { at, p, host: { project: p, deps: env.deps }, member: p.anchor.lead.member, writer: p.deviceWriter, results: [] };
}

test('legacy cell: a member admitted after the conversion with org/Restricted receives both org cells and not the legacy cell; one with org/Public receives only the org/Public cell', async () => {
  const env = await cloneOf(await full(), 'admitted');
  const result = await migrate(env);
  const cell = (label: string): string => result.cells.find((item) => item.label === label)?.cell as string;
  const legacy = result.cells.find((item) => item.legacy !== undefined)?.cell as string;
  const lead = await leadSeat(env);
  const restricted = await bringIn(lead, 'restricted', 'R. Demo', orgClearance('Restricted'));
  const held = async (seat: Seat): Promise<string[]> => (await seat.p.heldCells()).map((item) => item.cell).sort();
  assert.deepEqual(await held(restricted), [result.project as string, cell(INTERNAL), cell(PUBLIC)].sort());
  assert.ok(!(await held(restricted)).includes(legacy), 'the legacy cell is the lead\'s only');
  const plain = await bringIn(lead, 'public', 'P. Demo', orgClearance('Public'));
  assert.deepEqual(await held(plain), [result.project as string, cell(PUBLIC)].sort());
  // The lead holds every cell, the legacy cell included.
  assert.deepEqual(await held(lead), [result.project as string, cell(INTERNAL), cell(PUBLIC), legacy].sort());
});

test('scoped import: a member cleared for org/Internal, given the base and both org cells, projects both products with the lead\'s states from the cell imports and holds no whole import; an org/Public member sees only its product', async () => {
  const env = await cloneOf(await full(), 'member-view');
  const result = await migrate(env);
  const cell = (label: string): string => result.cells.find((item) => item.label === label)?.cell as string;
  const lead = await leadSeat(env);
  const leadReplay = projectLedgerReplay(await projectionInputOf(lead.p, env.deps));

  const member = await bringIn(lead, 'member-internal', 'M. Demo', orgClearance('Internal'));
  await syncTo(lead, member, [cell(PUBLIC), cell(INTERNAL)]);
  const input = await projectionInputOf(member.p, member.at.deps);
  const replay = projectLedgerReplay(input);
  assert.deepEqual([...replay.products.keys()].sort(), [ANNEX, CONOPS]);
  for (const product of [ANNEX, CONOPS]) {
    const state = replay.products.get(product) as ProjectedProductState;
    assert.equal(state.tampered, undefined, product);
    assert.deepEqual(withoutImported(state), withoutImported(leadReplay.products.get(product) as ProjectedProductState), `${product}: the lead's state`);
    const label = product === CONOPS ? PUBLIC : INTERNAL;
    assert.equal(state.imported?.entry, result.scoped.find((item) => item.cell === cell(label))?.entry, `${product} is shown from its cell's import`);
  }
  assert.equal((replay.products.get(CONOPS) as ProjectedProductState).imported?.approval, IMPORTED_APPROVAL_TEXT);
  assert.equal(importOf(input.fold, 'products'), undefined, 'the whole product ledger is in the legacy cell, which is not the member\'s');
  assert.equal(importOf(input.fold, 'decisions'), undefined);

  const plain = await bringIn(lead, 'member-public', 'P. Demo', orgClearance('Public'));
  await syncTo(lead, plain, [cell(PUBLIC)]);
  const seen = projectLedgerReplay(await projectionInputOf(plain.p, plain.at.deps));
  assert.deepEqual([...seen.products.keys()], [CONOPS], 'exactly the products of the cell it holds');
  assert.deepEqual(withoutImported(seen.products.get(CONOPS) as ProjectedProductState), withoutImported(leadReplay.products.get(CONOPS) as ProjectedProductState));
});

// ---- MJ-09: a product file edited while a conversion is half done ----------------------------------------------------------------------------------

function foldTextOf(input: ProjectionInput, product: string): string | undefined {
  return ((input.fold.families.doc as ProductTextOutput[] | undefined) ?? []).find((item) => item.product === product)?.text;
}

const EDIT = '\nAn edit made while the conversion was half done.\n';

test('MJ-09: interrupted after reconstruct, a product file edited, then run again: refused product-changed naming the file, nothing written, the edit kept; the text put back finishes', async () => {
  const env = await cloneOf(await full(), 'product-changed');
  const relative = productPath('j5', CONOPS);
  const file = path.join(env.root, relative);
  const original = readFileSync(file);
  await migrate(env, { stopAfter: 'reconstruct' });
  const edited = `${original.toString('utf8')}${EDIT}`;
  await writeFile(file, edited);
  const before = tree(env.root, true);

  const refused = await makeMultiUser(env.root, env.deps, CONVERT);
  assert.ok(isMigrationRefused(refused), isMigrationRefused(refused) ? '' : `not refused: ${refused.completed}`);
  assert.equal(refused.refused, 'product-changed');
  assert.equal(refused.file, relative);
  assert.equal(refused.message, `${MIGRATION_REFUSALS['product-changed']} The file: ${relative}.`);
  assert.deepEqual(tree(env.root, true), before, 'no entry written, no ledger moved, no file written');
  assert.equal(readFileSync(file, 'utf8'), edited, 'the edit is kept');
  assert.equal(await migrationComplete(env.root), false);
  const half = await projection(env);
  assert.equal(foldTextOf(half, CONOPS), original.toString('utf8').replace(/^---\n[\s\S]*?\n---\n/, ''), 'the shared text is still the text the first run read');

  // The text put back, the conversion finishes with the original text and file, and no fork.
  await writeFile(file, original);
  assert.equal((await migrate(env)).completed, 'complete');
  assert.deepEqual(readFileSync(file), original);
  const input = await projection(env);
  assert.equal(foldTextOf(input, CONOPS), original.toString('utf8').replace(/^---\n[\s\S]*?\n---\n/, ''));
  assert.equal(input.fold.proofs.length, 0);
});

test('MJ-09: a product file empty when its version was recorded and filled in before the rerun is refused product-changed too', async () => {
  const env = await freshEnv('product-filled');
  const world = worldOf(env);
  await writeBody(env.root, 'j5', ANNEX, '');
  must(await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: ANNEX, kind: 'annex', label: PUBLIC }, 'lead-planner'), 'propose an empty annex');
  const first = await migrate(env, { stopAfter: 'reconstruct' });
  assert.deepEqual(first.versions, [ANNEX], 'the empty text was recorded as the version');
  const file = path.join(env.root, productPath('j5', ANNEX));
  const filled = `${readFileSync(file, 'utf8')}${ANNEX_BODY}`;
  await writeFile(file, filled);
  const refused = await makeMultiUser(env.root, env.deps, CONVERT);
  assert.ok(isMigrationRefused(refused) && refused.refused === 'product-changed', 'refused product-changed');
  assert.equal(refused.file, productPath('j5', ANNEX));
  assert.equal(readFileSync(file, 'utf8'), filled);
  const input = await projection(env);
  assert.equal(foldTextOf(input, ANNEX) ?? '', '', 'no update was written for the new text');
});

test('MJ-09: a product file edited after reconstruct read it, before the projections step writes it, is never written over and the conversion does not finish', async () => {
  const env = await cloneOf(await full(), 'product-raced');
  const relative = productPath('j5', CONOPS);
  const file = path.join(env.root, relative);
  const original = readFileSync(file);
  const edited = `${original.toString('utf8')}${EDIT}`;
  // The edit lands between the reconstruct step and the projections step of one run.
  const projectionModule = require('../staff/replica/projection') as { writeProjections: (...args: unknown[]) => Promise<unknown> };
  const real = projectionModule.writeProjections;
  projectionModule.writeProjections = async (...args: unknown[]) => { await writeFile(file, edited); return real(...args); };
  let refused: MigrationResult | MigrationRefused;
  try {
    refused = await makeMultiUser(env.root, env.deps, CONVERT);
  } finally {
    projectionModule.writeProjections = real;
  }
  assert.ok(isMigrationRefused(refused), isMigrationRefused(refused) ? '' : `not refused: ${refused.completed}`);
  assert.equal(refused.refused, 'product-changed');
  assert.equal(refused.file, relative);
  assert.equal(readFileSync(file, 'utf8'), edited, 'the edit is not written over');
  assert.equal(await migrationComplete(env.root), false, 'the conversion did not finish');
  assert.match(PROJECTION_LEFT_REASONS['text-changed'], /not the text in the shared history/);
  assert.match(PROJECTION_LEFT_REASONS['text-changed'], /left as it is with the edit in it/);

  // Run again: the reconstruct step names the file before writing anything; with the text put back it finishes.
  const again = await makeMultiUser(env.root, env.deps, CONVERT);
  assert.ok(isMigrationRefused(again) && again.refused === 'product-changed' && again.file === relative, 'refused again, naming the file');
  await writeFile(file, original);
  assert.equal((await migrate(env)).completed, 'complete');
  assert.deepEqual(readFileSync(file), original);
});
