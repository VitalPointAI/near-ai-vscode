// The staff host in a shared project (plan 31-21; MUS-06, D-28, D-29, D-33, D-37). A staff project built by today's single-machine host is made
// multi-user (31-19), then a new StaffHost over the same folder reads it: the products come from the fold through the projection and equal what today's
// host read before (replay, productState, the registry and the decision queue), and the header tamper check compares product files with the projected
// state. Every step that would write today's single-machine ledgers or staff files is refused with SHARED_PROJECT_REFUSAL and changes no file and no
// secret, while the reads of the decision log, the wargame ledger, the event log and the logistics files still answer.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { StaffSectionId } from '../domain/staff/doctrine';
import type { PlanningFactor } from '../domain/staff/logistics';
import { REPLICA_PROJECT_FILE, SHARED_PROJECT_REFUSAL } from '../domain/staff/multiUser';
import type { PersonActor } from '../domain/staff/release';
import type { DeviceIdentity } from '../team/identity';
import { isMigrationRefused, ledgerHeadKey, makeMultiUser } from '../staff/replica/migrate';
import type { MigrationDeps } from '../staff/replica/migrate';
import type { ProjectedProductState } from '../staff/replica/projection';
import { ReplicaProject } from '../staff/replica/replicaProject';
import { productPath, SHARED_PROJECT_UNAVAILABLE, StaffHost } from '../staff/staffHost';
import type { StaffCaller, StaffTeamInfo } from '../staff/staffHost';
import { callLogistics, callTool, CLEAN_BODY, hashIn, J5_TEAM, memorySecrets, trusting, writeBody, writeFactors } from './helpers/staffFixtures';
import type { StaffWorld } from './helpers/staffFixtures';

const NOW = '2026-11-20T10:00:00.000Z';
const CONOPS = 'concept-of-operations';
const ANNEX = 'annex-b';
const ANNEX_C = 'annex-c';
const ANNEX_BODY = '# Annex B\n\nThe force moves in two phases, as the concept of operations sets out.\n';
const DECISION_ROLE = 'commander';
const OPTIONS = [{ label: 'COA 1', risk: 'Moderate risk to the flank' }, { label: 'COA 2', risk: 'Slower, but the flank is covered' }];
const DISSENT = ['The red team holds COA 2 is safer.'];
const J4_TEAM: StaffTeamInfo = { slug: 'j4-logistics', section: 'j4', sectionLead: 'j4-director', members: ['j4-director', 'log-plans-officer', 'jloc-chief', 'release-guard'] };
const FUEL: PlanningFactor = { id: 'fuel-cargo-truck', what: 'Fuel for one cargo truck', rate: 250, unit: 'litres', per: 'vehicle per day', enteredBy: 'A. Demo' };
const FUEL_CALC = { id: 'fuel-phase-1', title: 'Class III (bulk) for phase 1', lines: [{ factor: 'fuel-cargo-truck', count: 40, item: 'cargo trucks' }], days: 3, onHand: 21000 };
const TURN = { coa: 'coa-a', enemyCoa: 'mlcoa', turn: 1, phase: 'action', hHourOffsetMinutes: 0, moves: [], results: [], decisionPoints: [] };
const LOGSTAT = { id: 'bn1-181200z', unit: '1 Bn', reportedAt: '2026-11-18T12:00:00Z', lines: [{ commodity: 'Class III (bulk)', uom: 'litres', onHand: 21000, received: 0, consumed: 0, capacity: 30000, forecast: 21500 }] };

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

/**
 * A host over the env's project, signed by the env's device, its head kept in the env's secrets. `shared` gives it the replica storage the extension
 * gives it (31-23), and a clock after the conversion; without it, it is today's host exactly as the extension makes it now.
 */
function worldOf(env: Env, shared = false): StaffWorld {
  const clock = { now: Date.parse(shared ? '2026-11-21T08:00:00.000Z' : '2026-11-18T12:00:00.000Z') };
  const make = (): StaffHost => new StaffHost({
    root: env.root, signer: async () => env.signer, keyStatus: async () => trusting(env.signer), headStore: env.secrets, now: () => { clock.now += 1000; return clock.now; },
    ...(shared ? { replica: { globalStorageDir: env.global } } : {})
  });
  const world: StaffWorld = {
    root: env.root, signer: env.signer, clock, host: make(), headStore: env.secrets,
    reload: () => { world.host = make(); return world.host; },
    person: (name = 'A. Demo', role = DECISION_ROLE): PersonActor => ({ kind: 'person', name, role, deviceFingerprint: env.signer.fingerprint })
  };
  return world;
}

async function freshEnv(label: string): Promise<Env> {
  const base = mkdtempSync(path.join(tmpdir(), `near-ai-hostmode-${label}-`));
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

/** The template: three products in three states (released, draft with a pin, awaiting a decision), a watch decision, a calculator record, a wargame turn and a LOGSTAT report. */
let template: Promise<Env> | undefined;
function full(): Promise<Env> {
  template ??= (async () => {
    const env = await freshEnv('template');
    const world = worldOf(env);
    await writeBody(world.root, 'j5', CONOPS, CLEAN_BODY);
    const hash = hashIn(must(await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: CONOPS, kind: 'plan' }, 'lead-planner'), 'propose'));
    must(await callTool(world, J5_TEAM, 'mcp__staff-products__verdict', { product: CONOPS, gate: 'guard', verdict: 'CLEARED', hash }, 'release-guard'), 'verdict');
    must(await callTool(world, J5_TEAM, 'mcp__staff-products__submit', { product: CONOPS, decisionFor: DECISION_ROLE, options: OPTIONS, dissent: DISSENT }, 'lead-planner'), 'submit');
    for (const action of ['approve', 'release'] as const) {
      const decided = await world.host.decide(world.person(), { product: CONOPS, action, hash });
      assert.ok(decided.ok, decided.ok ? '' : decided.message);
    }
    await writeBody(world.root, 'j5', ANNEX, ANNEX_BODY);
    must(await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: ANNEX, kind: 'annex', dependsOn: [`${CONOPS}@1`] }, 'lead-planner'), 'propose annex');
    await writeBody(world.root, 'j5', ANNEX_C, CLEAN_BODY.replace('# Concept of operations', '# Annex C'));
    const hashC = hashIn(must(await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: ANNEX_C, kind: 'annex' }, 'lead-planner'), 'propose annex c'));
    must(await callTool(world, J5_TEAM, 'mcp__staff-products__verdict', { product: ANNEX_C, gate: 'guard', verdict: 'CLEARED', hash: hashC }, 'release-guard'), 'verdict c');
    must(await callTool(world, J5_TEAM, 'mcp__staff-products__submit', { product: ANNEX_C, decisionFor: DECISION_ROLE, options: OPTIONS, dissent: DISSENT }, 'lead-planner'), 'submit c');
    const watch = await world.host.signWatchDecision(world.person(), { watch: 'watch-bridge', decision: 'approved', wording: createHash('sha256').update('watch the bridge').digest('hex'), reasons: [] });
    assert.ok(watch.ok, watch.ok ? '' : watch.message);
    await writeFactors(world.root, [FUEL]);
    must(await callLogistics(world, J4_TEAM, 'calc_run', FUEL_CALC, 'log-plans-officer'), 'calc_run');
    must(await callTool(world, J5_TEAM, 'mcp__staff-products__wargame', { action: 'record', phase: TURN }, 'plans-writer'), 'wargame');
    const report = await world.host.logistics().submitReport('jloc-chief', LOGSTAT);
    assert.ok(report.ok, report.ok ? '' : report.message);
    return env;
  })();
  return template;
}

/** A copy of the template install: the same project bytes, the same device and keys, the head mark under the copy's own key. */
async function cloneOf(source: Env, label: string): Promise<Env> {
  const base = mkdtempSync(path.join(tmpdir(), `near-ai-hostmode-${label}-`));
  const root = path.join(base, 'project');
  const global = path.join(base, 'global');
  cpSync(source.root, root, { recursive: true });
  cpSync(source.global, global, { recursive: true });
  const secrets = memorySecrets();
  const markKey = ledgerHeadKey(source.root);
  for (const [key, value] of source.secrets.values) secrets.values.set(key === markKey ? ledgerHeadKey(root) : key, value);
  return envAt(root, global, secrets, source.signer);
}

async function migrate(env: Env): Promise<void> {
  const result = await makeMultiUser(env.root, env.deps, { name: 'Exercise Northwind' });
  assert.ok(!isMigrationRefused(result), isMigrationRefused(result) ? result.message : '');
}

function withoutImported<T>(state: T): T {
  if (state === undefined || state === null) return state;
  const { imported: _imported, ...rest } = state as unknown as ProjectedProductState;
  return rest as T;
}

const PRODUCTS = [CONOPS, ANNEX, ANNEX_C];

/** What today's readers of staff products see: the replay's products, each product's state, and the Staff Room's registry and decision queue. */
async function productAnswers(host: StaffHost) {
  const replay = await host.replay();
  const snapshot = await host.snapshot();
  const states: Record<string, unknown> = {};
  for (const product of PRODUCTS) states[product] = await host.productState(product);
  return {
    broken: replay.broken,
    products: new Map([...replay.products.entries()].map(([name, state]) => [name, withoutImported(state)])),
    states,
    registry: snapshot.registry,
    decisions: snapshot.decisions,
    ledgerProblem: snapshot.ledgerProblem
  };
}

const caller = (root: string, member = 'lead-planner', team: StaffTeamInfo = J5_TEAM): StaffCaller => ({ member, run: 'run-hostmode', root, team });

// ---- Task 1: a migrated project's products are read from the fold and look the same ---------------------------------------------------------------

test('tracer: after Make This Staff Project Multi-User, a new host reads replay, productState, the registry and the decision queue exactly as today\'s host did', async () => {
  const env = await cloneOf(await full(), 'tracer');
  const before = await productAnswers(worldOf(env).host);
  assert.equal(before.broken, undefined);
  assert.deepEqual([...before.products.keys()].sort(), [...PRODUCTS].sort());
  assert.deepEqual(PRODUCTS.map((product) => (before.states[product] as { state: string }).state), ['released', 'draft', 'awaiting-decision'], 'three products in three states');

  await migrate(env);
  const host = worldOf(env, true).host;
  const after = await productAnswers(host);
  assert.equal(after.broken, undefined, 'the projection is never broken');
  assert.equal(after.ledgerProblem, undefined);
  assert.deepEqual(after.products, before.products, 'replay().products: every product, its history, gates, request and approvals');
  assert.deepEqual(after.states, before.states, 'productState() for each product');
  assert.deepEqual(after.registry, before.registry, 'the Staff Room registry, including the file checks against the projected state');
  assert.deepEqual(after.decisions, before.decisions, 'the decision queue, with the options and dissent of the open request');
  // The approved product carries the imported approval wording beside today's state (D-32), for the screens that show it.
  const conops = (await host.replay()).products.get(CONOPS) as ProjectedProductState;
  assert.ok(conops.imported?.approval !== undefined, 'an approved imported product says how its approval came');
  // A second read reuses the same project and fold (no refold when nothing changed).
  assert.deepEqual((await productAnswers(host)).products, before.products);
  await host.close();
});

test('isSharedProject is a stat of the replica project file: false before the conversion, true after, and it loads nothing on its own', async () => {
  const env = await cloneOf(await full(), 'shared-check');
  const host = worldOf(env).host;
  assert.equal(await host.isSharedProject(), false);
  assert.equal(existsSync(path.join(env.root, REPLICA_PROJECT_FILE)), false, 'asking never makes the file');
  await migrate(env);
  assert.equal(await host.isSharedProject(), true, 'the same host object sees the change: the check is never kept for the process');
  assert.equal(await worldOf(env, true).host.isSharedProject(), true);
});

/** Edits the staff header of a product file by hand: the state it claims. */
function editHeader(root: string, section: StaffSectionId, product: string, from: string, to: string): void {
  const file = path.join(root, productPath(section, product));
  const text = readFileSync(file, 'utf8');
  assert.ok(text.includes(from), `${product}'s header holds ${from}`);
  writeFileSync(file, text.replace(from, to));
}

test('a product header edited by hand after the conversion is reported with the same tamper reason today\'s host gives for the same edit', async () => {
  const source = await full();
  const today = await cloneOf(source, 'tamper-today');
  const shared = await cloneOf(source, 'tamper-shared');
  await migrate(shared);
  for (const env of [today, shared]) {
    editHeader(env.root, 'j5', CONOPS, 'state: released', 'state: approved');
    editHeader(env.root, 'j5', ANNEX, 'version: 1', 'version: 4');
  }
  const todayHost = worldOf(today).host;
  const sharedHost = worldOf(shared, true).host;
  const todaySnapshot = await todayHost.snapshot();
  const sharedSnapshot = await sharedHost.snapshot();
  for (const product of [CONOPS, ANNEX]) {
    const expected = todaySnapshot.registry.find((view) => view.product === product);
    const found = sharedSnapshot.registry.find((view) => view.product === product);
    assert.ok(expected?.tampered !== undefined, `today's host reports ${product}'s edited header`);
    assert.equal(found?.tampered, expected.tampered, `${product}: the same tamper reason`);
    assert.deepEqual(found, expected, `${product}: the same view`);
  }
  // The status a member reads says the same, and a read records nothing.
  const todayStatus = await todayHost.status(caller(today.root), CONOPS);
  const sharedStatus = await sharedHost.status(caller(shared.root), CONOPS);
  assert.deepEqual(sharedStatus, todayStatus);
  await sharedHost.close();
});
