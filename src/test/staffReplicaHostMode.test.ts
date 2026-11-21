// The staff host in a shared project (plan 31-21; MUS-06, D-28, D-29, D-33, D-37). A staff project built by today's single-machine host is made
// multi-user (31-19), then a new StaffHost over the same folder reads it: the products come from the fold through the projection and equal what today's
// host read before (replay, productState, the registry and the decision queue), and the header tamper check compares product files with the projected
// state. Every step that would write today's single-machine ledgers or staff files is refused with SHARED_PROJECT_REFUSAL and changes no file and no
// secret, while the reads of the decision log, the wargame ledger, the event log and the logistics files still answer.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test, { mock } from 'node:test';
import type { StaffSectionId } from '../domain/staff/doctrine';
import type { PlanningFactor } from '../domain/staff/logistics';
import { REPLICA_DIR, REPLICA_PROJECT_FILE, SHARED_PROJECT_REFUSAL, sharedCheckFailedText } from '../domain/staff/multiUser';
import type { PersonActor } from '../domain/staff/release';
import type { DeviceIdentity } from '../team/identity';
import { isMigrationRefused, ledgerHeadKey, makeMultiUser } from '../staff/replica/migrate';
import type { MigrationDeps } from '../staff/replica/migrate';
import type { ProjectedProductState } from '../staff/replica/projection';
import { isProjectRefused, ReplicaProject } from '../staff/replica/replicaProject';
import type { ReplicaProjectDeps } from '../staff/replica/replicaProject';
import { STORE_REFUSALS } from '../staff/replica/store';
import { markKey } from '../staff/replica/marks';
import { cellOrderHook } from '../staff/replica/membership';
import { cellLabelTexts } from '../staff/replica/labelCells';
import { bringIn, orgClearance, syncTo } from './helpers/labelCellWorld';
import type { Seat as CellSeat } from './helpers/labelCellWorld';
import { memberAt } from '../domain/replica/rosterMembers';
import { registerSchema, renderRegisterBody } from '../domain/staff/registers';
import type { StaffEvent } from '../domain/staff/events';
import type { FeedEvent } from '../domain/staff/obs/events';
import type { ValidationLogEntry } from '../domain/staff/logistics';
import { EVENTS_FILE, LEDGER_DIR, productPath, SHARED_PROJECT_UNAVAILABLE, SharedProjectError, StaffHost } from '../staff/staffHost';
import type { StaffCaller, StaffResult, StaffTeamInfo } from '../staff/staffHost';
import { callLogistics, callTool, CLEAN_BODY, hashIn, J3_TEAM, J5_TEAM, memorySecrets, trusting, writeBody, writeFactors } from './helpers/staffFixtures';
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
    // Labelled org/Public: Make Multi-User puts it into the org/Public cell, which the lead's declared clearance (org/Internal) covers (D-15, D-19).
    const hash = hashIn(must(await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: CONOPS, kind: 'plan', label: 'org/Public' }, 'lead-planner'), 'propose'));
    must(await callTool(world, J5_TEAM, 'mcp__staff-products__verdict', { product: CONOPS, gate: 'guard', verdict: 'CLEARED', hash }, 'release-guard'), 'verdict');
    must(await callTool(world, J5_TEAM, 'mcp__staff-products__submit', { product: CONOPS, decisionFor: DECISION_ROLE, options: OPTIONS, dissent: DISSENT }, 'lead-planner'), 'submit');
    for (const action of ['approve', 'release'] as const) {
      const decided = await world.host.decide(world.person(), { product: CONOPS, action, hash });
      assert.ok(decided.ok, decided.ok ? '' : decided.message);
    }
    await writeBody(world.root, 'j5', ANNEX, ANNEX_BODY);
    must(await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: ANNEX, kind: 'annex', label: 'org/Public', dependsOn: [`${CONOPS}@1`] }, 'lead-planner'), 'propose annex');
    await writeBody(world.root, 'j5', ANNEX_C, CLEAN_BODY.replace('# Concept of operations', '# Annex C'));
    const hashC = hashIn(must(await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: ANNEX_C, kind: 'annex', label: 'org/Public' }, 'lead-planner'), 'propose annex c'));
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
  const result = await makeMultiUser(env.root, env.deps, { name: 'Exercise Northwind' , leadClearance: { scale: 'org', level: 'Internal', compartments: [], releasability: [] } });
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

// ---- Task 2: every writing step in a shared project is refused with one plain sentence and changes no file -------------------------------------------

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

/** Every file under .planning/staff, the replica store included, by path, with the sha256 of its bytes. */
function staffTree(root: string, skip?: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      if (skip !== undefined && file === path.join(root, '.planning', 'staff', skip)) continue;
      if (statSync(file).isDirectory()) walk(file);
      else out.set(path.relative(root, file).split(path.sep).join('/'), sha256(readFileSync(file)));
    }
  };
  walk(path.join(root, '.planning', 'staff'));
  return out;
}

/** The SecretStorage key set, each with the hash of its value. */
function secretState(secrets: Secrets): string[] {
  return [...secrets.values.entries()].map(([key, value]) => `${key}=${sha256(value)}`).sort();
}

/** What a refused write gives: a StaffResult or CalcResult with the message, or a thrown SharedProjectError. */
async function refusalOf(call: () => Promise<unknown>): Promise<string> {
  try {
    const result = await call();
    assert.ok(typeof result === 'object' && result !== null && (result as { ok?: unknown }).ok === false, `refused, not ${JSON.stringify(result)}`);
    return (result as { message: string }).message;
  } catch (error) {
    assert.ok(error instanceof SharedProjectError, `a SharedProjectError, not ${String(error)}`);
    assert.equal(error.refusal, SHARED_PROJECT_REFUSAL);
    return error.message;
  }
}

const AT = '2026-11-21T09:00:00.000Z';

/** Every writing method of the staff host and the logistics host, each called with arguments today's host would act on. */
function writingCalls(world: StaffWorld, hashes: { annex: string; annexC: string }): Array<[string, () => Promise<unknown>]> {
  const host = world.host;
  const root = world.root;
  const person = world.person();
  const logistics = host.logistics();
  let built = 0;
  return [
    ['setAsideLedger', () => host.setAsideLedger()],
    ['adoptBranchLedger', () => host.adoptBranchLedger(person, { head: 'a'.repeat(64), entries: 1 })],
    ['decidePir', () => host.decidePir(person, { pir: 'PIR-1', decision: 'approved' })],
    ['signWatchDecision', () => host.signWatchDecision(person, { watch: 'watch-ford', decision: 'approved', wording: sha256('watch the ford'), reasons: [] })],
    ['emit', () => host.emit([{ type: 'staff.step.entered', run: 'run-hostmode', at: AT, section: 'j5', step: 2, stepName: null } as StaffEvent])],
    ['record', () => host.record({ type: 'staff.lane.started', run: 'run-hostmode', at: AT, section: 'j5', member: 'lead-planner' } as StaffEvent)],
    ['recordFeed', () => host.recordFeed([{ type: 'feed.source.state', run: 'run-hostmode', at: AT, feed: 'feed-a', from: null, to: 'proposed', simulated: true } as unknown as FeedEvent])],
    ['propose', () => host.propose(caller(root), { product: ANNEX, kind: 'annex' })],
    ['verdict', () => host.verdict(caller(root, 'release-guard'), { product: ANNEX, gate: 'guard', verdict: 'CLEARED', hash: hashes.annex, reasons: [] })],
    ['submit', () => host.submit(caller(root), { product: ANNEX, decisionFor: DECISION_ROLE, options: OPTIONS, dissent: DISSENT })],
    ['withdraw', () => host.withdraw(caller(root), { product: ANNEX, reason: 'Overtaken by events.' })],
    ['enterStep', () => host.enterStep(caller(root), { step: 2 })],
    ['registerWrite', () => host.registerWrite(caller(root, 'liaison-coordinator', J3_TEAM), { register: 'rfi-tracker', rows: [{ id: 'RFI-1', from: 'j5', to: 'j2', question: 'Bridge class?', suspense: '2026-11-22T12:00:00Z', status: 'open' }] })],
    ['registerPropose', () => host.registerPropose(caller(root, 'plans-writer'), { register: 'rfi-tracker', rows: [{ id: 'RFI-2', from: 'j5', to: 'j2', question: 'Ford depth?', suspense: '2026-11-22T12:00:00Z', status: 'open' }] })],
    ['ccirTrigger', () => host.ccirTrigger(caller(root, 'joc-chief', J3_TEAM), { ccir: 'F1', report: 'Bridge reported down at 0400' })],
    ['wargameRecord', () => host.wargameRecord(caller(root, 'plans-writer'), { ...TURN, phase: 'reaction' })],
    ['wargameDerive', () => host.wargameDerive(caller(root, 'plans-writer'))],
    ['decide', () => host.decide(person, { product: ANNEX_C, action: 'approve', hash: hashes.annexC })],
    ['logistics.writeRecord', () => logistics.writeRecord('log-plans-officer', 'run-hostmode', () => { built += 1; return { ok: false, message: `build was called ${built} times` }; })],
    ['logistics.submitReport', () => logistics.submitReport('jloc-chief', { ...LOGSTAT, id: 'bn1-191200z', reportedAt: '2026-11-19T12:00:00Z' })],
    ['logistics.appendValidation', () => logistics.appendValidation([{ report: LOGSTAT.id, passed: true, findings: [], hash: 'b'.repeat(64), at: AT, by: 'logstat-analyst' } as unknown as ValidationLogEntry])]
  ];
}

test('every writing method, in a shared project, is refused with SHARED_PROJECT_REFUSAL and changes no file under .planning/staff and no secret', async () => {
  const env = await cloneOf(await full(), 'writes');
  await migrate(env);
  const world = worldOf(env, true);
  // Read first, as a Staff Room would: the reads may record the shared store's own marks, the writes must change nothing at all.
  const replay = await world.host.replay();
  const hashes = { annex: replay.products.get(ANNEX)!.record.hash, annexC: replay.products.get(ANNEX_C)!.record.hash };
  await world.host.snapshot();
  const files = staffTree(env.root);
  const secrets = secretState(env.secrets);
  const calls = writingCalls(world, hashes);
  assert.ok(calls.length >= 20, `${calls.length} writing methods`);
  for (const [name, call] of calls) {
    assert.equal(await refusalOf(call), SHARED_PROJECT_REFUSAL, name);
    assert.deepEqual(staffTree(env.root), files, `${name} changed no file under .planning/staff`);
    assert.deepEqual(secretState(env.secrets), secrets, `${name} changed no secret`);
  }
  // The products still read the same after every refusal.
  assert.deepEqual((await world.host.replay()).products, replay.products);
  await world.host.close();
});

test('the refusal is one plain sentence with no em-dash that names Make a Single-Machine Copy, and SharedProjectError carries exactly it', () => {
  assert.doesNotMatch(SHARED_PROJECT_REFUSAL, /\u2014/);
  assert.match(SHARED_PROJECT_REFUSAL, /Make a Single-Machine Copy/);
  const error = new SharedProjectError();
  assert.equal(error.message, SHARED_PROJECT_REFUSAL);
  assert.equal(error.name, 'SharedProjectError');
  assert.doesNotMatch(SHARED_PROJECT_UNAVAILABLE, /\u2014/);
});

test('the reading methods still answer in a shared project, from the files the conversion wrote back: decisions, watches, wargame, events, calculator and LOGSTAT', async () => {
  const env = await cloneOf(await full(), 'reads');
  const read = async (host: StaffHost) => {
    const records = await host.logistics().records();
    return {
      pir: [...(await host.pirDecisions()).entries()],
      watches: [...(await host.watchDecisions()).entries()],
      wargame: await host.wargameEntries(),
      events: await host.events(),
      feeds: await host.feedEvents(),
      records: { verified: [...records.verified].sort(), records: [...records.records.entries()] },
      reports: await host.logistics().reports(),
      validation: await host.logistics().validationLog(),
      register: await host.pirRegister()
    };
  };
  const before = await read(worldOf(env).host);
  assert.equal(before.watches.length, 1);
  assert.equal(before.wargame.length, 1);
  assert.equal(before.records.verified.length, 1);
  assert.equal(before.reports.length, 1);
  assert.ok(before.events.length > 0);
  await migrate(env);
  const host = worldOf(env, true).host;
  assert.deepEqual(await read(host), before);
  await host.close();
});

test('a read never writes the event log of a shared project: an overdue RFI sends no event there, as it does on a single-machine project', async () => {
  const source = await full();
  const today = await cloneOf(source, 'overdue-today');
  const shared = await cloneOf(source, 'overdue-shared');
  await migrate(shared);
  const schema = registerSchema('rfi-tracker')!;
  const body = renderRegisterBody(schema, [{ id: 'RFI-7', from: 'j5', to: 'j2', question: 'Bridge class?', suspense: '2026-11-18T12:00:00.000Z', status: 'open' }]);
  const eventsFile = (root: string): string => path.join(root, LEDGER_DIR, EVENTS_FILE);
  for (const env of [today, shared]) {
    await mkdir(path.dirname(path.join(env.root, productPath('j3', 'rfi-tracker'))), { recursive: true });
    writeFileSync(path.join(env.root, productPath('j3', 'rfi-tracker')), body);
  }
  const todayBefore = readFileSync(eventsFile(today.root), 'utf8');
  const todayRead = await worldOf(today, true).host.registerRead(caller(today.root, 'liaison-coordinator', J3_TEAM), 'rfi-tracker');
  assert.ok(todayRead.ok);
  assert.match(readFileSync(eventsFile(today.root), 'utf8').slice(todayBefore.length), /staff\.rfi\.overdue/, 'a single-machine project records the overdue RFI');
  const sharedBefore = readFileSync(eventsFile(shared.root));
  const host = worldOf(shared, true).host;
  const sharedRead = await host.registerRead(caller(shared.root, 'liaison-coordinator', J3_TEAM), 'rfi-tracker');
  assert.ok(sharedRead.ok, sharedRead.ok ? '' : sharedRead.message);
  assert.deepEqual(readFileSync(eventsFile(shared.root)), sharedBefore, 'the shared project\'s event log is unchanged');
  await host.close();
});

test('a shared project this window cannot open shows no product and says so plainly, offers no ledger to use, and still refuses every write', async () => {
  const env = await cloneOf(await full(), 'unopened');
  await migrate(env);
  // Today's extension configuration: no replica storage given to the host.
  const plain = worldOf(env).host;
  const snapshot = await plain.snapshot();
  assert.equal(snapshot.registry.length, 0);
  assert.equal(snapshot.ledgerProblem, SHARED_PROJECT_UNAVAILABLE);
  assert.deepEqual(await plain.branchLedgerCheck(), { kind: 'broken', message: SHARED_PROJECT_REFUSAL });
  const files = staffTree(env.root);
  assert.equal(await refusalOf(() => plain.propose(caller(env.root), { product: ANNEX, kind: 'annex' })), SHARED_PROJECT_REFUSAL);
  assert.equal(await refusalOf(() => plain.setAsideLedger()), SHARED_PROJECT_REFUSAL);
  assert.deepEqual(staffTree(env.root), files);
  // Storage that holds no pin for this project (another install's folder copied here): the project refuses to open, and the reason is shown.
  const elsewhere = new StaffHost({ root: env.root, signer: async () => env.signer, keyStatus: async () => trusting(env.signer), headStore: memorySecrets(), replica: { globalStorageDir: mkdtempSync(path.join(tmpdir(), 'near-ai-hostmode-noglobal-')) } });
  const refused = await elsewhere.snapshot();
  assert.equal(refused.registry.length, 0);
  assert.match(refused.ledgerProblem ?? '', /^This project is shared, and its shared history cannot be opened here, so its staff products are not shown\. This project folder holds a shared staff project that this computer has not joined/);
  assert.deepEqual(staffTree(env.root), files, 'a refused open writes nothing');
});

test('a replica project file that cannot be checked (a stat error other than its absence) refuses every write with a sentence naming the error, never the shared-project sentence', async () => {
  const env = await cloneOf(await full(), 'stat-fails');
  // A symbolic link to itself: stat fails with ELOOP, which is neither "absent" nor "present".
  const file = path.join(env.root, ...REPLICA_PROJECT_FILE.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  symlinkSync(path.basename(file), file);
  const expected = sharedCheckFailedText('ELOOP');
  assert.match(expected, /ELOOP/);
  assert.notEqual(expected, SHARED_PROJECT_REFUSAL);
  assert.doesNotMatch(expected, /This project is shared/);
  assert.equal(expected.includes('—'), false);
  const host = worldOf(env).host;
  // Fails closed: the writes are refused, but with the stat failure, not the claim that the project is shared.
  assert.equal(await host.isSharedProject(), true);
  assert.equal(await host.sharedProjectRefusal(), expected);
  // The tree outside the replica folder: walking into it would meet the looping link itself.
  const outside = (): Array<[string, string]> => [...staffTree(env.root, 'replica')].sort();
  const files = outside();
  const proposed = await host.propose(caller(env.root), { product: ANNEX, kind: 'annex' });
  assert.deepEqual([proposed.ok, proposed.ok ? '' : proposed.message], [false, expected]);
  assert.deepEqual(await host.branchLedgerCheck(), { kind: 'broken', message: expected });
  await assert.rejects(() => host.setAsideLedger(), (error: unknown) => error instanceof SharedProjectError && error.message === expected && error.refusal === expected);
  const logistics = host.logistics();
  const report = await logistics.submitReport('jloc-chief', LOGSTAT);
  assert.deepEqual([report.ok, report.ok ? '' : report.message], [false, expected]);
  await assert.rejects(() => logistics.appendValidation([{ report: LOGSTAT.id, passed: true, findings: [], hash: 'b'.repeat(64), at: AT, by: 'logstat-analyst' } as unknown as ValidationLogEntry]),
    (error: unknown) => error instanceof SharedProjectError && error.message === expected);
  assert.deepEqual(outside(), files, 'nothing was written');
  assert.deepEqual(readdirSync(path.dirname(file)), [path.basename(file)], 'nothing was added beside the link');
  // An error code that is not a plain errno name is not echoed.
  assert.match(sharedCheckFailedText('bad code; rm -rf'), /failed with an unknown error\./);
  assert.match(sharedCheckFailedText(undefined), /failed with an unknown error\./);
});

// ---- 32-05: the host follows its shared project's store (D-09) ----------------------------------------------------------------------------------
// A window keeps its staff host across Start Again, run there or in another window. The host keeps the project it opened together with the store's
// identity (the store folder's device and inode numbers and the roster head this device's mark names) and opens the project again when it changed.

/** The project's replica store folder. */
const storeDirOf = (root: string): string => path.join(root, ...REPLICA_DIR.split('/'));

/** This device's file in the project's base stream: the file a rollback of this device's own history cuts. */
async function ownBaseFile(env: Env): Promise<string> {
  const project = (JSON.parse(readFileSync(path.join(env.root, ...REPLICA_PROJECT_FILE.split('/')), 'utf8')) as { anchor: { project: string } }).anchor.project;
  const { writer } = await ReplicaProject.localDevice(env.deps);
  return path.join(storeDirOf(env.root), 'streams', project, `${writer}.jsonl`);
}

/** Cuts the last whole line of a stream file and gives back the text it had, so a test can put it back. */
function cutLastLine(file: string): string {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  assert.ok(lines.length >= 3 && lines[lines.length - 1] === '', 'at least two whole lines');
  writeFileSync(file, `${lines.slice(0, -2).join('\n')}\n`);
  return text;
}

/** Counts ReplicaProject.open and keeps every project it opened, until restore(). */
function countOpens(): { readonly opened: ReplicaProject[]; count(): number; restore(): void } {
  const original = ReplicaProject.open.bind(ReplicaProject);
  const opened: ReplicaProject[] = [];
  const spy = mock.method(ReplicaProject, 'open', async (root: string, deps: ReplicaProjectDeps) => {
    const result = await original(root, deps);
    if (result instanceof ReplicaProject) opened.push(result);
    return result;
  });
  return { opened, count: () => spy.mock.callCount(), restore: () => spy.mock.restore() };
}

test('Start Again while the host holds a cached project: after another window sets the rolled-back store aside and starts it again, the host shows the products again without a reload', async () => {
  const env = await cloneOf(await full(), 'start-again-held');
  await migrate(env);
  const host = worldOf(env, true).host;
  try {
    const first = await host.replay();
    assert.equal(first.broken, undefined, first.broken?.reason);
    assert.deepEqual([...first.products.keys()].sort(), [...PRODUCTS].sort());
    // This device's base stream file loses its last line: the store is refused rolled-back, and the host says so.
    cutLastLine(await ownBaseFile(env));
    const refused = await host.replay();
    assert.ok(refused.broken, 'a rolled-back store reads as broken');
    assert.ok(refused.broken.reason.includes(STORE_REFUSALS['rolled-back']), refused.broken.reason);
    assert.equal(refused.products.size, 0);
    // Another window starts this computer's shared history again, without telling the host.
    const started = await ReplicaProject.startHistoryAgain(env.root, env.deps);
    assert.ok(started !== undefined && !isProjectRefused(started), started === undefined ? 'no shared project' : isProjectRefused(started) ? started.message : '');
    const again = await host.replay();
    assert.equal(again.broken, undefined, again.broken?.reason);
    assert.deepEqual(again.products, first.products, 'the products read again, as before the rollback');
  } finally {
    await host.close();
  }
});

test('a store folder replaced by a copy of itself (a new folder, the same content) is opened again by a host that was told nothing, and the replay is unchanged', async () => {
  const env = await cloneOf(await full(), 'store-copied');
  await migrate(env);
  const host = worldOf(env, true).host;
  const opens = countOpens();
  try {
    const first = await host.replay();
    assert.equal(first.broken, undefined, first.broken?.reason);
    assert.equal(opens.count(), 1);
    const dir = storeDirOf(env.root);
    const before = lstatSync(dir).ino;
    cpSync(dir, `${dir}.copy`, { recursive: true });
    renameSync(dir, `${dir}.old`);
    renameSync(`${dir}.copy`, dir);
    assert.notEqual(lstatSync(dir).ino, before, 'a new folder');
    const again = await host.replay();
    assert.equal(opens.count(), 2, 'the host opened the project again on the new folder');
    assert.equal(again.broken, undefined, again.broken?.reason);
    assert.deepEqual(again.products, first.products);
  } finally {
    opens.restore();
    await host.close();
  }
});

/** The roster head this device's mark names for the project's store (read, not verified). */
function markHead(env: Env): string | null {
  const text = env.secrets.values.get(markKey(storeDirOf(env.root)));
  return text === undefined ? null : (JSON.parse(text) as { signed: { payload: { rosterHead: string | null } } }).signed.payload.rosterHead;
}

test('five replays with nothing changed outside open the shared project once', async () => {
  const env = await cloneOf(await full(), 'open-once');
  await migrate(env);
  const host = worldOf(env, true).host;
  const opens = countOpens();
  try {
    const first = await host.replay();
    assert.equal(first.broken, undefined, first.broken?.reason);
    for (let read = 0; read < 4; read += 1) assert.deepEqual((await host.replay()).products, first.products);
    assert.equal(opens.count(), 1, 'one open for five reads');
  } finally {
    opens.restore();
    await host.close();
  }
});

test('a roster change another window makes: folded by the host\'s own read it moves the mark without a reopen; recorded by the other window it makes the next read open the project again', async () => {
  const env = await cloneOf(await full(), 'roster-change');
  await migrate(env);
  const { writer } = await ReplicaProject.localDevice(env.deps);
  const lead = `mbr-${writer.slice(0, 16)}`;
  // Another window of this install: a second project object on the same folder, opened before the count starts.
  const other = await ReplicaProject.open(env.root, env.deps);
  assert.ok(other instanceof ReplicaProject, isProjectRefused(other) ? other.message : 'no shared project');
  const host = worldOf(env, true).host;
  const opens = countOpens();
  try {
    const first = await host.replay();
    assert.equal(first.broken, undefined, first.broken?.reason);
    const headBefore = markHead(env);
    // The other window writes a roster change and does not fold it: the mark still names the old head.
    const renamed = await other.appendOwn('member.update', { member: lead, name: 'Exercise Lead North' });
    assert.ok('ok' in renamed, 'ok' in renamed ? '' : renamed.message);
    assert.equal(markHead(env), headBefore, 'the other window has not recorded the change');
    // The host's own read folds it and records the new head in the mark: that is not an outside change.
    assert.deepEqual((await host.replay()).products, first.products);
    assert.equal(markHead(env), renamed.hash, 'the host\'s read moved the mark\'s roster head');
    assert.deepEqual((await host.replay()).products, first.products);
    assert.equal(opens.count(), 1, 'the host\'s own mark write never counts as an outside change');
    // The other window writes again and folds it: the mark's roster head moves under the host, so its next read opens the project again.
    const again = await other.appendOwn('member.update', { member: lead, name: 'Exercise Lead South' });
    assert.ok('ok' in again, 'ok' in again ? '' : again.message);
    await other.state();
    assert.equal(markHead(env), again.hash);
    const after = await host.replay();
    assert.equal(after.broken, undefined, after.broken?.reason);
    assert.deepEqual(after.products, first.products);
    assert.equal(opens.count(), 2, 'opened again after the outside change');
    const { roster } = await opens.opened[1].state();
    assert.equal(memberAt(roster.members, lead, roster.positions.length - 1)?.name, 'Exercise Lead South', 'the project the host opened again shows the change');
    assert.equal(opens.count(), 2);
  } finally {
    opens.restore();
    await other.close();
    await host.close();
  }
});

test('invalidateShared closes the opened project once and the next read opens it again; on a host that opened nothing it is harmless', async () => {
  const unshared = await cloneOf(await full(), 'invalidate-unshared');
  const plain = worldOf(unshared, true).host;
  const before = await plain.replay();
  await plain.invalidateShared();
  await plain.invalidateShared();
  assert.deepEqual(await plain.replay(), before, 'a project that is not shared reads as before');
  assert.equal(existsSync(storeDirOf(unshared.root)), false, 'and no store was made');

  const env = await cloneOf(await full(), 'invalidate');
  await migrate(env);
  const host = worldOf(env, true).host;
  const opens = countOpens();
  try {
    const first = await host.replay();
    assert.equal(opens.count(), 1);
    const closed = mock.method(opens.opened[0], 'close');
    await host.invalidateShared();
    assert.equal(closed.mock.callCount(), 1, 'the old project is closed');
    await host.invalidateShared();
    assert.equal(closed.mock.callCount(), 1, 'a second call has nothing to close');
    const again = await host.replay();
    assert.equal(opens.count(), 2, 'the next read opens the project again');
    assert.deepEqual(again.products, first.products);
    assert.notEqual(opens.opened[1], opens.opened[0]);
  } finally {
    opens.restore();
    await host.close();
  }
});

test('a read whose fold is refused (the store rolled back under the host) drops the opened project, so the next read opens it again and reads it once the folder is put back', async () => {
  const env = await cloneOf(await full(), 'refused-drop');
  await migrate(env);
  const host = worldOf(env, true).host;
  const opens = countOpens();
  try {
    const first = await host.replay();
    assert.equal(first.broken, undefined, first.broken?.reason);
    assert.equal(opens.count(), 1);
    const file = await ownBaseFile(env);
    const whole = cutLastLine(file);
    const refused = await host.replay();
    assert.ok(refused.broken?.reason.includes(STORE_REFUSALS['rolled-back']), refused.broken?.reason);
    assert.equal(opens.count(), 1, 'the refusal came from the project the host held');
    const closed = mock.method(opens.opened[0], 'close');
    const still = await host.replay();
    assert.ok(still.broken?.reason.includes(STORE_REFUSALS['rolled-back']), still.broken?.reason);
    assert.equal(opens.count(), 2, 'the next read opened the project again instead of reusing the refused one');
    assert.ok(closed.mock.callCount() <= 1);
    // The newer copy of the file is put back: the next read opens the project and shows the products.
    writeFileSync(file, whole);
    const back = await host.replay();
    assert.equal(back.broken, undefined, back.broken?.reason);
    assert.deepEqual(back.products, first.products);
    assert.equal(opens.count(), 3);
  } finally {
    opens.restore();
    await host.close();
  }
});

test('close() goes through invalidateShared and ends the decode worker of the project the host opened', async () => {
  const env = await cloneOf(await full(), 'close-through');
  await migrate(env);
  const host = worldOf(env, true).host;
  const opens = countOpens();
  try {
    assert.equal((await host.replay()).broken, undefined);
    const project = opens.opened[0];
    // A project makes its decode worker on the first entry from outside; this one holds only its own, so it is given a stand-in worker to end.
    let ended = 0;
    const held = project as unknown as { ownDecoder?: { close(): Promise<void> } };
    held.ownDecoder = { close: async () => { ended += 1; } };
    const invalidate = mock.method(host, 'invalidateShared');
    const closed = mock.method(project, 'close');
    await host.close();
    assert.equal(invalidate.mock.callCount(), 1, 'close() goes through invalidateShared');
    assert.equal(closed.mock.callCount(), 1, 'the project is closed once');
    assert.equal(ended, 1, 'its decode worker ended');
    assert.equal(held.ownDecoder, undefined);
  } finally {
    opens.restore();
  }
});

// ---- 32-11 (D-23): the host shows every cell this device holds, each with its label, and nothing of a cell it does not hold -------------------------

const ESTIMATE = 'estimate';
// A canary phrase only the org/Internal product's text holds: no text a member below that cell reads may hold it.
const CANARY = 'Northwind ford crossing';
const ESTIMATE_BODY = `# Estimate\n\nThe ${CANARY} takes one battalion at a time.\n`;

/**
 * The lead converts a project with the concept of operations (org/Public, released), an estimate (org/Internal, draft, its text holding the canary)
 * and a calculator record, the lead's declared clearance org/Internal; the lead's open project as a label cell seat, and the cells by label.
 */
async function labelledLead(label: string): Promise<{ env: Env; lead: CellSeat; cells: { base: string; public: string; internal: string } }> {
  const env = await freshEnv(label);
  const world = worldOf(env);
  await writeBody(world.root, 'j5', CONOPS, CLEAN_BODY);
  const hash = hashIn(must(await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: CONOPS, kind: 'plan', label: 'org/Public' }, 'lead-planner'), 'propose'));
  must(await callTool(world, J5_TEAM, 'mcp__staff-products__verdict', { product: CONOPS, gate: 'guard', verdict: 'CLEARED', hash }, 'release-guard'), 'verdict');
  must(await callTool(world, J5_TEAM, 'mcp__staff-products__submit', { product: CONOPS, decisionFor: DECISION_ROLE }, 'lead-planner'), 'submit');
  for (const action of ['approve', 'release'] as const) {
    const decided = await world.host.decide(world.person(), { product: CONOPS, action, hash });
    assert.ok(decided.ok, decided.ok ? '' : decided.message);
  }
  await writeBody(world.root, 'j5', ESTIMATE, ESTIMATE_BODY);
  must(await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: ESTIMATE, kind: 'estimate', label: 'org/Internal' }, 'lead-planner'), 'propose estimate');
  await writeFactors(world.root, [FUEL]);
  must(await callLogistics(world, J4_TEAM, 'calc_run', FUEL_CALC, 'log-plans-officer'), 'calc_run');
  await migrate(env);
  const now = (): Date => new Date(NOW);
  const deps = { ...env.deps, cellOrder: cellOrderHook({ now }) };
  const opened = await ReplicaProject.open(env.root, deps);
  assert.ok(opened instanceof ReplicaProject, isProjectRefused(opened) ? opened.message : 'no shared project');
  const lead: CellSeat = { at: { root: env.root, global: env.global, secrets: env.secrets as CellSeat['at']['secrets'], deps, clock: { now: now() } }, p: opened, host: { project: opened, deps }, member: `mbr-${opened.deviceWriter.slice(0, 16)}`, writer: opened.deviceWriter, results: [] };
  const byLabel = new Map([...(await cellLabelTexts(opened))].map(([cell, text]) => [text, cell]));
  const cells = { base: opened.projectId, public: byLabel.get('org/Public') as string, internal: byLabel.get('org/Internal') as string };
  assert.ok(cells.public !== undefined && cells.internal !== undefined, `the lead holds both label cells (${[...byLabel.keys()].join(', ')})`);
  return { env, lead, cells };
}

/** The text of a host result: what a member reads, whether it is an answer or a refusal. */
const textOf = (result: StaffResult): string => (result.ok ? result.text : result.message);

/** Today's staff host over a label cell seat's folder, with the replica storage the extension gives it, signed by that install's device. */
async function seatHost(seat: CellSeat): Promise<StaffHost> {
  const { signer } = await ReplicaProject.localDevice(seat.at.deps);
  const clock = { now: Date.parse('2026-11-21T08:00:00.000Z') };
  return new StaffHost({ root: seat.at.root, signer: async () => signer, keyStatus: async () => trusting(signer), headStore: seat.at.secrets, now: () => { clock.now += 1000; return clock.now; }, replica: { globalStorageDir: seat.at.global } });
}

/** Every text a member reads of the host: the status of each product it lists, the list of every section, the replay, the registry and the queue. */
async function everyText(host: StaffHost, root: string): Promise<string[]> {
  const replay = await host.replay();
  const texts = [JSON.stringify([...replay.products]), JSON.stringify(replay.broken ?? null)];
  const listed = await host.list(caller(root), { all: true });
  texts.push(textOf(listed));
  for (const product of replay.products.keys()) texts.push(textOf(await host.status(caller(root), product)));
  const snapshot = await host.snapshot();
  texts.push(JSON.stringify(snapshot.registry), JSON.stringify(snapshot.decisions), JSON.stringify(snapshot.ledgerProblem ?? null));
  return texts;
}

test('not cleared: on the lead the shared read lists both products with their own labels; on a member cleared only for org/Public it lists the org/Public product alone and no text holds the other cell', async () => {
  const { env, lead, cells } = await labelledLead('not-cleared');
  const leadHost = worldOf(env, true).host;
  const m = await bringIn(lead, 'not-cleared-m', 'M. Member', orgClearance('Public'));
  await syncTo(lead, m, [cells.base, cells.public]);
  const memberHost = await seatHost(m);
  try {
    // The lead: every product of every cell it holds, each with its cell's label.
    const leadReplay = await leadHost.replay();
    assert.equal(leadReplay.broken, undefined, leadReplay.broken?.reason);
    assert.deepEqual([...leadReplay.products.keys()].sort(), [CONOPS, ESTIMATE].sort());
    const conopsStatus = await leadHost.status(caller(env.root), CONOPS);
    assert.ok(conopsStatus.ok && textOf(conopsStatus).includes('Label: org/Public.'), textOf(conopsStatus));
    const estimateStatus = await leadHost.status(caller(env.root), ESTIMATE);
    assert.ok(estimateStatus.ok && textOf(estimateStatus).includes('Label: org/Internal.'), textOf(estimateStatus));
    const leadList = await leadHost.list(caller(env.root), { all: true });
    assert.ok(textOf(leadList).includes(CONOPS) && textOf(leadList).includes(ESTIMATE), textOf(leadList));

    // The member: the org/Public product alone, with the lead's state and history.
    const memberReplay = await memberHost.replay();
    assert.equal(memberReplay.broken, undefined, memberReplay.broken?.reason);
    assert.deepEqual([...memberReplay.products.keys()], [CONOPS]);
    assert.deepEqual(withoutImported(memberReplay.products.get(CONOPS)), withoutImported(leadReplay.products.get(CONOPS)), 'the lead\'s state and history of the concept of operations');
    const memberStatus = await memberHost.status(caller(m.at.root), CONOPS);
    assert.ok(memberStatus.ok && textOf(memberStatus).includes('Label: org/Public.'), textOf(memberStatus));
    for (const text of await everyText(memberHost, m.at.root)) {
      for (const word of [ESTIMATE, 'org/Internal', CANARY]) assert.equal(text.includes(word), false, `a member's text holds "${word}": ${text.slice(0, 300)}`);
    }
  } finally {
    await leadHost.close();
    await memberHost.close();
    await lead.p.close();
  }
});

test('a member cleared for org/Internal holding both label cells but not the legacy cell: the shared read lists both products, each with its own label, as the lead sees them', async () => {
  const { env, lead, cells } = await labelledLead('both-cells');
  const leadHost = worldOf(env, true).host;
  const m = await bringIn(lead, 'both-cells-m', 'M. Member', orgClearance('Internal'));
  await syncTo(lead, m, [cells.base, cells.public, cells.internal]);
  const memberHost = await seatHost(m);
  try {
    const leadReplay = await leadHost.replay();
    const memberReplay = await memberHost.replay();
    assert.equal(memberReplay.broken, undefined, memberReplay.broken?.reason);
    assert.deepEqual([...memberReplay.products.keys()].sort(), [CONOPS, ESTIMATE].sort());
    for (const product of [CONOPS, ESTIMATE]) assert.deepEqual(withoutImported(memberReplay.products.get(product)), withoutImported(leadReplay.products.get(product)), product);
    const estimate = await memberHost.status(caller(m.at.root), ESTIMATE);
    assert.ok(estimate.ok && textOf(estimate).includes('Label: org/Internal.'), textOf(estimate));
  } finally {
    await leadHost.close();
    await memberHost.close();
    await lead.p.close();
  }
});
