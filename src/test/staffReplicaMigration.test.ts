// Make This Staff Project Multi-User (plan 31-19; MUS-06, D-28 to D-34, D-46). A staff project built by today's single-machine host (signed product
// ledger with its head mark, decision log, calculator ledger, wargame ledger, product files and the files no replica kind covers yet) is converted, and
// the tests check: verify first, import whole with the right head, re-verify every import with today's verifiers forever, reconstruct products, files
// as projections equal to today's, nothing deleted, and a conversion interrupted after any step reaching exactly the same entries, digests and files.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { x25519PrivateFromSeed } from '../domain/replica/cellKeys';
import { entryHash } from '../domain/replica/entry';
import { REPLICA_KINDS } from '../domain/replica/kinds';
import type { ProjectOutput } from '../domain/replica/projectFold';
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
import { LEGACY_LEDGERS, MIGRATION_REFUSALS, MIGRATION_STEPS, PASSTHROUGH_LEDGERS, isMigrationRefused, ledgerHeadKey, makeMultiUser, projectionInputOf } from '../staff/replica/migrate';
import type { MigrationDeps, MigrationOptions, MigrationRefused, MigrationResult, MigrationStep } from '../staff/replica/migrate';
import { IMPORTED_APPROVAL_TEXT, importedFile, ledgerLinesOf, projectLedgerReplay, projectProductFile } from '../staff/replica/projection';
import type { ProjectedProductState, ProjectionInput } from '../staff/replica/projection';
import { ReplicaProject, isProjectRefused } from '../staff/replica/replicaProject';
import { ReplicaStore } from '../staff/replica/store';
import { LEDGER_DIR, LEDGER_FILE, StaffHost, WARGAME_DIR, WARGAME_FILE, productPath } from '../staff/staffHost';
import type { StaffTeamInfo } from '../staff/staffHost';
import { callLogistics, callTool, CLEAN_BODY, hashIn, J5_TEAM, memorySecrets, trusting, writeBody, writeFactors } from './helpers/staffFixtures';
import type { StaffWorld } from './helpers/staffFixtures';

const NOW = '2026-11-20T10:00:00.000Z';
const NAME = 'Exercise Northwind';
const CONOPS = 'concept-of-operations';
const ANNEX = 'annex-b';
const ANNEX_BODY = '# Annex B\n\nThe force moves in two phases, as the concept of operations sets out.\n';
const DECISION_ROLE = 'commander';
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
  const hash = hashIn(must(await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: CONOPS, kind: 'plan' }, 'lead-planner'), 'propose'));
  must(await callTool(world, J5_TEAM, 'mcp__staff-products__verdict', { product: CONOPS, gate: 'guard', verdict: 'CLEARED', hash }, 'release-guard'), 'verdict');
  must(await callTool(world, J5_TEAM, 'mcp__staff-products__submit', { product: CONOPS, decisionFor: DECISION_ROLE, options: OPTIONS, dissent: DISSENT }, 'lead-planner'), 'submit');
  const approved = await world.host.decide(world.person(), { product: CONOPS, action: 'approve', hash });
  assert.ok(approved.ok, approved.ok ? '' : approved.message);
  const released = await world.host.decide(world.person(), { product: CONOPS, action: 'release', hash });
  assert.ok(released.ok, released.ok ? '' : released.message);
}

/** A second product pinned to the released version of the first. */
async function pinnedProduct(world: StaffWorld): Promise<void> {
  await writeBody(world.root, 'j5', ANNEX, ANNEX_BODY);
  must(await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: ANNEX, kind: 'annex', dependsOn: [`${CONOPS}@1`] }, 'lead-planner'), 'propose annex');
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
  const result = await makeMultiUser(env.root, env.deps, { name: NAME, ...options });
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

test('tracer: the store holds the genesis, one products import with today\'s head, count, mark and file hash, the reconstruct entries, and the original in the legacy folder', async () => {
  const env = await cloneOf(await full(), 'tracer');
  const before = await todaysAnswers(env);
  const original = readFileSync(path.join(env.root, LEDGER_DIR, LEDGER_FILE));
  const mark = env.secrets.values.get(ledgerHeadKey(env.root));
  assert.ok(mark !== undefined, 'today\'s host keeps a head mark for the product ledger');

  const result = await migrate(env);
  assert.equal(result.completed, 'complete');
  const input = await projection(env);
  const project = (input.fold.families.project as ProjectOutput)[0];
  assert.ok(project.genesis !== null, 'the genesis is in the store');
  const products = importsOf(input).find((item) => item.ledger === 'products');
  assert.ok(products !== undefined);
  assert.equal(products.legacyHead, before.replay.head);
  assert.equal(products.count, before.replay.entries);
  assert.equal(products.marked, true);
  assert.equal(products.fileHash, sha256(original));
  assert.equal((input.entries.get(products.entry)?.data as { mark?: string }).mark, mark, 'the signed head mark is carried as it is');

  // Every reconstruct entry cites the products import.
  const reconstructKinds = ['member.update', 'product.create', 'doc.client', 'doc.update', 'version.propose'];
  const rebuilt = [...input.entries.values()].filter((entry) => reconstructKinds.includes(entry.kind));
  assert.ok(rebuilt.length >= 9, `the reconstruct entries are in the store (${rebuilt.length})`);
  for (const entry of rebuilt) assert.ok(entry.deps?.includes(products.entry), `${entry.kind} cites the import`);

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
  assert.equal(IMPORTED_APPROVAL_TEXT, 'approved on this machine before the project became multi-user, verified at import by the staff lead');
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
});

test('the result lists the notices every multi-user result shows, the imports and the moved files', async () => {
  const env = await cloneOf(await full(), 'notices');
  const result = await migrate(env);
  assert.deepEqual(result.notices, multiUserNoticeLines());
  assert.deepEqual(result.imported.map((item) => item.ledger), ['products', 'decisions', 'calculator', 'wargame']);
  assert.deepEqual(result.moved, LEGACY_LEDGERS.map((item) => item.legacyPath));
  assert.deepEqual(result.products, [ANNEX, CONOPS]);
});
